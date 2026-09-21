import test from 'node:test';
import assert from 'node:assert/strict';
import {createJevDesktopSession} from '../desktop/agent/jev-desktop-session.mjs';
import {JevCommands} from '../desktop/agent/jev-commands.mjs';

const token='a'.repeat(64),deviceId='audio_'+'a'.repeat(24);
function fixture({tabs=false,audioDefault=true,regions=false}={}){
  let selected=null,changed=false;const calls=[];
  const snapshot=()=>{
    const window={id:'win_taskbar',title:'Панель задач',processName:'explorer',minimized:false,maximized:false,active:false,stateVersion:token,surfaceKind:'taskbar'};
    const popup={...window,id:'win_popup',title:'Быстрые настройки',surfaceKind:'shell_popup'},app={...window,id:'win_other',title:'Блокнот',surfaceKind:'application'};
    return {version:(changed?'b':'a').repeat(32),windows:regions?[window,popup,app]:[window],elements:[{id:window.id,windowId:window.id,label:window.title,role:'Window',capabilities:['inspect']},
      ...(regions?[popup,app].map(w=>({id:w.id,windowId:w.id,label:w.title,role:'Window',capabilities:['inspect']})):[]),
      ...(selected?[{id:'el_audio',windowId:window.id,label:tabs?'ВКонтакте':'Звук — Динамики',name:tabs?'ВКонтакте':'Звук — Динамики',role:tabs?'TabItem':'Button',capabilities:[tabs?'select':'invoke'],...(tabs?{order:1,orderIsPartial:true}:{}),...(regions?{className:'SystemTray.OmniButtonCenter',automationId:'SystemTrayIcon'}:{}),enabled:true,offscreen:false}]:[]),
      ...(selected&&regions?[{id:'el_app',windowId:window.id,label:'Проводник',name:'Проводник',role:'Button',capabilities:['invoke'],className:'Taskbar.TaskListButtonAutomationPeer',automationId:'Appid: Explorer',enabled:true,offscreen:false}]:[])],
      facts:{selectedWindowId:selected,surfaceStatus:selected?'available':'not_selected'},metadata:{provider:'test',truncated:tabs,tabOrderPartial:tabs}};
  };
  const desktop={bridge:{async request(method,args){calls.push({method,args});
    if(method==='observe'){if(Object.hasOwn(args,'windowId'))selected=args.windowId;return snapshot();}
    if(method==='audio_outputs_get')return {provider:'windows_coreaudio',verified:true,effectAttempted:false,devices:[{id:deviceId,name:'SberBox Time',isDefault:audioDefault}],defaultDeviceId:audioDefault?deviceId:null};
    assert.equal(method,'execute');const before=snapshot();changed=true;return {operation:args.operation,targetId:args.targetId,verified:false,stateChanged:true,effectAttempted:true,evidence:'state_changed',before,after:snapshot()};
  }},apps:{async list(){return [];}}};
  return {desktop,calls};
}

function applicationFixture({initialMinimized=true}={}){
  let selected=null,minimized=initialMinimized,generation=1;const calls=[];
  const app={id:'app_'+'a'.repeat(24),name:'Chrome',processName:'chrome'};
  const snapshot=()=>({version:generation.toString(16).padStart(32,'0'),windows:[{id:'win_chrome',title:'Chrome',processName:'chrome',minimized,maximized:false,active:false,stateVersion:generation.toString(16).padStart(64,'0')}],
    elements:[{id:'win_chrome',windowId:'win_chrome',label:'Chrome',role:'Window',capabilities:['inspect','activate','minimize','restore']}],facts:{selectedWindowId:selected},metadata:{provider:'synthetic'}});
  const desktop={apps:{list:async()=>[app]},bridge:{async request(method,args){
    calls.push({method,args});
    if(method==='audio_outputs_get')return {provider:'windows_coreaudio',verified:true,effectAttempted:false,devices:[],defaultDeviceId:null};
    if(method==='observe'){if(Object.hasOwn(args,'windowId'))selected=args.windowId;return snapshot();}
    assert.equal(method,'execute');minimized=args.operation==='minimize';generation++;
    return {operation:args.operation,targetId:args.targetId,verified:true,stateChanged:true,effectAttempted:true,evidence:'native_verified',after:snapshot()};
  }}};
  return {desktop,calls,snapshot};
}

const memoryJournal=async()=>({runId:'synthetic-session-test',events:[],async record(phase,data){const event={phase,...data};this.events.push(event);return event;},async flush(){},async finish(){}});
const decision=id=>({choice:id,actionId:id==='done'?null:id,probability:0.98,confidence:0.97});

test('already running minimized app is observation progress, not a satisfied launch postcondition',async()=>{
  const f=applicationFixture(),inputs=[];
  const commands=new JevCommands({journalFactory:memoryJournal,apiKeyResolver:async()=>'synthetic-test-key',createSession:({command})=>createJevDesktopSession({desktop:f.desktop,command}),
    choose:async input=>{
      inputs.push(structuredClone(input));
      const id=input.recentSteps.length===0?input.candidates.find(c=>c.label.includes('установленные приложения')).id
        :input.recentSteps.length===1?input.candidates.find(c=>c.operation==='launch').id:'done';
      return decision(id);
    }});
  const report=await commands.run({command:'Открой Chrome'});
  assert.equal(report.ok,false);assert.equal(report.reason,'goal_not_verified');assert.equal(report.effectVerification,'none');
  assert.deepEqual(report.completed,[]);assert.deepEqual(report.satisfiedPostconditions,[]);
  assert.equal(inputs.at(-1).recentSteps.at(-1).status,'already_open');assert.equal(inputs.at(-1).recentSteps.at(-1).verified,false);
  assert.ok(inputs.at(-1).candidates.some(c=>c.operation==='activate'),'show-window action remains available');
  assert.equal(f.snapshot().windows[0].minimized,true);assert.equal(f.snapshot().windows[0].active,false);
  assert.equal(f.calls.some(c=>c.method==='execute'),false);
});

test('verified minimize then restore permits the requested second minimize within loop repetition bound',async()=>{
  const f=applicationFixture({initialMinimized:false}),operations=['inspect','minimize','restore','minimize'];
  const commands=new JevCommands({journalFactory:memoryJournal,apiKeyResolver:async()=>'synthetic-test-key',createSession:({command})=>createJevDesktopSession({desktop:f.desktop,command}),
    choose:async input=>{
      const operation=operations[input.recentSteps.length];
      if(!operation)return decision('done');
      const candidate=input.candidates.find(c=>c.operation===operation&&c.label.includes('Chrome'));
      assert.ok(candidate,`requested ${operation} must remain available`);return decision(candidate.id);
    }});
  const report=await commands.run({command:'Сверни Chrome, восстанови его и снова сверни'});
  assert.equal(report.ok,true);assert.equal(report.reason,'goal_model_assessed');
  assert.deepEqual(f.calls.filter(c=>c.method==='execute').map(c=>c.args.operation),['minimize','restore','minimize']);
  assert.deepEqual(report.completed.map(c=>c.operation),['minimize','restore','minimize']);
  assert.equal(f.snapshot().windows[0].minimized,true);
});

test('Jev browses the hierarchy and every short choice stays bound to the native adapter',async()=>{
  const f=fixture(),session=createJevDesktopSession({desktop:f.desktop,command:'Выбери аудиовыход'});
  let state=await session.observe();
  assert.equal(f.calls[0].args.windowId,null);
  assert.equal(state.observation.windows[0].surface,'taskbar');
  const inspect=state.candidates.find(c=>c.stableKey==='native:win_taskbar:inspect');
  assert.equal(inspect.effect,false);assert.match(inspect.id,/^step_\d+$/);
  assert.equal((await session.execute(inspect.id)).effectAttempted,false);
  state=await session.observe();
  const button=state.candidates.find(c=>c.operation==='invoke');assert.ok(button);
  const result=await session.execute(button.id);
  assert.equal(result.effectConfirmed,true);
  const dispatch=f.calls.find(c=>c.method==='execute');assert.equal(dispatch.args.targetId,'el_audio');assert.equal(dispatch.args.operation,'invoke');
  assert.ok(f.calls.every(c=>!c.method.startsWith('winapp')));
  await assert.rejects(session.execute(button.id),{code:'WINDOWS_ACTION_NOT_OBSERVED'});
  assert.equal((await session.observe()).candidates.some(c=>c.operation==='invoke'),false,'no blind repeated Invoke');
});

test('taskbar regions expose only current controls while newly opened shell menus remain inspectable',async()=>{
  const f=fixture({regions:true}),session=createJevDesktopSession({desktop:f.desktop,command:'Выбери аудиовыход'});
  const root=await session.observe();await session.execute(root.candidates.find(c=>c.stableKey==='native:win_taskbar:inspect').id);
  const groups=await session.observe();
  assert.equal(groups.candidates.some(c=>c.effect),false,'region selection itself must not click');
  assert.equal(groups.candidates.some(c=>c.stableKey==='native:win_other:inspect'),false,'ordinary unrelated windows stay at root');
  assert.ok(groups.candidates.some(c=>c.stableKey==='native:win_popup:inspect'),'new system menus stay reachable');
  const tray=groups.candidates.find(c=>c.stableKey==='region:win_taskbar:tray');assert.ok(tray);assert.match(tray.label,/звук/);assert.ok(tray.target.buttons.includes('Звук — Динамики'));
  await session.execute(tray.id);
  const buttons=await session.observe();assert.equal(buttons.observation.selectedRegion,'tray');
  assert.ok(buttons.candidates.some(c=>c.stableKey==='native:el_audio:invoke'));
  assert.equal(buttons.candidates.some(c=>c.stableKey==='native:el_app:invoke'),false);
  assert.ok(buttons.candidates.some(c=>c.stableKey==='region:win_taskbar:apps'));
  assert.ok(buttons.candidates.every(c=>!Object.hasOwn(c,'ownerId')&&!Object.hasOwn(c,'controlName')),'private mapping metadata is not model input');
  assert.equal(f.calls.some(c=>c.method==='execute'),false);
});

test('unknown model identifiers cannot select an executor or native arguments',async()=>{
  const f=fixture(),session=createJevDesktopSession({desktop:f.desktop});await session.observe();
  await assert.rejects(session.execute('winapp_execute'),{code:'WINDOWS_ACTION_NOT_OBSERVED'});
  assert.equal(f.calls.some(c=>c.method==='execute'),false);
});

test('first matching tab is not exposed as selectable when visual ordering is partial',async()=>{
  const f=fixture({tabs:true}),session=createJevDesktopSession({desktop:f.desktop,command:'Выбери первую вкладку ВКонтакте'});
  const root=await session.observe();await session.execute(root.candidates.find(c=>c.stableKey==='native:win_taskbar:inspect').id);
  const view=await session.observe();assert.equal(view.candidates.some(c=>c.operation==='select'),false);assert.equal(view.observation.coverage.ordinalSelectionBlocked,true);
});

test('audio goal is verified by actual default endpoint, never a UI click receipt',async()=>{
  for(const isDefault of [true,false]){
    const f=fixture({audioDefault:isDefault}),session=createJevDesktopSession({desktop:f.desktop,command:'Переключи аудиовыход на SberBox'});
    const observation=await session.observe();
    assert.equal(observation.observation.goalState.verified,isDefault,'Jev sees the independently measured current goal before choosing a click');
    const verification=await session.verifyGoal('Переключи аудиовыход на SberBox');
    assert.equal(verification.applicable,true);assert.equal(verification.verified,isDefault);
    assert.equal(f.calls.some(c=>c.method==='execute'),false);
  }
});

test('unrelated UI goal is not confirmed by an audio endpoint reading',async()=>{
  const f=fixture(),session=createJevDesktopSession({desktop:f.desktop,command:'Открой Chrome'});
  assert.equal((await session.verifyGoal('Открой Chrome')).applicable,false);assert.equal(f.calls.length,0);
});

test('audio postcondition cannot certify an unperformed second task',async()=>{
  const f=fixture(),session=createJevDesktopSession({desktop:f.desktop,command:'Переключи аудиовыход на SberBox и сверни Chrome'});
  const result=await session.verifyGoal();assert.equal(result.applicable,false);assert.equal(result.verified,false);
});

test('spoken Russian number words preserve fixed volume candidates and relative volumes are not misread as absolute',async()=>{
  const f=fixture(),systemTools={executeSystemTool:async()=>{}};
  for(const [command,expected] of [['Установи громкость на пятьдесят процентов',1],['Уменьши громкость на пятьдесят процентов',0]]){
    const session=createJevDesktopSession({desktop:f.desktop,command,systemTools});const view=await session.observe();
    const volumes=view.candidates.filter(c=>c.operation==='volume_set');assert.equal(volumes.length,expected);if(expected)assert.match(volumes[0].label,/50%/);
  }
});

test('explicit numeric volume candidates are bounded and no generated value is executed',async()=>{
  const f=fixture(),set=[];const session=createJevDesktopSession({desktop:f.desktop,command:'Громкость 45 процентов, затем 200',systemTools:{async executeSystemTool(intent){set.push(intent);return {ok:true,verified:true,effectAttempted:true,evidence:'volume_level_verified'};}}});
  const state=await session.observe(),volumes=state.candidates.filter(c=>c.operation==='volume_set');assert.equal(volumes.length,1);assert.match(volumes[0].label,/45%/);
  await session.execute(volumes[0].id);assert.deepEqual(set,[{kind:'volume',percent:45}]);
});
