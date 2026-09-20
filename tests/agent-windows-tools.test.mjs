import test from 'node:test';
import assert from 'node:assert/strict';
import {createWindowsTools} from '../desktop/agent/windows-tools.mjs';

const version=n=>n.toString(16).padStart(32,'0');
const token='a'.repeat(64);
const appId='app_'+'a'.repeat(24);
const failure=(code,details)=>Object.assign(new Error(code),{code,...(details?{details}:{})});
function snapshot(n,{selected=null,stateVersion=token,minimized=false,controls=[],active=true}={}){
  const win={id:'win_editor',title:'Draft — Editor',processName:'editor',minimized,maximized:false,active,stateVersion,
    keyboardLanguage:'Russian',availableKeyboardLanguages:['English','Russian']};
  return {version:version(n),windows:[win],elements:[{id:win.id,windowId:win.id,label:win.title,role:'Window',capabilities:['inspect','activate','minimize','maximize','restore','close','set_keyboard_language']},...controls],
    facts:{selectedWindowId:selected,surfaceStatus:selected?'available':'not_selected'},metadata:{provider:'synthetic UIA',truncated:false}};
}
function fixture({snapshots=[snapshot(1)],dispatch,apps=[],launch,choose,apiKeyResolver}={}){
  const calls=[];let reads=0;
  const desktop={bridge:{async request(method,args,signal){
    calls.push({method,args,signal});
    if(method==='observe')return structuredClone(snapshots[Math.min(reads++,snapshots.length-1)]);
    assert.equal(method,'execute');
    return dispatch?dispatch(args,signal):{operation:args.operation,targetId:args.targetId,verified:true,stateChanged:true,effectAttempted:true,evidence:'native_verified',after:snapshot(2,{minimized:true})};
  }},apps:{async list(signal){calls.push({method:'apps',signal});return apps;}},async launch(candidate,before,signal){
    calls.push({method:'launch',candidate,before,signal});
    return launch?launch(candidate,before,signal):{operation:'launch',targetId:candidate.targetId,verified:true,stateChanged:true,effectAttempted:true,evidence:'launched_process_window_observed',after:snapshot(3)};
  },async run(){assert.fail('Nested planner must never run');},...(apiKeyResolver?{apiKeyResolver}:{})};
  const descriptors=createWindowsTools({desktop,...(choose?{choose}:{})});
  const tools=Object.fromEntries(descriptors.map(item=>[item.name,item]));
  const call=(name,args={},options={})=>tools[name].execute(args,options);
  return {desktop,calls,tools,descriptors,call};
}
const chosen=(result,op='minimize')=>{
  const action=result.data.actions.find(item=>item.op===op);assert.ok(action,`missing ${op}`);
  return {snapshotVersion:result.data.snapshotVersion,actionId:action.id};
};

test('descriptors are plain JSON schemas plus local executors; scoped read exposes direct window actions',async()=>{
  const f=fixture();
  assert.equal(f.descriptors.length,5);
  for(const tool of f.descriptors){assert.equal(tool.parameters.additionalProperties,false);assert.equal(typeof tool.execute,'function');assert.ok(tool.title);assert.doesNotThrow(()=>JSON.stringify(tool.parameters));}
  const read=await f.call('windows_observe',{operation:'minimize'});
  assert.equal(read.ok,true);assert.equal(read.effectAttempted,false);assert.equal(read.data.windows[0].title,'Draft — Editor');
  assert.deepEqual(read.data.actions.map(item=>item.op),['minimize']);
  assert.equal(read.data.coverage.truncated,false);assert.equal(f.calls.length,1);
});

test('executes exactly the locally observed action with fresh native window token',async()=>{
  const f=fixture({snapshots:[snapshot(1),snapshot(4)]});
  const read=await f.call('windows_observe',{operation:'minimize'});
  const result=await f.call('windows_execute',chosen(read));
  assert.equal(result.ok,true);assert.equal(result.verified,true);assert.equal(result.status,'completed');
  assert.deepEqual(f.calls.find(item=>item.method==='execute').args,{targetId:'win_editor',operation:'minimize',expectedVersion:version(4),expectedWindowVersion:token});
  assert.equal(result.data.snapshotVersion,version(2));
  assert.equal(f.desktop.lastSnapshot.version,version(2));
});

test('changed target token returns a fresh observation and performs no effect',async()=>{
  const changed=snapshot(2,{stateVersion:'b'.repeat(64)}),f=fixture({snapshots:[snapshot(1),changed]});
  const read=await f.call('windows_observe',{operation:'close'});
  const result=await f.call('windows_execute',chosen(read,'close'));
  assert.equal(result.ok,false);assert.equal(result.status,'stale');assert.equal(result.effectAttempted,false);
  assert.equal(result.data.snapshotVersion,changed.version);assert.equal(f.calls.some(item=>item.method==='execute'),false);
});

test('a new observation replaces the action allowlist even when snapshot version is unchanged',async()=>{
  const f=fixture();
  const first=await f.call('windows_observe',{operation:'minimize'});
  await f.call('windows_observe',{operation:'close'});
  const rejected=await f.call('windows_execute',chosen(first));
  assert.equal(rejected.error,'WINDOWS_ACTION_NOT_OBSERVED');assert.equal(f.calls.some(item=>item.method==='execute'),false);
});

test('successful execution invalidates earlier snapshot/action IDs',async()=>{
  const f=fixture();const read=await f.call('windows_observe',{operation:'minimize'}),request=chosen(read);
  assert.equal((await f.call('windows_execute',request)).ok,true);
  const repeated=await f.call('windows_execute',request);
  assert.equal(repeated.status,'stale');assert.equal(f.calls.filter(item=>item.method==='execute').length,1);
});

test('inspect uses only a read with windowId and never a native mutation',async()=>{
  const first=snapshot(1),after=snapshot(2,{selected:'win_editor'}),f=fixture({snapshots:[first,first,after]});
  const read=await f.call('windows_observe');
  const result=await f.call('windows_execute',chosen(read,'inspect'));
  assert.equal(result.ok,true);assert.equal(result.effectAttempted,false);assert.equal(result.status,'observed');
  assert.deepEqual(f.calls.at(-1).args,{windowId:'win_editor'});assert.equal(f.calls.every(item=>item.method==='observe'),true);
});

test('layout scope reads the active window and supplies only native layout variants',async()=>{
  const selected=snapshot(2,{selected:'win_editor'}),f=fixture({snapshots:[snapshot(1),selected,selected]});
  const read=await f.call('windows_observe',{operation:'set_keyboard_language'});
  assert.deepEqual(f.calls[1].args,{windowId:'win_editor'});
  assert.equal(read.data.actions.length,2);assert.ok(read.data.actions.every(item=>item.op==='set_keyboard_language'));
  const action=read.data.actions.find(item=>item.title.includes('English'));
  await f.call('windows_execute',{snapshotVersion:read.data.snapshotVersion,actionId:action.id});
  assert.equal(f.calls.find(item=>item.method==='execute').args.language,'English');
});

test('control actions require full freshness even when the containing window token is unchanged',async()=>{
  const controls=[{id:'button_play',windowId:'win_editor',label:'Play',name:'Play',role:'Button',capabilities:['invoke']}];
  const f=fixture({snapshots:[snapshot(1,{selected:'win_editor',controls}),snapshot(2,{selected:'win_editor',controls})]});
  const read=await f.call('windows_observe'),result=await f.call('windows_execute',chosen(read,'invoke'));
  assert.equal(result.status,'stale');assert.equal(result.effectAttempted,false);assert.equal(f.calls.some(item=>item.method==='execute'),false);
});

test('arbitrary arguments and IDs cannot reach native execution',async()=>{
  const f=fixture();await f.call('windows_observe',{operation:'minimize'});
  for(const args of [{snapshotVersion:version(1),actionId:'invented'},{snapshotVersion:version(1),actionId:'invented',operation:'close'},{snapshotVersion:version(1),actionId:42}]){
    assert.equal((await f.call('windows_execute',args)).ok,false);
  }
  assert.equal((await f.call('windows_observe',{operation:'shell'})).ok,false);
  assert.equal((await f.call('windows_observe',{windowId:'win_editor',command:'generated shell'})).ok,false);
  assert.equal(f.calls.some(item=>item.method==='execute'),false);
});

test('high-impact controls and unrequested text replacement remain unavailable',async()=>{
  const controls=[{id:'delete_button',windowId:'win_editor',label:'Delete',name:'Delete',role:'Button',capabilities:['invoke']},
    {id:'edit',windowId:'win_editor',label:'Focused edit',role:'Edit',capabilities:['replace_text'],hasKeyboardFocus:true,isPassword:false,readOnly:false,enabled:true,offscreen:false,supportsValuePattern:true}];
  const f=fixture({snapshots:[snapshot(1,{selected:'win_editor',controls})]});
  const result=await f.call('windows_observe');
  assert.equal(result.data.actions.some(item=>item.targetId==='delete_button'||item.op==='replace_text'),false);
});

test('state change without a specific valid invoke receipt stops this run',async()=>{
  const f=fixture({dispatch:async args=>({operation:args.operation,targetId:args.targetId,verified:false,stateChanged:true,effectAttempted:true,evidence:'state_changed',after:snapshot(2)})});
  const read=await f.call('windows_observe',{operation:'minimize'}),request=chosen(read);
  const result=await f.call('windows_execute',request);
  assert.equal(result.ok,false);assert.equal(result.effectAttempted,true);assert.equal(result.status,'execution_uncertain');
  assert.equal((await f.call('windows_execute',request)).error,'WINDOWS_OUTCOME_UNKNOWN');
  assert.equal((await f.call('windows_observe')).error,'WINDOWS_OUTCOME_UNKNOWN');
  assert.equal(f.calls.filter(item=>item.method==='execute').length,1);
});

test('matched native invoke with observed change allows readback but never silent repeat',async()=>{
  const controls=[{id:'button_play',windowId:'win_editor',label:'Play',name:'Play',role:'Button',capabilities:['invoke']}];
  const first=snapshot(1,{selected:'win_editor',controls}),next=snapshot(2,{selected:'win_editor',controls});
  const f=fixture({snapshots:[first,first,next,next],dispatch:async args=>({operation:args.operation,targetId:args.targetId,verified:false,stateChanged:true,effectAttempted:true,evidence:'state_changed',after:next})});
  const read=await f.call('windows_observe'),request=chosen(read,'invoke');
  const result=await f.call('windows_execute',request);
  assert.equal(result.ok,true);assert.equal(result.verified,false);assert.equal(result.effectConfirmed,true);assert.equal(result.needsObservation,true);assert.equal(result.data.goalVerified,false);
  assert.equal((await f.call('windows_execute',request)).error,'WINDOWS_OBSERVATION_REQUIRED');
  const after=await f.call('windows_observe');assert.equal(after.ok,true);
  assert.equal((await f.call('windows_execute',chosen(after,'invoke'))).error,'WINDOWS_REPEATED_EFFECT');assert.equal(f.calls.filter(item=>item.method==='execute').length,1);
});

test('mismatched, missing, or invalid post-effect evidence is uncertain',async()=>{
  for(const invalid of [null,{operation:'close',targetId:'win_other',verified:true,stateChanged:true,effectAttempted:true,after:snapshot(2)},
    {operation:'minimize',targetId:'win_editor',verified:true,stateChanged:true,effectAttempted:true,after:null},
    {operation:'minimize',targetId:'win_editor',verified:true,stateChanged:true,effectAttempted:true,after:{version:'invalid'}}]){
    const f=fixture({dispatch:async()=>invalid});
    const read=await f.call('windows_observe',{operation:'minimize'}),result=await f.call('windows_execute',chosen(read));
    assert.equal(result.ok,false);assert.equal(result.status,'execution_uncertain');assert.equal(result.effectAttempted,true);
  }
});

test('native known pre-effect rejection permits a fresh read, while aborted dispatch is uncertain',async()=>{
  for(const error of [failure('STALE_SNAPSHOT'),failure('ELEMENT_IDENTITY_CHANGED',{effectAttempted:false}),failure('OPERATION_DENIED',{effectAttempted:false})]){
    const f=fixture({dispatch:async()=>{throw error;}});const read=await f.call('windows_observe',{operation:'minimize'});
    const result=await f.call('windows_execute',chosen(read));assert.equal(result.effectAttempted,false);
    assert.equal((await f.call('windows_observe')).ok,true);
  }
  const f=fixture({dispatch:async()=>{throw failure('ABORTED');}}),read=await f.call('windows_observe',{operation:'minimize'});
  const result=await f.call('windows_execute',chosen(read));
  assert.equal(result.status,'execution_uncertain');assert.equal(result.effectAttempted,true);
});

test('pre-aborted calls do not start observation or execution',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  const result=await f.call('windows_observe',{}, {signal:controller.signal});
  assert.equal(result.error,'ABORTED');assert.equal(result.effectAttempted,false);assert.equal(f.calls.length,0);
});

test('verified receipt remains evidence if cancellation arrives after native completion',async()=>{
  const controller=new AbortController();
  const f=fixture({dispatch:async args=>{controller.abort();return {operation:args.operation,targetId:args.targetId,verified:true,stateChanged:true,effectAttempted:true,evidence:'verified',after:snapshot(2)};}});
  const read=await f.call('windows_observe',{operation:'minimize'});
  const result=await f.call('windows_execute',chosen(read),{signal:controller.signal});
  assert.equal(result.verified,true);assert.equal(result.ok,true);
});

test('application search exposes only bounded catalog fields and launch uses cached ID once',async()=>{
  const f=fixture({apps:[{id:appId,name:'Editor',processName:'other-editor',exe:'C:\\private\\editor.exe'},{id:'bad',name:'Bad',processName:'bad'}]});
  assert.equal((await f.call('windows_app_launch',{appId})).error,'APP_NOT_OBSERVED');
  const found=await f.call('windows_apps_search',{query:'editor',limit:1});
  assert.deepEqual(found.data.apps,[{id:appId,title:'Editor',processName:'other-editor'}]);assert.equal(JSON.stringify(found).includes('private'),false);
  const result=await f.call('windows_app_launch',{appId});assert.equal(result.verified,true);assert.equal(result.status,'completed');
  assert.equal(f.calls.find(item=>item.method==='launch').candidate.targetId,appId);
  assert.equal((await f.call('windows_app_launch',{appId})).error,'APP_NOT_OBSERVED');
  assert.equal(f.calls.filter(item=>item.method==='launch').length,1);
});

test('new app search replaces previous exposure and rejected launch is distinguished from uncertain launch',async()=>{
  const apps=[{id:appId,name:'Editor',processName:'other-editor'}];
  const f=fixture({apps});await f.call('windows_apps_search');await f.call('windows_apps_search',{query:'not present'});
  assert.equal((await f.call('windows_app_launch',{appId})).error,'APP_NOT_OBSERVED');
  for(const [error,uncertain] of [[failure('APP_TARGET_CHANGED'),false],[failure('APP_TARGET_CHANGED',{effectAttempted:true}),true],[failure('ABORTED'),true]]){
    const ctx=fixture({apps,launch:async()=>{throw error;}});await ctx.call('windows_apps_search');
    const result=await ctx.call('windows_app_launch',{appId});assert.equal(result.effectAttempted,uncertain);assert.equal(result.status,uncertain?'execution_uncertain':'failed');
  }
});

test('launch observes existing application and returns activation guidance without spawning',async()=>{
  const f=fixture({apps:[{id:appId,name:'Editor',processName:'EDITOR'}],snapshots:[snapshot(1,{active:false,minimized:true})]});
  await f.call('windows_apps_search');
  const result=await f.call('windows_app_launch',{appId});
  assert.equal(result.status,'already_open');assert.equal(result.verified,false);assert.equal(result.effectAttempted,false);
  assert.equal(result.data.windows[0].id,'win_editor');assert.equal(result.data.nextTool,'windows_observe');
  assert.equal(f.calls.some(call=>call.method==='launch'),false);
  assert.equal((await f.call('windows_app_launch',{appId})).error,'APP_NOT_OBSERVED');
});

test('parallel tool calls cannot share a mutable observation generation',async()=>{
  let finish;
  const firstSnapshot=new Promise(resolve=>{finish=resolve;});
  const desktop={bridge:{request:async()=>firstSnapshot}};
  const tools=createWindowsTools({desktop}),read=tools.find(item=>item.name==='windows_observe');
  const first=read.execute({});
  assert.equal((await read.execute({})).error,'WINDOWS_TOOL_BUSY');
  finish(snapshot(1));assert.equal((await first).ok,true);
});

test('optional Jev selector sees cached candidates and returns audited advice without native effects',async()=>{
  let received;
  const f=fixture({apiKeyResolver:async()=>'synthetic-private-key',choose:async(input,{apiKey,onResponse,signal})=>{
    received=input;assert.equal(apiKey,'synthetic-private-key');assert.equal(signal.aborted,false);
    const action=input.candidates[0];
    onResponse({model:'jev-test',answers:{next_action:{choice:action.id}},usage:{input_tokens:10,output_tokens:4}});
    return {choice:action.id,actionId:action.id,probability:.95,confidence:.94,model:'jev-test',latencyMs:2};
  }});
  const read=await f.call('windows_observe',{operation:'minimize'});
  const result=await f.call('windows_choose',{goal:'Сверни редактор'});
  assert.equal(result.ok,true);assert.equal(result.verified,false);assert.equal(result.effectAttempted,false);assert.equal(result.status,'selected');
  assert.equal(result.data.actionId,read.data.actions[0].id);assert.equal(result.data.action.op,'minimize');
  assert.equal(result.data.probability,.95);assert.equal(result.data.confidence,.94);assert.equal(result.data.response.model,'jev-test');
  assert.deepEqual(received.completed,[]);assert.equal(received.phase,'controls');assert.equal(received.command,'Сверни редактор');
  assert.equal(JSON.stringify(result).includes('synthetic-private-key'),false);assert.equal(f.calls.length,1);
  assert.equal((await f.call('windows_execute',chosen(read))).ok,true);
});

test('Jev unavailable or missing observation is optional and does not disable direct tools',async()=>{
  const f=fixture();
  assert.equal((await f.call('windows_choose',{goal:'Сверни редактор'})).error,'WINDOWS_OBSERVATION_REQUIRED');
  const read=await f.call('windows_observe',{operation:'minimize'});
  const result=await f.call('windows_choose',{goal:'Сверни редактор'});
  assert.equal(result.status,'unavailable');assert.equal(result.error,'TYPESAFE_KEY_MISSING');assert.equal(result.effectAttempted,false);
  assert.equal((await f.call('windows_execute',chosen(read))).ok,true);
});

test('Jev suggestions do not override live freshness or admit unknown candidate IDs',async()=>{
  const f=fixture({apiKeyResolver:async()=>'synthetic',snapshots:[snapshot(1),snapshot(2,{stateVersion:'b'.repeat(64)})],choose:async input=>({choice:input.candidates[0].id,actionId:input.candidates[0].id,probability:.99,confidence:.99})});
  await f.call('windows_observe',{operation:'close'});
  const choice=await f.call('windows_choose',{goal:'Закрой редактор'});
  const result=await f.call('windows_execute',{snapshotVersion:choice.data.snapshotVersion,actionId:choice.data.actionId});
  assert.equal(result.status,'stale');assert.equal(f.calls.some(item=>item.method==='execute'),false);
  const invalid=fixture({apiKeyResolver:async()=>'synthetic',choose:async()=>({choice:'invented',actionId:'invented',probability:.99,confidence:.99})});
  await invalid.call('windows_observe',{operation:'close'});
  assert.equal((await invalid.call('windows_choose',{goal:'Закрой редактор'})).error,'WINDOWS_CHOICE_RESPONSE');
});

test('low-confidence or stop advice contains no executable selection',async()=>{
  for(const choice of ['done','unsupported','no_request']){
    const f=fixture({apiKeyResolver:async()=>'synthetic',choose:async()=>({choice,actionId:null,probability:.9,confidence:.9})});
    await f.call('windows_observe',{operation:'minimize'});
    const result=await f.call('windows_choose',{goal:'Сверни редактор'});
    assert.equal(result.ok,true);assert.equal(result.data.action,null);assert.equal(result.data.actionId,null);assert.equal(f.calls.length,1);
  }
});
