import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {UnifiedCommands} from '../desktop/automation/assistant-commands.mjs';

const initialNow = new Date(2026, 11, 31, 14, 30).getTime();
const body = 'чтобы я моя задача не забыть написать в Телеграме и показать свои кейсы';
const original = `Можешь завтра напомнить, ${body}?`;
const clarification = (text = body, day = 'завтра', field = 'time') => ({route:'reminder', needsClarification:true, message:'Во сколько завтра?', clarification:{field, day, text}});

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jeff-followup-test-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  let currentNow = options.now ?? initialNow;
  const notes = [], reminders = [], interpretCalls = [], desktopCalls = [], chatCalls = [], systemCalls = [];
  const f = {directory, notes, reminders, interpretCalls, desktopCalls, chatCalls, systemCalls, setNow:value => {currentNow = value;}};
  const interpret = async (command, details) => {
    interpretCalls.push({command, now:details.now, signal:details.signal});
    return options.interpret ? options.interpret(command, details) : command === original ? clarification() : {route:'no_request', message:'Уточните запрос.'};
  };
  f.service = new UnifiedCommands({
    directory, now:() => currentNow, interpret,
    desktop:{async run(input) {desktopCalls.push(input); return {ok:true, reason:'goal_verified'};}, stop() {}},
    store:{addNote(text) {notes.push(text); return notes.length;}, addReminder(text, dueAt) {f.onReminder?.(text, dueAt); reminders.push({text, dueAt}); return reminders.length;}},
    chat:async text => {chatCalls.push(text); return {text:'Ответ.'};},
    executeSystem:async intent => {systemCalls.push(intent); return {ok:true, verified:true};}
  });
  return f;
}

const effectCount = f => f.notes.length + f.reminders.length + f.desktopCalls.length + f.chatCalls.length + f.systemCalls.length;
const journal = f => readFileSync(path.join(f.directory, f.service.activeRunId + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('each standalone clock spelling resolves one pending reminder without another model call', async t => {
  for (const followup of ['в18:30', '18:30', 'в 18:30']) {
    const f = await fixture(t);
    const first = await f.service.run({command:original});
    assert.equal(first.reason, 'clarification_required'); assert.equal(effectCount(f), 0);
    const report = await f.service.run({command:followup});
    assert.equal(report.ok, true, followup); assert.equal(report.reason, 'local_completed');
    assert.deepEqual(f.reminders, [{text:body, dueAt:new Date(2027, 0, 1, 18, 30).getTime() / 1000}]);
    assert.deepEqual(f.interpretCalls.map(call => call.command), [original]);
    assert.equal(report.command, followup); assert.equal(report.goal, followup);
    assert.equal(report.clarificationResolution.originalRunId, first.runId);
    assert.equal(report.completed[0].operation, 'reminder');
  }
});

test('the followup preserves exact note-like reminder wording and journals both requests before its write', async t => {
  const f = await fixture(t), first = await f.service.run({command:original});
  const followup = 'в 18:30', expectedDueAt = new Date(2027, 0, 1, 18, 30).getTime() / 1000;
  f.onReminder = (text, dueAt) => {
    const events = journal(f), resolvedAt = events.findIndex(event => event.phase === 'clarification_resolved');
    assert.equal(events.at(-1).phase, 'local_execute_request');
    assert.ok(resolvedAt >= 0 && resolvedAt < events.length - 1);
    assert.equal(text, body); assert.equal(dueAt, expectedDueAt); assert.equal(f.reminders.length, 0);
  };
  const report = await f.service.run({command:`  ${followup}  `});
  const resolution = report.clarificationResolution;
  assert.equal(report.command, followup); assert.equal(report.goal, followup);
  assert.equal(resolution.originalRequest, original); assert.equal(resolution.followupRequest, followup);
  assert.equal(resolution.originalRunId, first.runId); assert.equal(resolution.day, 'завтра');
  assert.match(resolution.timeExpression, /18:30/);
  assert.equal(resolution.dueAt, expectedDueAt); assert.equal(resolution.text, body);
  assert.deepEqual(report.calls, []);
  const saved = JSON.parse(await readFile(report.logPath, 'utf8'));
  assert.deepEqual(saved.clarificationResolution, resolution); assert.equal(saved.status, 'finished');
  assert.equal(saved.events.at(-1).phase, 'result');
});

test('a day before or after the standalone clock explicitly overrides the pending day', async t => {
  for (const followup of ['послезавтра в 09:15', 'в 09:15 послезавтра', '09:15 послезавтра']) {
    const f = await fixture(t); await f.service.run({command:original});
    const report = await f.service.run({command:followup});
    assert.equal(report.reason, 'local_completed', followup);
    assert.deepEqual(f.reminders, [{text:body, dueAt:new Date(2027, 0, 2, 9, 15).getTime() / 1000}]);
    assert.equal(report.clarificationResolution.day, 'послезавтра'); assert.equal(f.interpretCalls.length, 1);
  }
});

test('an implicit day stays anchored to the original clarification when the reply crosses midnight', async t => {
  const f = await fixture(t, {now:new Date(2026, 11, 31, 23, 59, 30).getTime()});
  await f.service.run({command:original});
  f.setNow(new Date(2027, 0, 1, 0, 0, 30).getTime());
  const report = await f.service.run({command:'18:30'});
  assert.equal(report.reason, 'local_completed');
  assert.equal(f.reminders[0].dueAt, new Date(2027, 0, 1, 18, 30).getTime() / 1000);
  assert.equal(f.interpretCalls.length, 1);
});

test('model latency across midnight preserves the original day while TTL starts after the question', async t => {
  const requestTime = new Date(2026, 11, 31, 23, 59, 30).getTime();
  const questionTime = new Date(2027, 0, 1, 0, 0, 30).getTime();
  let f;
  f = await fixture(t, {now:requestTime, interpret:async (command, details) => {
    if (command !== original) return {route:'no_request'};
    assert.equal(details.now, requestTime);
    f.setNow(questionTime);
    return clarification();
  }});
  assert.equal((await f.service.run({command:original})).reason, 'clarification_required');
  // More than two minutes since the command, but only 75 seconds since the question.
  f.setNow(questionTime + 75_000);
  const report = await f.service.run({command:'18:30'});
  assert.equal(report.reason, 'local_completed');
  assert.equal(f.reminders[0].dueAt, new Date(2027, 0, 1, 18, 30).getTime() / 1000);
  assert.equal(f.interpretCalls.length, 1);
});

test('pending clarification is consumed after a successful save and cannot create a duplicate', async t => {
  const f = await fixture(t); await f.service.run({command:original});
  assert.equal((await f.service.run({command:'18:30'})).reason, 'local_completed');
  const repeat = await f.service.run({command:'19:00'});
  assert.equal(repeat.reason, 'no_request'); assert.equal(f.reminders.length, 1);
  assert.deepEqual(f.interpretCalls.map(call => call.command), [original, '19:00']);
  assert.equal(repeat.clarificationResolution, undefined);
});

test('an expired pending time is not merged into a clock after the two-minute TTL', async t => {
  const f = await fixture(t); await f.service.run({command:original});
  f.setNow(initialNow + 120_001);
  const report = await f.service.run({command:'18:30'});
  assert.equal(report.reason, 'no_request'); assert.equal(effectCount(f), 0);
  assert.equal(report.clarificationResolution, undefined); assert.equal(f.interpretCalls.length, 2);
});

test('unexpired pending time can still resolve just before the TTL', async t => {
  const f = await fixture(t); await f.service.run({command:original});
  f.setNow(initialNow + 119_999);
  assert.equal((await f.service.run({command:'18:30'})).reason, 'local_completed');
  assert.equal(f.reminders.length, 1); assert.equal(f.interpretCalls.length, 1);
});

test('another request clears the pending reminder before normal semantic routing', async t => {
  const unrelated = 'Сохрани заметку купить чай';
  const f = await fixture(t, {interpret:async command => command === original ? clarification() : command === unrelated ? {route:'note', intent:{kind:'note', text:'купить чай'}} : {route:'no_request'}});
  await f.service.run({command:original});
  assert.equal((await f.service.run({command:unrelated})).reason, 'local_completed');
  assert.deepEqual(f.notes, ['купить чай']);
  assert.equal((await f.service.run({command:'18:30'})).reason, 'no_request');
  assert.deepEqual(f.reminders, []); assert.equal(f.interpretCalls.length, 3);
});

test('ambiguous confirmations, quotation, negation and multiple clocks never merge context', async t => {
  for (const followup of ['да', '«в 18:30»', 'не в 18:30', '18:30 или 19:00', 'в 18:30 и в 19:00', 'он сказал в 18:30']) {
    const f = await fixture(t); await f.service.run({command:original});
    const report = await f.service.run({command:followup});
    assert.equal(report.reason, 'no_request', followup); assert.equal(effectCount(f), 0, followup);
    assert.equal(report.clarificationResolution, undefined);
    assert.deepEqual(f.interpretCalls.map(call => call.command), [original, followup]);
    assert.equal((await f.service.run({command:'18:30'})).reason, 'no_request');
    assert.equal(effectCount(f), 0);
  }
});

test('stop clears idle pending clarification and prevents a later time-only write', async t => {
  const f = await fixture(t); await f.service.run({command:original}); f.service.stop();
  const report = await f.service.run({command:'18:30'});
  assert.equal(report.reason, 'no_request'); assert.equal(effectCount(f), 0); assert.equal(f.interpretCalls.length, 2);
});

test('clarifications with empty, unknown or non-source text never establish a pending reminder', async t => {
  for (const text of [null, undefined, '', '   ', 'выдуманный текст которого нет в запросе']) {
    const decision = clarification(); decision.clarification.text = text;
    const f = await fixture(t, {interpret:async command => command === original ? decision : {route:'no_request'}});
    await f.service.run({command:original});
    const report = await f.service.run({command:'18:30'});
    assert.equal(report.reason, 'no_request', String(text)); assert.equal(effectCount(f), 0);
    assert.equal(f.interpretCalls.length, 2);
  }
});

test('only reminder time clarification with a known day accepts a later clock', async t => {
  for (const decision of [clarification(body, 'завтра', 'date'), clarification(body, 'когда-нибудь'), {...clarification(), route:'note'}]) {
    const f = await fixture(t, {interpret:async command => command === original ? decision : {route:'no_request'}});
    await f.service.run({command:original});
    assert.equal((await f.service.run({command:'18:30'})).reason, 'no_request');
    assert.equal(effectCount(f), 0); assert.equal(f.interpretCalls.length, 2);
  }
});

test('invalid exact clock receives local clarification and consumes pending context without effects', async t => {
  for (const followup of ['24:00', 'в 18:99']) {
    const f = await fixture(t); await f.service.run({command:original});
    const report = await f.service.run({command:followup});
    assert.equal(report.reason, 'clarification_required', followup); assert.equal(report.needsClarification, true);
    assert.equal(effectCount(f), 0); assert.equal(f.interpretCalls.length, 1);
    assert.equal((await f.service.run({command:'18:30'})).reason, 'no_request');
    assert.equal(effectCount(f), 0); assert.equal(f.interpretCalls.length, 2);
  }
});

test('stop at either clarification resolution or local execution journal gate prevents the write', async t => {
  for (const phase of ['clarification_resolved', 'local_execute_request']) {
    const f = await fixture(t); await f.service.run({command:original});
    f.service.progress = event => {if (event.phase === phase) f.service.stop();};
    const report = await f.service.run({command:'18:30'});
    assert.equal(report.reason, 'aborted', phase); assert.equal(effectCount(f), 0); assert.deepEqual(report.completed, []);
    assert.equal(f.service.running, false);
    assert.equal((await f.service.run({command:'19:00'})).reason, 'no_request');
    assert.equal(effectCount(f), 0);
  }
});

test('an already aborted followup cannot write or invoke a provider', async t => {
  const f = await fixture(t); await f.service.run({command:original});
  const abort = new AbortController(); abort.abort();
  const report = await f.service.run({command:'18:30', signal:abort.signal});
  assert.equal(report.reason, 'aborted'); assert.equal(effectCount(f), 0); assert.equal(f.interpretCalls.length, 1);
});

test('expiry during the resolution event is rechecked immediately before the store write', async t => {
  const f = await fixture(t); await f.service.run({command:original});
  f.service.progress = event => {if (event.phase === 'clarification_resolved') f.setNow(initialNow + 120_001);};
  const report = await f.service.run({command:'18:30'});
  assert.equal(report.ok, false); assert.equal(report.error, 'REMINDER_CONTEXT_EXPIRED');
  assert.equal(effectCount(f), 0); assert.deepEqual(report.completed, []); assert.equal(f.interpretCalls.length, 1);
  assert.equal((await f.service.run({command:'19:00'})).reason, 'no_request');
  assert.equal(effectCount(f), 0);
});

test('a journal creation failure during resolution prevents a persistent write', async t => {
  const f = await fixture(t); await f.service.run({command:original});
  const blocked = path.join(f.directory, 'not-a-directory'); await writeFile(blocked, 'fixture');
  f.service.directory = blocked;
  const report = await f.service.run({command:'18:30'});
  assert.equal(report.reason, 'LOG_WRITE_FAILED'); assert.equal(effectCount(f), 0); assert.equal(f.interpretCalls.length, 1);
});
