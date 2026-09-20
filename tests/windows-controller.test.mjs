import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {getEventListeners} from 'node:events';
import {WindowsDesktop} from '../scripts/windows-desktop/controller.mjs';
import {RunJournal} from '../scripts/desktop-lab/journal.mjs';

const version=n=>n.toString(16).padStart(32,'0');
function snapshot(n,{minimized=false,selected=true,extra=[],stateVersion}={}){
  const window={id:'win_editor',title:'Draft — Editor',processName:'editor',minimized,maximized:false,active:!minimized,...(stateVersion===undefined?{}:{stateVersion})};
  return {version:version(n),windows:[window],elements:[{id:window.id,windowId:window.id,label:'editor: Draft — Editor',name:window.title,role:'Window',capabilities:['inspect',minimized?'restore':'minimize']},...extra],facts:{selectedWindowId:selected?window.id:null},metadata:{provider:'synthetic test UIA'}};
}
const action=(input,operation='minimize')=>{
  const candidate=input.candidates.find(c=>c.operation===operation);
  assert.ok(candidate,`expected ${operation} candidate`);
  return {choice:candidate.id,actionId:candidate.id,probability:0.95,confidence:0.96,goalStatus:'not_achieved',goalProbability:0.94,goalConfidence:0.94};
};
const done=overrides=>({choice:'done',actionId:null,probability:0.97,confidence:0.98,goalStatus:'achieved',goalProbability:0.96,goalConfidence:0.97,...overrides});
const nativeError=code=>Object.assign(new Error(code),{code});
const receipt=(args,after,overrides={})=>({operation:args.operation,targetId:args.targetId,verified:true,stateChanged:false,evidence:'window_minimized',after,...overrides});

async function setup(t,{snapshots=[snapshot(1)],execute,choose=async()=>done(),journalFactory,progress=()=>{},...options}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'jeff-windows-controller-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const calls=[];let observed=0;
  const bridge={
    async request(method,args,signal){
      calls.push({method,args,signal});
      if(method==='observe')return structuredClone(snapshots[Math.min(observed++,snapshots.length-1)]);
      assert.equal(method,'execute');
      return execute?execute(args,{calls,observed}):receipt(args,snapshots.at(-1));
    },
    close(){},
  };
  const apps={list:async()=>[],launch:async()=>{assert.fail('unexpected installed application launch');}};
  const desktop=new WindowsDesktop(progress,{bridge,apps,choose,directory,apiKeyResolver:async()=>'synthetic-local-test-key',...(journalFactory?{journalFactory}:{}),...options});
  t.after(()=>desktop.dispose());
  return {desktop,calls,directory,observations:()=>observed};
}

test('executes an observed candidate, journals before the effect, and verifies a fresh goal',async t=>{
  const before=snapshot(1),after=snapshot(2,{minimized:true});let selections=0;
  const ctx=await setup(t,{snapshots:[before,before,after,after],
    choose:async(input,{onResponse})=>{
      await onResponse({model:'jev-test',answers:{synthetic:true},usage:{input_tokens:1,output_tokens:1}});
      assert.match(input.observation.summary,/Draft — Editor/);
      return selections++===0?action(input):done();
    },
    execute:async args=>{
      const events=(await readFile(path.join(ctx.directory,ctx.desktop.activeRunId+'.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(events.at(-1).phase,'execute_request');
      assert.equal(events.at(-1).expectedVersion,before.version);
      assert.ok(events.some(event=>event.phase==='model_response'));
      assert.deepEqual(args,{operation:'minimize',targetId:'win_editor',expectedVersion:before.version});
      return receipt(args,after);
    }});
  const report=await ctx.desktop.run({command:'Сверни Editor'});
  assert.equal(report.ok,true);assert.equal(report.reason,'goal_verified');
  assert.equal(report.completed.length,1);assert.equal(report.final.version,after.version);
  assert.equal(ctx.observations(),4);assert.equal(ctx.calls.filter(c=>c.method==='execute').length,1);
  const stored=await ctx.desktop.readRun({runId:report.runId});
  assert.equal(stored.status,'finished');assert.equal(stored.ok,true);
  assert.equal(stored.events.at(-1).phase,'result');
  assert.equal((await ctx.desktop.history()).runs[0].runId,report.runId);
});

test('low probability or confidence prevents all desktop effects',async t=>{
  for(const weak of [{probability:0.79},{confidence:0.79},{probability:NaN},{confidence:1.01}]){
    const ctx=await setup(t,{choose:async input=>({...action(input),...weak})});
    const report=await ctx.desktop.run({command:'Сверни Editor'});
    assert.equal(report.reason,'low_confidence');assert.equal(report.ok,false);
    assert.equal(ctx.calls.some(c=>c.method==='execute'),false);
  }
});

test('changed snapshot discards a choice and asks the model again with current state',async t=>{
  const first=snapshot(1),second=snapshot(2);let choices=0;
  const ctx=await setup(t,{snapshots:[first,second,second,second],maxSteps:2,choose:async input=>{choices++;return action(input);}});
  const report=await ctx.desktop.run({command:'Сверни Editor'});
  assert.equal(choices,2);assert.equal(report.trace.filter(e=>e.phase==='stale').length,1);
  const effects=ctx.calls.filter(c=>c.method==='execute');assert.equal(effects.length,1);
  assert.equal(effects[0].args.expectedVersion,second.version);
  assert.notEqual(report.calls[0].decision.actionId,report.calls[1].decision.actionId);
});

test('stable target window token permits a window effect despite unrelated UIA changes',async t=>{
  const stateVersion='a'.repeat(64);
  const before=snapshot(1,{stateVersion,extra:[{id:'status',windowId:'win_editor',name:'Elapsed: 1',label:'Elapsed: 1',role:'Text',capabilities:[]}]}),
    fresh=snapshot(2,{stateVersion,extra:[{id:'status',windowId:'win_editor',name:'Elapsed: 2',label:'Elapsed: 2',role:'Text',capabilities:[]}]}),
    after=snapshot(3,{stateVersion:'b'.repeat(64),minimized:true});
  const ctx=await setup(t,{snapshots:[before,fresh],maxSteps:1,choose:async input=>action(input),execute:async args=>{
    assert.deepEqual(args,{operation:'minimize',targetId:'win_editor',expectedVersion:fresh.version,expectedWindowVersion:stateVersion});
    const events=(await readFile(path.join(ctx.directory,ctx.desktop.activeRunId+'.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).phase,'execute_request');assert.equal(events.at(-1).expectedWindowVersion,stateVersion);
    return receipt(args,after);
  }});
  const report=await ctx.desktop.run({command:'Сверни Editor'});
  assert.equal(report.completed.length,1);assert.equal(report.completed[0].outcome,'verified');
  assert.equal(ctx.calls.filter(c=>c.method==='execute').length,1);assert.equal(report.trace.some(e=>e.phase==='stale'),false);
});

test('changed, missing, or vanished target window token discards the old choice and replans',async t=>{
  const before=snapshot(1,{stateVersion:'a'.repeat(64)});
  const cases=[snapshot(2,{stateVersion:'b'.repeat(64)}),snapshot(2),
    {version:version(2),windows:[],elements:[],facts:{selectedWindowId:null},metadata:{provider:'synthetic test UIA'}}];
  for(const changed of cases){
    let choices=0;
    const ctx=await setup(t,{snapshots:[before,changed,changed],maxSteps:2,choose:async input=>choices++===0?action(input):{choice:'unsupported'}});
    const report=await ctx.desktop.run({command:'Сверни Editor'});
    assert.equal(choices,2);assert.equal(report.ok,false);assert.equal(report.reason,'unsupported');
    assert.equal(report.trace.filter(e=>e.phase==='stale').length,1);assert.equal(ctx.calls.some(c=>c.method==='execute'),false);
    assert.equal(report.completed.length,0);
  }
});

test('UIA selection and invocation still require full snapshot freshness despite a stable window token',async t=>{
  for(const operation of ['select','invoke']){
    const stateVersion='a'.repeat(64),extra=[{id:'control_play',windowId:'win_editor',name:'Play',label:'Play',role:operation==='select'?'TabItem':'Button',capabilities:[operation]}];
    const before=snapshot(1,{stateVersion,extra}),changed=snapshot(2,{stateVersion,extra});let choices=0;
    const ctx=await setup(t,{snapshots:[before,changed,changed],maxSteps:2,choose:async input=>choices++===0?action(input,operation):{choice:'unsupported'}});
    const report=await ctx.desktop.run({command:'Выбери Play'});
    assert.equal(choices,2);assert.equal(report.reason,'unsupported');assert.equal(report.ok,false);
    assert.equal(report.trace.filter(e=>e.phase==='stale').length,1);assert.equal(ctx.calls.some(c=>c.method==='execute'),false);
  }
});

test('a control effect uses no scoped window token even when the containing window has one',async t=>{
  const before=snapshot(1,{stateVersion:'a'.repeat(64),extra:[{id:'control_play',windowId:'win_editor',name:'Play',label:'Play',role:'Button',capabilities:['invoke']}]});
  const ctx=await setup(t,{snapshots:[before],maxSteps:1,choose:async input=>action(input,'invoke')});
  const report=await ctx.desktop.run({command:'Нажми Play'});
  assert.equal(report.completed.length,1);
  assert.deepEqual(ctx.calls.find(c=>c.method==='execute').args,{operation:'invoke',targetId:'control_play',expectedVersion:before.version});
});

test('goal completion still requires a fresh full snapshot even when the window token is stable',async t=>{
  const stateVersion='a'.repeat(64),before=snapshot(1,{stateVersion}),changed=snapshot(2,{stateVersion});let choices=0;
  const ctx=await setup(t,{snapshots:[before,changed,changed],maxSteps:2,choose:async()=>choices++===0?done():{choice:'unsupported'}});
  const report=await ctx.desktop.run({command:'Сверни Editor'});
  assert.equal(choices,2);assert.equal(report.ok,false);assert.equal(report.reason,'unsupported');
  assert.equal(report.trace.filter(e=>e.phase==='stale').length,1);assert.equal(ctx.calls.some(c=>c.method==='execute'),false);
});

test('native stale rejection triggers observation and inference instead of blind retry',async t=>{
  const first=snapshot(1),second=snapshot(2);let attempts=0,choices=0;
  const ctx=await setup(t,{snapshots:[first,first,second,second],maxSteps:2,
    choose:async input=>{choices++;return action(input);},
    execute:async args=>{if(attempts++===0)throw nativeError('STALE_SNAPSHOT');return receipt(args,second);}});
  const report=await ctx.desktop.run({command:'Сверни Editor'});
  assert.equal(choices,2);assert.equal(ctx.observations(),4);assert.equal(attempts,2);
  assert.deepEqual(ctx.calls.map(c=>c.method),['observe','observe','execute','observe','observe','execute']);
  assert.ok(report.trace.some(e=>e.phase==='stale'&&e.code==='STALE_SNAPSHOT'));
  assert.equal(report.completed.length,1);
});

test('an unverified native receipt stops instead of issuing another action',async t=>{
  let choices=0;
  const ctx=await setup(t,{choose:async input=>{choices++;return action(input);},execute:async args=>receipt(args,snapshot(1),{verified:false,stateChanged:false,evidence:'foreground_not_granted'})});
  const report=await ctx.desktop.run({command:'Сверни Editor'});
  assert.equal(report.reason,'not_verified');assert.equal(report.ok,false);assert.equal(choices,1);
  assert.equal(report.completed.length,0);assert.equal(ctx.calls.filter(c=>c.method==='execute').length,1);
});

test('native result must match the exact operation and target',async t=>{
  for(const mismatch of [{targetId:'win_other'},{operation:'close'}]){
    const ctx=await setup(t,{choose:async input=>action(input),execute:async args=>receipt(args,snapshot(2),mismatch)});
    const report=await ctx.desktop.run({command:'Сверни Editor'});
    assert.equal(report.reason,'execution_uncertain');assert.equal(report.ok,false);assert.equal(report.completed.length,0);
    assert.equal(report.executionUncertain,true);
    assert.equal((await ctx.desktop.readRun({runId:report.runId})).executionUncertain,true);
  }
});

test('a missing receipt or missing post-effect snapshot never resolves dispatch uncertainty',async t=>{
  for(const output of [null,{verified:true,stateChanged:false,evidence:'window_minimized',after:null}]){
    const ctx=await setup(t,{choose:async input=>action(input),execute:async args=>output?{operation:args.operation,targetId:args.targetId,...output}:null});
    const report=await ctx.desktop.run({command:'Сверни Editor'});
    assert.equal(report.reason,'execution_uncertain');assert.equal(report.executionUncertain,true);assert.equal(report.ok,false);
    assert.equal(report.completed.length,0);assert.equal(ctx.calls.filter(c=>c.method==='execute').length,1);
  }
});

test('native rejection that explicitly precedes the effect has no execution uncertainty',async t=>{
  const ctx=await setup(t,{choose:async input=>action(input),execute:async()=>{throw Object.assign(nativeError('UIA_REQUEST_FAILED'),{details:{stage:'resolve',effectAttempted:false}});}});
  const report=await ctx.desktop.run({command:'Сверни Editor'});
  assert.equal(report.reason,'UIA_REQUEST_FAILED');assert.equal(report.executionUncertain,false);
  assert.equal(report.errorDetails.effectAttempted,false);assert.equal(ctx.calls.filter(c=>c.method==='execute').length,1);
});

test('stale-looking failures after an attempted effect stop without replan or replay',async t=>{
  for(const failure of [Object.assign(nativeError('STALE_SNAPSHOT'),{details:{effectAttempted:true}}),nativeError('UIA_CHANGED_AFTER_APPLY')]){
    let choices=0;
    const ctx=await setup(t,{choose:async input=>{choices++;return action(input);},execute:async()=>{throw failure;}});
    const report=await ctx.desktop.run({command:'Сверни Editor'});
    assert.equal(report.reason,failure.code);assert.equal(report.executionUncertain,true);assert.equal(report.ok,false);
    assert.equal(choices,1);assert.equal(ctx.calls.filter(c=>c.method==='execute').length,1);
    assert.equal(report.trace.some(event=>event.phase==='stale'),false);
  }
});

test('done requires both independent goal and action judgments above threshold',async t=>{
  for(const weak of [{probability:0.79},{confidence:0.79},{goalStatus:'unknown'},{goalStatus:'not_achieved'},{goalProbability:0.79},{goalConfidence:0.79},{goalProbability:NaN}]){
    const ctx=await setup(t,{choose:async()=>done(weak)});
    const report=await ctx.desktop.run({command:'Сверни Editor'});
    assert.equal(report.reason,'goal_not_verified');assert.equal(report.ok,false);
    assert.equal(ctx.calls.some(c=>c.method==='execute'),false);
  }
});

test('done against a changed state is reconsidered and does not report success',async t=>{
  let choices=0;
  const ctx=await setup(t,{snapshots:[snapshot(1),snapshot(2),snapshot(2)],choose:async()=>choices++===0?done():{choice:'unsupported'},maxSteps:2});
  const report=await ctx.desktop.run({command:'Сверни Editor'});
  assert.equal(report.ok,false);assert.equal(report.reason,'unsupported');assert.equal(choices,2);
  assert.equal(report.trace.filter(e=>e.phase==='stale').length,1);
});

test('state change receipt alone is not completion, but a later strong goal may establish it',async t=>{
  const after=snapshot(2,{minimized:true});let choices=0;
  const ctx=await setup(t,{snapshots:[snapshot(1),snapshot(1),after,after],choose:async input=>choices++===0?action(input):done(),execute:async args=>receipt(args,after,{verified:false,stateChanged:true,evidence:'state_changed'})});
  const report=await ctx.desktop.run({command:'Сверни Editor'});
  assert.equal(report.ok,true);assert.equal(report.reason,'goal_observed');
  assert.equal(report.completed[0].outcome,'observed_change');assert.equal(choices,2);
  assert.equal(report.verification.effects,'mixed_native_and_observed_change');
});

test('journal failure before execute_request prevents the operating system effect',async t=>{
  const journalFactory=async(command,options)=>{
    const journal=await RunJournal.create(command,options);const record=journal.record.bind(journal);
    journal.record=(phase,data)=>phase==='execute_request'?Promise.reject(nativeError('LOG_WRITE_FAILED')):record(phase,data);
    return journal;
  };
  const ctx=await setup(t,{journalFactory,choose:async input=>action(input)});
  const report=await ctx.desktop.run({command:'Сверни Editor'});
  assert.equal(report.reason,'LOG_WRITE_FAILED');assert.equal(report.ok,false);
  assert.equal(ctx.calls.some(c=>c.method==='execute'),false);assert.equal(ctx.desktop.running,false);
});

test('throwing or asynchronously rejected progress notifications cannot change results or leave a running journal',async t=>{
  for(const progress of [()=>{throw new Error('UI subscriber failed');},()=>Promise.reject(new Error('Async UI subscriber failed'))]){
    const before=snapshot(1),after=snapshot(2,{minimized:true});let choices=0;
    const ctx=await setup(t,{progress,snapshots:[before,before,after,after],choose:async input=>choices++===0?action(input):done(),execute:async args=>receipt(args,after)});
    const report=await ctx.desktop.run({command:'Сверни Editor'});
    assert.equal(report.ok,true);assert.equal(report.reason,'goal_verified');assert.equal(report.completed.length,1);
    assert.equal(report.executionUncertain,false);
    const stored=await ctx.desktop.readRun({runId:report.runId});
    assert.equal(stored.status,'finished');assert.equal(stored.reason,'goal_verified');assert.equal(stored.events.at(-1).phase,'result');
  }
});

test('verified effects remain recorded if a subsequent journal write fails',async t=>{
  const journalFactory=async(command,options)=>{
    const journal=await RunJournal.create(command,options),record=journal.record.bind(journal);
    journal.record=(phase,data)=>phase==='verify'?Promise.reject(nativeError('LOG_WRITE_FAILED')):record(phase,data);
    return journal;
  };
  const ctx=await setup(t,{journalFactory,choose:async input=>action(input),execute:async args=>receipt(args,snapshot(2,{minimized:true}))});
  const report=await ctx.desktop.run({command:'Сверни Editor'});
  assert.equal(report.ok,false);assert.equal(report.reason,'LOG_WRITE_FAILED');assert.equal(report.executionUncertain,false);
  assert.equal(report.completed.length,1);assert.equal(report.completed[0].outcome,'verified');
});

test('pre-aborted external signal writes a normal stopped report before key discovery or observation',async t=>{
  const external=new AbortController();external.abort('user_stop');
  const ctx=await setup(t,{apiKeyResolver:async()=>assert.fail('must not resolve a key for a cancelled run'),choose:async()=>assert.fail('no inference')});
  const report=await ctx.desktop.run({command:'Сверни Editor',signal:external.signal});
  assert.equal(report.reason,'aborted');assert.equal(report.ok,false);assert.equal(report.executionUncertain,false);
  assert.equal(ctx.calls.length,0);assert.equal(ctx.desktop.running,false);
  assert.equal((await ctx.desktop.readRun({runId:report.runId})).status,'finished');
  assert.equal(getEventListeners(external.signal,'abort').length,0);
});

test('external abort reaches in-flight inference and its listener is detached after any completed run',async t=>{
  const external=new AbortController();let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const ctx=await setup(t,{choose:async(_input,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(nativeError('ABORTED')),{once:true});entered();})});
  const pending=ctx.desktop.run({command:'Сверни Editor',signal:external.signal});
  await started;external.abort();const report=await pending;
  assert.equal(report.reason,'aborted');assert.equal(report.executionUncertain,false);assert.equal(ctx.calls.some(c=>c.method==='execute'),false);
  assert.equal(getEventListeners(external.signal,'abort').length,0);
  const unused=new AbortController(),successful=await setup(t);
  assert.equal((await successful.desktop.run({command:'Сверни Editor',signal:unused.signal})).ok,true);
  assert.equal(getEventListeners(unused.signal,'abort').length,0);
});

test('stop aborts in-flight inference and records a stopped result without effects',async t=>{
  let entered;const inferenceStarted=new Promise(resolve=>{entered=resolve;});
  const ctx=await setup(t,{choose:async(_input,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(nativeError('ABORTED')),{once:true});entered();})});
  const pending=ctx.desktop.run({command:'Сверни Editor'});await inferenceStarted;
  assert.equal(ctx.desktop.running,true);assert.deepEqual(ctx.desktop.stop(),{stopped:true});
  const report=await pending;
  assert.equal(report.reason,'aborted');assert.equal(report.ok,false);assert.equal(ctx.desktop.running,false);
  assert.equal(ctx.calls.some(c=>c.method==='execute'),false);
  assert.equal((await ctx.desktop.readRun({runId:report.runId})).reason,'aborted');
});

test('stop during an OS effect records uncertainty and never retries the action',async t=>{
  let entered;const effectStarted=new Promise(resolve=>{entered=resolve;});
  const ctx=await setup(t,{choose:async input=>action(input),execute:async(_args,{calls})=>new Promise((resolve,reject)=>{
    calls.at(-1).signal.addEventListener('abort',()=>reject(nativeError('ABORTED')),{once:true});entered();
  })});
  const pending=ctx.desktop.run({command:'Сверни Editor'});await effectStarted;ctx.desktop.stop();
  const report=await pending;
  assert.equal(report.reason,'aborted');assert.equal(report.ok,false);assert.equal(report.executionUncertain,true);
  assert.equal(ctx.calls.filter(c=>c.method==='execute').length,1);assert.equal(report.completed.length,0);
  assert.equal((await ctx.desktop.readRun({runId:report.runId})).executionUncertain,true);
});

test('stop during read-only inspect does not claim an uncertain desktop effect',async t=>{
  let entered;const inspectionStarted=new Promise(resolve=>{entered=resolve;});
  const ctx=await setup(t,{snapshots:[snapshot(1,{selected:false})],choose:async input=>action(input,'inspect'),execute:async(_args,{calls})=>new Promise((resolve,reject)=>{
    calls.at(-1).signal.addEventListener('abort',()=>reject(nativeError('ABORTED')),{once:true});entered();
  })});
  const pending=ctx.desktop.run({command:'Посмотри элементы Editor'});await inspectionStarted;ctx.desktop.stop();
  const report=await pending;
  assert.equal(report.reason,'aborted');assert.equal(report.executionUncertain,false);
  assert.equal(ctx.calls.filter(c=>c.method==='execute').length,1);
});

test('invalid commands and overlapping tasks cannot start another native effect',async t=>{
  let entered;const inferenceStarted=new Promise(resolve=>{entered=resolve;});
  const ctx=await setup(t,{choose:async(_input,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(nativeError('ABORTED')),{once:true});entered();})});
  for(const command of [undefined,'','   ','x'.repeat(1025),'bad\x00command']){
    await assert.rejects(ctx.desktop.run({command}),{code:'INVALID_COMMAND'});
  }
  assert.equal(ctx.calls.length,0);
  const pending=ctx.desktop.run({command:'Сверни Editor'});await inferenceStarted;
  await assert.rejects(ctx.desktop.run({command:'Закрой Editor'}),{code:'TASK_ALREADY_RUNNING'});
  ctx.desktop.stop();await pending;
  assert.equal(ctx.calls.some(c=>c.method==='execute'),false);
});

test('unknown or inconsistent action IDs cannot reach the native backend',async t=>{
  for(const inconsistent of [{choice:'invented',actionId:'invented'},{choice:'done_elsewhere'}]){
    const ctx=await setup(t,{choose:async input=>({...action(input),...inconsistent})});
    const report=await ctx.desktop.run({command:'Сверни Editor'});
    assert.equal(report.reason,'unknown_action');assert.equal(ctx.calls.some(c=>c.method==='execute'),false);
  }
});

test('malformed snapshots and malformed receipt snapshots stop safely',async t=>{
  const initial=await setup(t,{snapshots:[{version:'bad',windows:[],elements:[]}],choose:async()=>{assert.fail('must reject before inference');}});
  const badInitial=await initial.desktop.run({command:'Сверни Editor'});
  assert.equal(badInitial.reason,'WINDOWS_INVALID_SNAPSHOT');assert.equal(initial.calls.some(c=>c.method==='execute'),false);
  assert.equal(badInitial.executionUncertain,false);
  const after=await setup(t,{choose:async input=>action(input),execute:async args=>receipt(args,{version:'bad',windows:[],elements:[]})});
  const badAfter=await after.desktop.run({command:'Сверни Editor'});
  assert.equal(badAfter.reason,'WINDOWS_INVALID_SNAPSHOT');assert.equal(badAfter.completed.length,0);assert.equal(badAfter.ok,false);
  assert.equal(badAfter.executionUncertain,true);
  assert.equal((await after.desktop.readRun({runId:badAfter.runId})).executionUncertain,true);
});

test('unsupported advances candidate pages so later real controls can be selected',async t=>{
  const extra=Array.from({length:130},(_,i)=>({id:`button_${i}`,windowId:'win_editor',name:`Option ${i}`,label:`Option ${i}`,role:'Button',capabilities:['invoke']}));
  const current=snapshot(1,{selected:true,extra});let choices=0;const offered=[];
  const ctx=await setup(t,{snapshots:[current],maxSteps:2,choose:async input=>{offered.push(input.candidates);return choices++===0?{choice:'unsupported'}:action(input,'invoke');}});
  const report=await ctx.desktop.run({command:'Открой нужный пункт'});
  assert.equal(choices,2);assert.equal(ctx.calls.filter(c=>c.method==='execute').length,1);
  assert.equal(offered[0].some(c=>c.id===report.completed[0].id),false);
  assert.equal(offered[1].some(c=>c.id===report.completed[0].id),true);
  assert.ok(report.trace.some(e=>e.phase==='candidate_page'));
});

test('uninspected windows require discovery before offering their window effects',async t=>{
  const initial=snapshot(1,{selected:false}),selected=snapshot(2),minimized=snapshot(3,{minimized:true});let choices=0;
  const ctx=await setup(t,{snapshots:[initial,initial,selected,selected,minimized,minimized],choose:async input=>{
    choices++;
    if(choices===1){assert.equal(input.phase,'windows');assert.equal(input.candidates.some(c=>c.operation==='minimize'),false);return action(input,'inspect');}
    if(choices===2){assert.equal(input.phase,'controls');assert.equal(input.candidates.some(c=>c.operation==='inspect'),false);assert.equal(input.completed[0].evidence,'window_inspected');return action(input,'minimize');}
    return done();
  },execute:async args=>args.operation==='inspect'?receipt(args,selected,{evidence:'window_inspected'}):receipt(args,minimized)});
  const report=await ctx.desktop.run({command:'Сверни Editor'});
  assert.equal(report.ok,true);assert.equal(report.reason,'goal_verified');assert.equal(choices,3);
  assert.deepEqual(ctx.calls.filter(c=>c.method==='execute').map(c=>c.args.operation),['inspect','minimize']);
  assert.deepEqual(report.completed.map(c=>c.evidence),['window_inspected','window_minimized']);
});

const installedMusic={id:'app_0123456789abcdef01234567',name:'Music Player',processName:'music-player',exe:'C:\\Synthetic Programs\\Music Player\\music-player.exe'};
function withNewWindow(original,{id='win_music',processId=4242,processName='music-player',title='Music Player'}={}){
  return {...structuredClone(original),version:version(2),windows:[...original.windows,{id,title,processName,processId,minimized:false,maximized:false,active:true}],elements:[...original.elements,{id,windowId:id,label:`${processName}: ${title}`,name:title,role:'Window',capabilities:['inspect','activate','minimize']} ]};
}

test('launch uses the listed app ID, logs before spawning, and verifies the exact new PID',async t=>{
  const before=snapshot(1),after=withNewWindow(before);let listings=0,choices=0;const launches=[];
  const apps={list:async signal=>{assert.equal(signal.aborted,false);listings++;return [installedMusic];},launch:async(id,signal)=>{
    launches.push(id);assert.equal(signal.aborted,false);
    const durable=(await readFile(path.join(ctx.directory,ctx.desktop.activeRunId+'.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(durable.at(-1).phase,'execute_request');assert.equal(durable.at(-1).candidate.targetId,installedMusic.id);
    return {pid:4242,name:installedMusic.name,processName:installedMusic.processName};
  }};
  const ctx=await setup(t,{apps,snapshots:[before,before,after,after,after],choose:async input=>{
    assert.doesNotMatch(JSON.stringify(input),/Synthetic Programs|music-player\.exe/);
    return choices++===0?action(input,'launch'):done();
  }});
  const report=await ctx.desktop.run({command:'Открой Music Player'});
  assert.equal(report.ok,true);assert.equal(report.reason,'goal_verified');assert.equal(listings,1);
  assert.deepEqual(launches,[installedMusic.id]);assert.equal(ctx.calls.some(c=>c.method==='execute'),false);
  assert.equal(report.completed[0].operation,'launch');assert.equal(report.completed[0].outcome,'verified');
  assert.equal(report.completed[0].evidence,'launched_process_window_observed');
  assert.deepEqual(report.trace.find(e=>e.phase==='execute_result').receipt.launched,{pid:4242,name:installedMusic.name});
  assert.doesNotMatch(JSON.stringify(await ctx.desktop.readRun({runId:report.runId})),/Synthetic Programs|music-player\.exe/);
});

test('a matching process with a different PID is only observed_change',async t=>{
  for(const match of [{processId:9898},{processId:9898,processName:'music-player',title:'Library'}]){
    const before=snapshot(1),after=withNewWindow(before,match);let choices=0;
    const apps={list:async()=>[installedMusic],launch:async()=>({pid:4242,name:installedMusic.name,processName:installedMusic.processName})};
    const ctx=await setup(t,{apps,snapshots:[before,before,after,after,after],choose:async input=>choices++===0?action(input,'launch'):done()});
    const report=await ctx.desktop.run({command:'Открой Music Player'});
    assert.equal(report.ok,true);assert.equal(report.reason,'goal_observed');
    assert.equal(report.completed[0].outcome,'observed_change');assert.equal(report.completed[0].evidence,'matching_application_window_observed');
    const result=report.trace.find(e=>e.phase==='execute_result').receipt;
    assert.equal(result.verified,false);assert.equal(result.stateChanged,true);
  }
});

test('an unrelated new process with a matching title cannot verify the requested launch',async t=>{
  const before=snapshot(1),after=withNewWindow(before,{processId:9898,processName:'another-player',title:'Music Player — Library'});let launches=0,choices=0;
  const apps={list:async()=>[installedMusic],launch:async()=>{launches++;return {pid:4242,name:installedMusic.name,processName:installedMusic.processName};}};
  const ctx=await setup(t,{apps,snapshots:[before,before,after],choose:async input=>{choices++;return action(input,'launch');}});
  const report=await ctx.desktop.run({command:'Открой Music Player'});
  assert.equal(report.ok,false);assert.equal(report.reason,'not_verified');assert.equal(launches,1);assert.equal(choices,1);
  assert.equal(report.completed.length,0);
  assert.equal(report.executionUncertain,true);
  const result=report.trace.find(e=>e.phase==='execute_result').receipt;
  assert.equal(result.verified,false);assert.equal(result.stateChanged,false);assert.equal(result.evidence,'process_started_window_not_observed');
});

test('a spawned process without an observed new window stops unverified without relaunch',async t=>{
  let launches=0,choices=0;
  const apps={list:async()=>[installedMusic],launch:async()=>{launches++;return {pid:4242,name:installedMusic.name,processName:installedMusic.processName};}};
  const ctx=await setup(t,{apps,choose:async input=>{choices++;return action(input,'launch');}});
  const report=await ctx.desktop.run({command:'Открой Music Player'});
  assert.equal(report.ok,false);assert.equal(report.reason,'not_verified');assert.equal(launches,1);assert.equal(choices,1);
  assert.equal(report.completed.length,0);assert.equal(ctx.calls.some(c=>c.method==='execute'),false);
  assert.equal(report.executionUncertain,true);
  const result=report.trace.find(e=>e.phase==='execute_result').receipt;
  assert.equal(result.verified,false);assert.equal(result.stateChanged,false);assert.equal(result.evidence,'process_started_window_not_observed');
});

test('a read-only observation error after a known process spawn cannot clear effect uncertainty',async t=>{
  let launches=0,observations=0,choices=0;
  const apps={list:async()=>[installedMusic],launch:async()=>{launches++;return {pid:4242,name:installedMusic.name,processName:installedMusic.processName};}};
  const bridge={close(){},request:async(method)=>{
    assert.equal(method,'observe');
    if(++observations<=2)return snapshot(1);
    throw Object.assign(nativeError('UIA_REQUEST_FAILED'),{details:{stage:'observe',effectAttempted:false}});
  }};
  const ctx=await setup(t,{bridge,apps,choose:async input=>{choices++;return action(input,'launch');}});
  const report=await ctx.desktop.run({command:'Открой Music Player'});
  assert.equal(report.reason,'UIA_REQUEST_FAILED');assert.equal(report.ok,false);assert.equal(report.executionUncertain,true);
  assert.equal(report.errorDetails.effectAttempted,true);assert.equal(launches,1);assert.equal(choices,1);
});

test('unknown launch action IDs never reach installed-app launcher',async t=>{
  let launches=0;
  const apps={list:async()=>[installedMusic],launch:async()=>{launches++;assert.fail('unknown app must never launch');}};
  const ctx=await setup(t,{apps,choose:async input=>({...action(input,'launch'),choice:'a_unobserved_app',actionId:'a_unobserved_app'})});
  const report=await ctx.desktop.run({command:'Открой Music Player'});
  assert.equal(report.reason,'unknown_action');assert.equal(launches,0);assert.equal(ctx.calls.some(c=>c.method==='execute'),false);
});

test('catalog discovery failure preserves control of already observed windows',async t=>{
  const apps={list:async()=>{throw nativeError('APPS_DISCOVERY_FAILED');},launch:async()=>{assert.fail('no catalog means no launch');}};
  const ctx=await setup(t,{apps,maxSteps:1,choose:async input=>{assert.equal(input.candidates.some(c=>c.operation==='launch'),false);return action(input);}});
  const report=await ctx.desktop.run({command:'Сверни Editor'});
  assert.equal(report.completed.length,1);assert.equal(report.completed[0].operation,'minimize');
  assert.ok(report.trace.some(e=>e.phase==='installed_apps_unavailable'&&e.code==='APPS_DISCOVERY_FAILED'));
});
