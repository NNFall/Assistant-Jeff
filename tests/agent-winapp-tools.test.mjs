import test from 'node:test';
import assert from 'node:assert/strict';
import {createWinAppTools} from '../desktop/agent/winapp-tools.mjs';

// Field names captured in work/winapp-runtime/evidence.json from the actual
// v0.6.1 CLI; values below are entirely synthetic, never personal desktop data.
const win={hwnd:12345,processId:765,processName:'JeffFixture',title:'Synthetic fixture',label:'main',width:800,height:600,ownerHwnd:0,className:'FixtureWindow',isForeground:false};
const element=(overrides={})=>({type:'Button',name:'Open panel',automationId:'PanelButton',className:'Button',isEnabled:true,isOffscreen:false,x:10,y:10,width:120,height:30,selector:'btn-panel-a1b2',isInvokable:true,...overrides});
const nativeError=(code,effectAttempted)=>Object.assign(new Error('PRIVATE native error body'),{code,...(effectAttempted===undefined?{}:{effectAttempted})});
function fixture({elements=[element()],before={},after={},result,failAt,rawAt,windowAfter,windowOverride,canonicalSelector,searchEmpty=false}={}){
  const calls=[];let mutations=0;
  const runner=async(executable,args,options)=>{
    calls.push({executable,args,options});const verb=args[1];
    assert.equal(args[0],'ui');assert.ok(args.includes('--json'));
    assert.ok(['list-windows','inspect','search','get-property','invoke','scroll'].includes(verb));
    if(failAt?.verb===verb)throw failAt.error;
    if(rawAt?.verb===verb)return rawAt.result;
    let body,exitCode=0;
    if(verb==='list-windows')body=[mutations&&windowAfter?windowAfter:{...win,...windowOverride}];
    if(verb==='inspect')body={depth:8,interactive:false,hideDisabled:false,hideOffscreen:false,windows:[{hwnd:win.hwnd,title:win.title,className:win.className,elementCount:elements.length,elements}]};
    if(verb==='search'){body={matchCount:searchEmpty?0:elements.length,hasMore:false,matches:searchEmpty?[]:elements};exitCode=searchEmpty?1:0;}
    if(verb==='get-property'){
      const selected=elements.find(item=>item.selector===args.at(-1))??elements[0];
      body={elementId:canonicalSelector??selected.selector,properties:{Name:selected.name,AutomationId:selected.automationId??null,ControlType:selected.type,ClassName:selected.className,
        IsEnabled:'True',IsOffscreen:'False',Value:'PRIVATE FIELD CONTENT',IsPassword:'True',
        ...(selected.toggleState?{ToggleState:selected.toggleState==='off'?'Off':'On'}:{}),
        ...(selected.expandState?{ExpandCollapseState:'Collapsed'}:{}),
        ...(selected.type==='TabItem'?{IsSelected:'False'}:{}),
        ...(selected.scrollDir?{ScrollHorizontalPercent:'0',ScrollVerticalPercent:'20',HorizontallyScrollable:'False',VerticallyScrollable:'True'}:{}),
        ...before,...(mutations?after:{})}};
    }
    if(verb==='invoke'||verb==='scroll'){
      mutations++;
      const target=canonicalSelector??args.at(-1);
      const pattern=elements[0].toggleState?'TogglePattern':elements[0].type==='TabItem'?'SelectionItemPattern':elements[0].expandState?'ExpandCollapsePattern':'InvokePattern';
      body=result??(verb==='invoke'?{elementId:target,hwnd:win.hwnd,pattern}:{elementId:target,hwnd:win.hwnd,
        ...(args.includes('--to')?{to:args[args.indexOf('--to')+1]}:{direction:args[args.indexOf('--direction')+1]})});
    }
    return {exitCode,stdout:JSON.stringify(body)};
  };
  const descriptors=createWinAppTools({executable:'C:\\fixture\\winapp.exe',runner});
  const tools=Object.fromEntries(descriptors.map(item=>[item.name,item]));
  const call=(name,args={},options={})=>tools[name].execute(args,options);
  const observe=async()=>{const inventory=await call('winapp_observe');assert.equal(inventory.ok,true);return call('winapp_observe',{windowId:inventory.data.windows[0].id});};
  return {calls,descriptors,tools,call,observe,mutations:()=>mutations};
}
function action(read,op,argument){
  assert.equal(read.ok,true,read.error);
  const selected=read.data.actions.find(item=>item.op===op&&(!argument||item.title.endsWith(argument)));
  assert.ok(selected,`missing ${op} ${argument??''}`);
  return {snapshotVersion:read.data.snapshotVersion,actionId:selected.id};
}

test('observations expose opaque local IDs and the real nested v0.6.1 schema',async()=>{
  const f=fixture({elements:[element({selector:'txt-heading-b2c3',type:'Text',name:'Current panel',isInvokable:false}),element()]});
  const read=await f.observe();
  assert.equal(read.ok,true);assert.equal(read.effectAttempted,false);assert.equal(read.data.elements.length,2);
  assert.ok(read.data.elements.every(item=>/^wa_e_[a-f0-9]{24}$/.test(item.id)));
  assert.equal(JSON.stringify(read).includes('btn-panel-a1b2'),false);assert.equal(JSON.stringify(read).includes('12345'),false);
  for(const descriptor of f.descriptors){assert.equal(descriptor.parameters.additionalProperties,false);assert.equal(typeof descriptor.execute,'function');}
  assert.deepEqual(f.calls.at(-1).args,['ui','inspect','-w','12345','--depth','8','--json']);
});

test('password and all editable values are omitted before model output',async()=>{
  const f=fixture({elements:[element({type:'Edit',name:'PRIVATE edit content',value:'SECRET VALUE',children:[element({type:'Text',name:'PRIVATE nested password'})]}),
    element({name:'Password',value:'PRIVATE password'}),element({type:'Text',isInvokable:false,name:'Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ'}),
    element({selector:'doc-view-a1b2',type:'Document',name:'Document heading',value:'PRIVATE DOCUMENT VALUE',isInvokable:false})]});
  const read=await f.observe(),json=JSON.stringify(read);
  assert.equal(read.data.coverage.omittedSensitiveOrEditable,2);assert.equal(json.includes('PRIVATE'),false);assert.equal(json.includes('SECRET VALUE'),false);
  assert.match(json,/\[REDACTED\]/);assert.equal(json.includes('Document heading'),true);
});

test('search is a bounded read and accepts the no-match exit code envelope',async()=>{
  const f=fixture({searchEmpty:true});const inventory=await f.call('winapp_observe');
  const read=await f.call('winapp_search',{windowId:inventory.data.windows[0].id,query:'--generated-selector',limit:12});
  assert.equal(read.ok,true);assert.equal(read.data.elements.length,0);
  assert.deepEqual(f.calls.at(-1).args,['ui','search','-w','12345','--max','12','--json','--','--generated-selector']);
});

test('the model cannot pass raw HWND, selectors, executable arguments or text',async()=>{
  const f=fixture();
  assert.equal((await f.call('winapp_observe',{windowId:'12345'})).ok,false);
  assert.equal((await f.call('winapp_search',{windowId:'wa_w_unknown',query:'Button'})).error,'WINAPP_WINDOW_NOT_OBSERVED');
  const read=await f.observe(),request=action(read,'invoke');
  assert.equal((await f.call('winapp_execute',{...request,value:'powershell -Command anything'})).error,'INVALID_TOOL_ARGUMENTS');
  assert.equal((await f.call('winapp_execute',{...request,selector:'arbitrary'})).error,'INVALID_TOOL_ARGUMENTS');assert.equal(f.mutations(),0);
});

test('typing and destructive/execution controls are absent from action candidates',async()=>{
  const f=fixture({elements:[element({name:'Send'}),element({selector:'run-a1b2',name:'Run command'}),element({selector:'safe-a1b2',name:'Show panel'}),
    element({selector:'terminal-a1b2',name:'Terminal',children:[element({selector:'inside-a1b2',name:'Open panel'})]})]});
  const read=await f.observe();
  assert.equal(read.data.actions.length,1);assert.match(read.data.actions[0].title,/Show panel/);
  assert.equal(f.descriptors.some(tool=>/type|key|clip|shell/.test(tool.name)),false);
});

test('selection is verified from IsSelected and matched native pattern, not exit code',async()=>{
  const f=fixture({elements:[element({type:'TabItem',selector:'TabHome',name:'Home',automationId:'TabHome',className:'Tab'})],canonicalSelector:'tab-home-b1c2',after:{IsSelected:'True'}});
  const read=await f.observe(),result=await f.call('winapp_execute',action(read,'select'));
  assert.equal(result.ok,true);assert.equal(result.verified,true);assert.equal(result.data.receipt.after.selected,true);
  assert.equal(f.calls.find(item=>item.args[1]==='invoke').args.at(-1),'tab-home-b1c2');
  assert.equal(JSON.stringify(result).includes('PRIVATE FIELD CONTENT'),false);
});

test('toggle and expand require matching post-state and exact pattern receipt',async()=>{
  for(const [item,op,after] of [[element({type:'CheckBox',toggleState:'off'}),'toggle',{ToggleState:'On'}],
    [element({type:'ComboBox',expandState:'collapsed'}),'expand',{ExpandCollapseState:'Expanded'}]]){
    const f=fixture({elements:[item],after});const read=await f.observe(),result=await f.call('winapp_execute',action(read,op));
    assert.equal(result.ok,true);assert.equal(result.verified,true);assert.equal(result.effectAttempted,true);assert.equal(f.mutations(),1);
  }
});

test('scroll uses only ScrollPattern direction and proves actual scroll percentage movement',async()=>{
  const f=fixture({elements:[element({type:'Pane',name:'Content',isInvokable:false,scrollDir:'v'})],after:{ScrollVerticalPercent:'40'}});
  const read=await f.observe(),result=await f.call('winapp_execute',action(read,'scroll','down'));
  assert.equal(result.verified,true);assert.equal(result.data.receipt.before.vertical,20);assert.equal(result.data.receipt.after.vertical,40);
  const args=f.calls.find(item=>item.args[1]==='scroll').args;
  assert.deepEqual(args,['ui','scroll','-w','12345','--json','--direction','down','--','btn-panel-a1b2']);assert.equal(args.includes('--wheel'),false);
});

test('an already selected item or scroll boundary requires no mutation',async()=>{
  const f=fixture({elements:[element({type:'TabItem'})],before:{IsSelected:'True'}}),read=await f.observe();
  const result=await f.call('winapp_execute',action(read,'select'));
  assert.equal(result.ok,true);assert.equal(result.verified,true);assert.equal(result.effectAttempted,false);assert.equal(f.mutations(),0);
});

test('a changed target or known state refuses dispatch and requires re-observation',async()=>{
  for(const before of [{Name:'Changed label'},{AutomationId:'Changed identity'},{IsEnabled:'False'},{ToggleState:'On'}]){
    const f=fixture({elements:[element({type:'CheckBox',toggleState:'off'})],before});const read=await f.observe();
    const result=await f.call('winapp_execute',action(read,'toggle'));
    assert.equal(result.status,'stale');assert.equal(result.effectAttempted,false);assert.equal(f.mutations(),0);
  }
});

test('fresh observations invalidate old action IDs and unknown IDs never reach the CLI',async()=>{
  const f=fixture(),read=await f.observe();await f.call('winapp_observe');
  assert.equal((await f.call('winapp_execute',action(read,'invoke'))).status,'stale');
  const fresh=await f.observe();assert.equal((await f.call('winapp_execute',{snapshotVersion:fresh.data.snapshotVersion,actionId:'invented'})).error,'WINAPP_ACTION_NOT_OBSERVED');
  assert.equal(f.mutations(),0);
});

test('generic invoke is confirmed dispatch only and requires a read before any next effect',async()=>{
  const f=fixture(),read=await f.observe(),request=action(read,'invoke');
  const result=await f.call('winapp_execute',request);
  assert.equal(result.ok,true);assert.equal(result.verified,false);assert.equal(result.effectConfirmed,true);assert.equal(result.needsObservation,true);
  assert.equal(result.evidence,'invoke_dispatched');assert.equal(result.data.goalVerified,false);
  assert.equal((await f.call('winapp_execute',request)).error,'WINAPP_OBSERVATION_REQUIRED');
  const next=await f.observe();assert.equal((await f.call('winapp_execute',action(next,'invoke'))).error,'WINAPP_REPEATED_EFFECT');assert.equal(f.mutations(),1);
});

test('misdirected receipt cannot become confirmed dispatch even with successful exit status',async()=>{
  for(const result of [{elementId:'other',hwnd:12345,pattern:'InvokePattern'},{elementId:'btn-panel-a1b2',hwnd:98765,pattern:'InvokePattern'},
    {elementId:'btn-panel-a1b2',hwnd:12345,pattern:'TogglePattern'}]){
    const f=fixture({result}),read=await f.observe(),receipt=await f.call('winapp_execute',action(read,'invoke'));
    assert.equal(receipt.status,'execution_uncertain');assert.equal(receipt.effectAttempted,true);assert.equal(receipt.effectConfirmed,undefined);
    assert.equal((await f.call('winapp_observe')).error,'WINAPP_OUTCOME_UNKNOWN');
  }
});

test('unchanged state after effect and post-read failure are uncertain and cannot retry',async()=>{
  const f=fixture({elements:[element({type:'CheckBox',toggleState:'off'})]});const read=await f.observe();
  const result=await f.call('winapp_execute',action(read,'toggle'));
  assert.equal(result.ok,false);assert.equal(result.verified,false);assert.equal(result.status,'execution_uncertain');assert.equal(result.effectAttempted,true);
  assert.equal((await f.call('winapp_observe')).error,'WINAPP_OUTCOME_UNKNOWN');assert.equal(f.mutations(),1);
});

test('effect timeout and cancellation remain uncertain, while pre-aborted reads do nothing',async()=>{
  for(const error of [nativeError('WINAPP_TIMEOUT',true),nativeError('ABORTED',true)]){
    const f=fixture({failAt:{verb:'invoke',error}}),read=await f.observe();const result=await f.call('winapp_execute',action(read,'invoke'));
    assert.equal(result.effectAttempted,true);assert.equal(result.status,'execution_uncertain');assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
  }
  const f=fixture(),controller=new AbortController();controller.abort();
  assert.equal((await f.call('winapp_observe',{}, {signal:controller.signal})).error,'ABORTED');assert.equal(f.calls.length,0);
});

test('bounded parsing rejects oversized, malformed and incompatible CLI outputs',async()=>{
  for(const result of [{exitCode:0,stdout:'x'.repeat(1024*1024+1)},{exitCode:0,stdout:'not json'},
    {exitCode:0,stdout:JSON.stringify({elements:[]})}]){
    const f=fixture({rawAt:{verb:'inspect',result}});const read=await f.observe();assert.equal(read.ok,false);assert.equal(read.effectAttempted,false);
  }
});

test('observation coverage reports truncation and caps actions',async()=>{
  const elements=Array.from({length:150},(_,i)=>element({selector:`btn-item-${i}`,name:`Item ${i}`,automationId:`Item${i}`,hasMoreChildren:i===0}));
  const f=fixture({elements}),read=await f.observe();
  assert.equal(read.data.elements.length,120);assert.equal(read.data.actions.length,96);assert.equal(read.data.coverage.truncated,true);assert.equal(read.data.coverage.omittedActions,24);
});

test('protected assistant, credential and shell windows cannot be inspected or searched',async()=>{
  for(const windowOverride of [{processName:'Codex',title:'PRIVATE current conversation'},{processName:'ChatGPT'},{processName:'Assistant Jeff'},
    {processName:'Bitwarden'},{processName:'KeePassXC'},{processName:'CredentialUIBroker'},{processName:'Consent'},
    {processName:'WindowsTerminal'},{processName:'chrome',title:'Sign in - Account'}]){
    const f=fixture({windowOverride}),inventory=await f.call('winapp_observe'),id=inventory.data.windows[0].id;
    assert.equal(inventory.data.windows[0].restricted,true);assert.equal(inventory.data.windows[0].title,'Защищённое окно');
    assert.equal((await f.call('winapp_observe',{windowId:id})).error,'WINAPP_TARGET_DENIED');
    assert.equal((await f.call('winapp_search',{windowId:id,query:'Button'})).error,'WINAPP_TARGET_DENIED');
    assert.equal(f.calls.every(item=>item.args[1]==='list-windows'),true);
  }
});

test('ordinary settings window is not globally blocked, but security surfaces are',async()=>{
  const f=fixture({windowOverride:{processName:'SystemSettings',title:'Settings'}}),inventory=await f.call('winapp_observe');
  assert.equal(inventory.data.windows[0].restricted,undefined);
  assert.equal((await f.call('winapp_observe',{windowId:inventory.data.windows[0].id})).ok,true);
});

test('mutation requires the canonical CLI runtime-id slug, not a plain name selector',async()=>{
  const f=fixture({canonicalSelector:'PanelButton'}),read=await f.observe();
  assert.equal((await f.call('winapp_execute',action(read,'invoke'))).error,'WINAPP_TARGET_IDENTITY_UNAVAILABLE');assert.equal(f.mutations(),0);
});
