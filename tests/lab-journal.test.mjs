import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {RunJournal,readRun,listRuns} from '../scripts/desktop-lab/journal.mjs';
import {describeResult} from '../desktop/automation/feedback.mjs';

async function workspace(t) {
  const directory=await mkdtemp(path.join(tmpdir(),'jeff-journal-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return directory;
}
const readEvents=async run=>(await readFile(run.eventPath,'utf8')).trim().split('\n').map(JSON.parse);

test('semantic parent and desktop child both remain running while unrelated abandoned runs are interrupted',async t=>{
  const directory=await workspace(t);
  const parent=await RunJournal.create('parent',{directory});
  const child=await RunJournal.create('child',{directory});
  const abandoned=await RunJournal.create('abandoned',{directory});
  const activeRunIds=[parent.runId,child.runId];
  assert.equal((await readRun(child.runId,{directory,activeRunIds})).status,'running');
  const {runs}=await listRuns({directory,activeRunIds});
  assert.equal(runs.find(r=>r.runId===parent.runId).status,'running');
  assert.equal(runs.find(r=>r.runId===child.runId).status,'running');
  assert.equal(runs.find(r=>r.runId===abandoned.runId).status,'interrupted');
});

test('recovered parent warns about its unresolved delegation even when the child finished its effect',async t=>{
  const directory=await workspace(t);
  const parent=await RunJournal.create('Закрой блокнот',{directory});
  await parent.record('desktop_delegate_request',{scope:{operation:'close'}});
  const child=await RunJournal.create('Закрой блокнот',{directory});
  await child.record('execute_request',{operation:'close',targetId:'test-window'});
  await child.record('execute_result',{receipt:{operation:'close',targetId:'test-window',verified:true,evidence:'window_closed'}});
  await child.finish({ok:true,reason:'goal_verified',completed:[{operation:'close',outcome:'verified'}]});
  const recovered=await readRun(parent.runId,{directory});
  assert.equal(recovered.reason,'interrupted');
  const feedback=describeResult(recovered);
  assert.equal(feedback.tone,'warning');assert.equal(feedback.retryable,false);
  assert.match(feedback.message,/могло выполниться.*Перед повтором проверьте/u);
  assert.equal(describeResult(await readRun(child.runId,{directory})).tone,'success');
  const {runs}=await listRuns({directory});
  assert.equal(runs.find(run=>run.runId===parent.runId).feedback.tone,'warning');
  assert.equal(runs.find(run=>run.runId===child.runId).feedback.tone,'success');
  // The summary is written before the parent JSON embeds the native receipts.
  await parent.record('desktop_delegate_result',{childRunId:child.runId,ok:true,reason:'goal_verified',executionUncertain:false});
  const afterSummary=describeResult(await readRun(parent.runId,{directory}));
  assert.equal(afterSummary.tone,'warning');assert.equal(afterSummary.retryable,false);
  await parent.finish({ok:true,reason:'goal_verified',desktopEvents:child.events,completed:[{operation:'close',outcome:'verified'}]});
  assert.equal(describeResult(await readRun(parent.runId,{directory})).tone,'success');
});

test('events reach JSONL before finish, including concurrent enqueue in sequence order',async t=>{
  const directory=await workspace(t);
  const run=await RunJournal.create('Открой музыку',{directory});
  assert.deepEqual((await readEvents(run)).map(e=>e.phase),['session_start']);
  await run.record('observation',{facts:{playing:false}});
  assert.deepEqual((await readEvents(run)).map(e=>e.phase),['session_start','observation']);
  const queued=['request','response','execute'].map(phase=>run.record(phase));
  await Promise.all(queued);
  const events=await readEvents(run);
  assert.deepEqual(events.map(e=>e.sequence),[1,2,3,4,5]);
  assert.deepEqual(events.map(e=>e.phase),['session_start','observation','request','response','execute']);
  assert.ok(events.every(e=>e.runId===run.runId && Number.isFinite(Date.parse(e.time))));
  assert.ok(events.every((e,i)=>i===0 || Date.parse(e.time)>=Date.parse(events[i-1].time)));
  assert.equal(JSON.parse(await readFile(run.jsonPath,'utf8')).status,'running');
});

test('finished report and history survive reconstruction from disk',async t=>{
  const directory=await workspace(t);
  const run=await RunJournal.create('Выбери VK',{directory});
  const pending=run.record('verified',{facts:{selectedTab:'VK feed'}});
  await run.finish({ok:true,reason:'goal_verified',elapsedMs:17,goal:{selectedTab:'VK feed'}});
  await pending;
  const stored=JSON.parse(await readFile(run.jsonPath,'utf8'));
  const report=await readRun(run.runId,{directory});
  assert.equal(report.status,'finished');
  assert.equal(report.ok,true);
  assert.deepEqual(report.events,stored.events);
  assert.equal(report.events.at(-1).phase,'verified');
  assert.equal(report.goal.selectedTab,'VK feed');
  const {runs}=await listRuns({directory});
  assert.equal(runs.length,1);
  assert.equal(runs[0].runId,run.runId);
  assert.equal(runs[0].reason,'goal_verified');
  assert.equal(runs[0].elapsedMs,17);
});

test('unfinished run recovers durable events and distinguishes active from interrupted',async t=>{
  const directory=await workspace(t);
  const run=await RunJournal.create('Включи музыку',{directory});
  await run.record('native_execute_request',{targetId:'el2'});
  const active=await readRun(run.runId,{directory,activeRunId:run.runId});
  assert.equal(active.status,'running');
  const interrupted=await readRun(run.runId,{directory});
  assert.equal(interrupted.status,'interrupted');
  assert.equal(interrupted.reason,'interrupted');
  assert.equal(interrupted.ok,false);
  assert.equal(interrupted.events.at(-1).phase,'native_execute_request');
  assert.equal((await listRuns({directory})).runs[0].status,'interrupted');
});

test('compact history keeps the truthful title even when answer and receipts are omitted',async t=>{
  const directory=await workspace(t);
  const chat=await RunJournal.create('Объясни, что такое память',{directory});
  await chat.finish({ok:true,reason:'chat_answer',message:'Тестовый ответ'});
  const launch=await RunJournal.create('Открой программу',{directory});
  await launch.record('execute_result',{receipt:{operation:'launch',verified:false,evidence:'process_started_window_not_observed'}});
  await launch.finish({ok:false,reason:'not_verified',executionUncertain:true});
  const {runs}=await listRuns({directory});
  assert.deepEqual(runs.find(r=>r.runId===chat.runId).feedback,{tone:'success',title:'Ответ готов'});
  assert.deepEqual(runs.find(r=>r.runId===launch.runId).feedback,{tone:'warning',title:'Программа запущена, окно не найдено'});
  assert.ok(runs.every(r=>!('events' in r)&&!('message' in r)));
});

test('run identifiers cannot escape the configured directory',async t=>{
  const directory=await workspace(t);
  for(const runId of ['../1234567890123','..\\1234567890123','/1234567890123','C:\\1234567890123','1234567890123/../../x','1234567890123.json','1234567890123\0']){
    await assert.rejects(readRun(runId,{directory}),{code:'INVALID_RUN_ID'});
  }
});

test('credentials are redacted in initial JSON, streaming events, final report and history',async t=>{
  const directory=await workspace(t);
  const literal='apikey_0123456789abcdef_0123456789abcdef';
  const secret='synthetic-test-credential-only';
  const run=await RunJournal.create(`test ${literal}`,{directory});
  assert.ok(!(await readFile(run.jsonPath,'utf8')).includes(literal));
  await run.record('response',{nested:[{apiKey:secret,password:secret,authorization:`Bearer ${secret}`,access_token:secret,headers:{Authorization:secret},text:`output ${literal} Bearer fake.token-123`}]});
  const streaming=await readFile(run.eventPath,'utf8');
  assert.ok(!streaming.includes(secret));
  assert.ok(!streaming.includes(literal));
  assert.ok(!streaming.includes('fake.token-123'));
  await run.finish({ok:false,reason:'test',nested:{refreshToken:secret,secret,description:literal}});
  const serialized=JSON.stringify(await readRun(run.runId,{directory}));
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes(literal));
  assert.ok(serialized.includes('[REDACTED]'));
  assert.ok(!JSON.stringify(await listRuns({directory})).includes(literal));
});

test('crash-truncated final JSONL line preserves all preceding complete events',async t=>{
  const directory=await workspace(t);
  const run=await RunJournal.create('Тест восстановления',{directory});
  await run.record('request',{targetId:'el1'});
  await appendFile(run.eventPath,'{"phase":"response","sequence":3,"payload":');
  const report=await readRun(run.runId,{directory});
  assert.equal(report.status,'interrupted');
  assert.deepEqual(report.events.map(e=>e.phase),['session_start','request']);
  assert.equal((await listRuns({directory})).runs[0].reason,'interrupted');
});
