import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {UnifiedCommands} from '../desktop/automation/assistant-commands.mjs';

async function fixture(t,options={}){
  const directory=await mkdtemp(path.join(tmpdir(),'jeff-unified-commands-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const notes=[],reminders=[],desktopCalls=[],chatCalls=[],events=[];
  let stopped=0;
  const desktop={logDirectory:directory,async run(input){desktopCalls.push(input);return {runId:'desktop-owned',ok:true,reason:'goal_verified',command:input.command};},stop(){stopped++;}};
  const store={addNote(text){notes.push(text);return notes.length;},addReminder(text,dueAt){reminders.push({text,dueAt});return reminders.length;}};
  const chat=async(text,{signal})=>{chatCalls.push({text,signal});return {text:'Текстовый ответ.',model:'gemini-test'};};
  const service=new UnifiedCommands({desktop,store,chat,progress:event=>events.push(event),now:()=>1_800_000_000_000,...options});
  return {service,directory,notes,reminders,desktopCalls,chatCalls,events,stopped:()=>stopped};
}

test('exact note is saved once after its typed intent has been durably journaled',async t=>{
  let service,directory;const notes=[];
  const f=await fixture(t,{store:{addNote(text){
    notes.push(text);
    assert.ok(service.activeRunId);
    const persisted=readFileSync(path.join(directory,service.activeRunId+'.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(persisted.at(-1).phase,'local_execute_request');
    assert.deepEqual(persisted.at(-1).intent,{kind:'note',text:'купить чай'});
    return 19;
  }},progress:event=>{if(event.phase==='local_execute_request')assert.equal(notes.length,0);}});
  ({service,directory}=f);
  const report=await service.run({command:'  запиши заметку купить чай  '});
  assert.equal(report.ok,true);assert.equal(report.reason,'local_completed');
  assert.deepEqual(notes,['купить чай']);assert.deepEqual(f.desktopCalls,[]);assert.deepEqual(f.chatCalls,[]);
  assert.deepEqual(report.completed,[{operation:'note',id:19,outcome:'local_saved',evidence:'local_store_returned_id'}]);
  assert.equal(report.goal,'запиши заметку купить чай');assert.ok(Number.isFinite(report.elapsedMs));
  const stored=JSON.parse(await readFile(report.logPath,'utf8'));
  assert.equal(stored.status,'finished');assert.equal(stored.ok,true);
  const events=(await readFile(path.join(directory,report.runId+'.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const requested=events.findIndex(e=>e.phase==='local_execute_request'),finished=events.findIndex(e=>e.phase==='local_execute_result');
  assert.ok(requested>=0&&finished>requested);
  assert.deepEqual(events[requested].intent,{kind:'note',text:'купить чай'});
  assert.equal(events.at(-1).phase,'result');
});

test('relative reminders use the exact parser timestamp and no model',async t=>{
  const f=await fixture(t);
  const report=await f.service.run({command:'напомни через две минуты проверить чай'});
  assert.equal(report.reason,'local_completed');
  assert.deepEqual(f.reminders,[{text:'проверить чай',dueAt:1_800_000_120}]);
  assert.equal(f.desktopCalls.length+f.chatCalls.length,0);
});

test('help and exact invalid local commands stay local without effects',async t=>{
  const f=await fixture(t);
  assert.equal((await f.service.run({command:'помощь'})).reason,'local_completed');
  for(const command of ['напомни завтра купить чай','таймер на -5 минут','напомни через 2 минуты и 30 секунд чай','заметка']){
    const report=await f.service.run({command});assert.equal(report.reason,'local_rejected',command);assert.equal(report.ok,false);assert.equal(report.completed.length,0);
  }
  assert.equal(f.notes.length+f.reminders.length+f.desktopCalls.length+f.chatCalls.length,0);
});

test('app launch and generic or negated text go to desktop, with no automatic chat fallback',async t=>{
  const calls=[];const supplied={ok:false,reason:'low_confidence',runId:'native-run',trace:[{phase:'model_decision'}]};
  const f=await fixture(t,{desktop:{async run(input){calls.push(input);return supplied;},stop(){}}});
  for(const command of ['открой калькулятор','открой диспетчер задач','не сохраняй заметку чай','какая сегодня погода?']){
    assert.equal(await f.service.run({command}),supplied);
  }
  assert.equal(calls.length,4);assert.equal(f.chatCalls.length,0);assert.equal(f.notes.length,0);
  assert.deepEqual(await readdir(f.directory),[]);
});

test('explicit question prefixes call text-only chat with only current command and signal',async t=>{
  const f=await fixture(t);
  for(const command of ['расскажи о музыке','Объясни, что такое таймер','вопрос: что такое UIA?']){
    const report=await f.service.run({command});
    assert.equal(report.reason,'chat_answer');assert.equal(report.message,'Текстовый ответ.');assert.equal(report.completed.length,0);
    assert.equal(report.calls[0].provider,'gemini');assert.ok(Number.isFinite(report.calls[0].latencyMs));
    assert.deepEqual(report.calls[0].request,{text:command});
    assert.equal(report.events.some(event=>event.phase==='chat_response'),true);
    assert.equal(f.chatCalls.at(-1).text,command);assert.ok(f.chatCalls.at(-1).signal instanceof AbortSignal);
  }
  assert.equal(f.desktopCalls.length,0);
});

test('explicit chat mode never executes a note, and desktop mode bypasses the parser',async t=>{
  const f=await fixture(t);
  assert.equal((await f.service.run({command:'заметка чай',mode:'chat'})).reason,'chat_answer');
  assert.equal((await f.service.run({command:'заметка чай',mode:'desktop'})).reason,'goal_verified');
  assert.equal(f.notes.length,0);assert.equal(f.chatCalls.length,1);assert.equal(f.desktopCalls.length,1);
});

test('invalid commands and modes fail before routing or journaling',async t=>{
  const f=await fixture(t);
  for(const command of ['',null,' '.repeat(4),'x'.repeat(1025),'заметка\0чай'])await assert.rejects(f.service.run({command}),{code:'INVALID_COMMAND'});
  await assert.rejects(f.service.run({command:'помощь',mode:'shell'}),{code:'INVALID_COMMAND_MODE'});
  assert.deepEqual(await readdir(f.directory),[]);assert.equal(f.service.running,false);
});

test('a busy task cannot overlap a local write',async t=>{
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{chat:async()=>{entered();return new Promise(resolve=>{release=resolve;});}});
  const pending=f.service.run({command:'расскажи о музыке'});await ready;
  await assert.rejects(f.service.run({command:'заметка чай'}),{code:'TASK_ALREADY_RUNNING'});
  assert.equal(f.notes.length,0);release({text:'Ответ'});await pending;
  assert.equal(f.service.running,false);
});

test('stop while journaling before a local mutation prevents that mutation',async t=>{
  let service;
  const f=await fixture(t,{progress:event=>{if(event.phase==='local_execute_request')service.stop();}});service=f.service;
  const report=await service.run({command:'заметка чай'});
  assert.equal(report.reason,'aborted');assert.equal(report.ok,false);assert.equal(f.notes.length,0);assert.equal(report.completed.length,0);assert.equal(f.stopped(),1);
});

test('already aborted local requests never reach the store or a provider',async t=>{
  const f=await fixture(t);const controller=new AbortController();controller.abort();
  const report=await f.service.run({command:'заметка чай',signal:controller.signal});
  assert.equal(report.reason,'aborted');assert.equal(f.notes.length+f.chatCalls.length+f.desktopCalls.length,0);
});

test('aborting an active chat discards a late answer and unlocks the next task',async t=>{
  let release,entered,receivedSignal;
  const ready=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{chat:async(text,{signal})=>{receivedSignal=signal;entered();return new Promise(resolve=>{release=resolve;});}});
  const pending=f.service.run({command:'расскажи о музыке'});await ready;f.service.stop();
  assert.equal(receivedSignal.aborted,true);release({text:'Опоздавший ответ'});
  const report=await pending;assert.equal(report.reason,'aborted');assert.doesNotMatch(JSON.stringify(report),/Опоздавший/);assert.equal(f.service.running,false);
  assert.equal((await f.service.run({command:'помощь'})).reason,'local_completed');
});

test('external abort calls desktop.stop but preserves the actual desktop report',async t=>{
  let release,entered,stops=0;
  const ready=new Promise(resolve=>{entered=resolve;});const actual={ok:false,reason:'aborted',executionUncertain:true};
  const f=await fixture(t,{desktop:{run:async()=>{entered();return new Promise(resolve=>{release=resolve;});},stop(){stops++;}}});
  const controller=new AbortController();const pending=f.service.run({command:'сверни Chrome',signal:controller.signal});await ready;controller.abort();release(actual);
  assert.equal(await pending,actual);assert.equal(stops,1);
});

test('pre-aborted desktop request reaches its journal owner with a cancelled signal',async t=>{
  const actual={ok:false,reason:'aborted',runId:'cancelled-desktop'};
  const f=await fixture(t,{desktop:{run:async({signal})=>{assert.equal(signal.aborted,true);return actual;},stop(){}}});
  const abort=new AbortController();abort.abort();
  assert.equal(await f.service.run({command:'открой диспетчер задач',signal:abort.signal}),actual);
  assert.equal(f.service.running,false);
});

test('chat failures do not reveal thrown messages or call desktop',async t=>{
  const f=await fixture(t,{chat:async()=>{throw new Error('Secret gateway URL and credential');}});
  const report=await f.service.run({command:'расскажи о музыке'});
  assert.equal(report.reason,'chat_failed');assert.equal(report.ok,false);assert.equal(f.desktopCalls.length,0);
  assert.doesNotMatch(JSON.stringify(report),/Secret gateway/);
  assert.doesNotMatch(await readFile(report.logPath,'utf8'),/Secret gateway/);
});

test('chat results retain only bounded text and model, with secrets redacted by the journal',async t=>{
  const f=await fixture(t,{chat:async()=>({text:'Ответ apikey_12345678901234567890',model:'gemini-test',apiKey:'never-record-this',tools:[{name:'launch'}]})});
  const report=await f.service.run({command:'расскажи о музыке'});
  const data=JSON.stringify(report);assert.match(data,/\[REDACTED\]/);assert.doesNotMatch(data,/never-record-this|12345678901234567890|"tools"/);
  assert.deepEqual(Object.keys(report.calls[0].response),['text','model']);
});

test('empty or oversized chat answers fail, and missing chat is reported locally',async t=>{
  for(const answer of [{text:''},{text:'x'.repeat(65537)},{tools:[{name:'click'}]}]){
    const f=await fixture(t,{chat:async()=>answer});const report=await f.service.run({command:'расскажи о музыке'});
    assert.equal(report.reason,'chat_failed');assert.equal(report.error,'CHAT_INVALID_RESPONSE');
  }
  const f=await fixture(t,{chat:null});assert.equal((await f.service.run({command:'расскажи о музыке'})).error,'CHAT_UNAVAILABLE');
});

test('an unavailable journal prevents any persistent mutation',async t=>{
  const f=await fixture(t);const blocked=path.join(f.directory,'not-a-directory');await writeFile(blocked,'test');f.service.directory=blocked;
  const report=await f.service.run({command:'заметка чай'});
  assert.equal(report.ok,false);assert.equal(report.reason,'LOG_WRITE_FAILED');assert.equal(f.notes.length,0);assert.equal(report.completed.length,0);assert.equal(f.service.running,false);
});

test('a store failure returns a local rejection without falling back to a model',async t=>{
  const f=await fixture(t,{store:{addNote(){throw new Error('private database path');}}});
  const report=await f.service.run({command:'заметка чай'});
  assert.equal(report.reason,'local_rejected');assert.equal(report.completed.length,0);assert.equal(f.chatCalls.length+f.desktopCalls.length,0);assert.doesNotMatch(JSON.stringify(report),/private database path/);
});

test('cancellation after a completed synchronous store write does not hide the saved effect',async t=>{
  let service;const f=await fixture(t,{store:{addNote(){service.stop();return 7;}}});service=f.service;
  const report=await service.run({command:'заметка чай'});
  assert.equal(report.reason,'aborted');assert.equal(report.completed[0].id,7);assert.equal(report.completed[0].outcome,'local_saved');assert.equal(report.result.ok,true);
});
