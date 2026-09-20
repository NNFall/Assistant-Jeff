import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {VoiceSession} from '../desktop/audio/session.mjs';
import {UnifiedCommands} from '../desktop/automation/assistant-commands.mjs';

const now = new Date(2026, 11, 31, 14, 30).getTime();
const body = 'чтобы я сбросил свои лимиты в кодексе';
const original = `Можешь поставить мне напоминание на завтра, ${body}?`;
const expected = {text:body, dueAt:new Date(2027, 0, 1, 18, 30).getTime() / 1000};
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

async function fixture(t, {transcripts = [original], autoExecute = true, interpret} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jeff-voice-followup-test-'));
  const models = path.join(directory, 'models'); await mkdir(models);
  await Promise.all(['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx'].map(name => writeFile(path.join(models, name), '')));
  const events = [], reminders = [], notes = [], listeners = new Set();
  const calls = {interpret:[], transcribe:[], encode:[], speech:[], desktop:[], chat:[], stops:0};
  const settings = {cloudEnabled:true, voiceAutoExecute:autoExecute, denisReply:true, activationBeep:false, transcriptionMode:'batch'};
  const queue = [...transcripts];
  const commands = new UnifiedCommands({
    directory:path.join(directory, 'runs'), now:() => now,
    desktop:{async run(request) {calls.desktop.push(request); return {ok:true, reason:'goal_verified'};}, stop() {}},
    store:{addNote(text) {notes.push(text); return notes.length;}, addReminder(text, dueAt) {reminders.push({text, dueAt}); return reminders.length;}},
    chat:async (text, details) => {calls.chat.push({text, ...details}); return {text:'Чай бывает разным.'};},
    interpret:async (command, details) => {
      calls.interpret.push({command, ...details});
      if (interpret) return interpret(command, details);
      return command === original ? {route:'reminder', needsClarification:true, message:'Во сколько завтра?', clarification:{field:'time', day:'завтра', text:body}} : {route:'no_request', message:'Уточните запрос.'};
    }
  });
  const stopCommands = commands.stop.bind(commands);
  commands.stop = () => {calls.stops++; return stopCommands();};
  const gateway = {available:async () => true, transcribe:async (mp3, details) => {
    calls.transcribe.push({mp3, ...details}); assert.ok(queue.length, 'Fixture must provide every transcript');
    return {text:queue.shift(), model:'fixture-stt', latencyMs:1};
  }};
  const encoder = {available:async () => true, encode:async (pcm, details) => {calls.encode.push({samples:pcm.length, ...details}); return Buffer.from('fixture-mp3');}};
  const denis = {status:async () => ({available:true}), synthesize:async (text, details) => {
    calls.speech.push({text, ...details}); return {wav:Buffer.from('fixture-wav'), mimeType:'audio/wav', durationMs:1};
  }};
  const session = new VoiceSession({paths:{models}, commands, gateway, encoder, denis, getSettings:() => settings,
    createWake:async () => ({accept:async () => ({triggered:false}), reset() {}, async close() {}}), tailMs:0,
    emit:event => {
      events.push(event); for (const listener of listeners) listener(event);
      if (event.type === 'speech') queueMicrotask(() => session.speechEnded({id:event.id}));
    }
  });
  t.after(async () => {await session.stop(); await rm(directory, {recursive:true, force:true});});
  const waitStopped = () => session.state === 'stopped' ? Promise.resolve() : new Promise(resolve => {
    const listener = event => {if (event.type === 'status' && event.state === 'stopped') {listeners.delete(listener); resolve();}};
    listeners.add(listener);
  });
  return {session, commands, events, reminders, notes, calls, settings, waitStopped};
}

function speechPcm(session) {
  for (let index = 0; index < 4; index++) assert.equal(session.accept(new Int16Array(1280).fill(2000)), true);
}

async function manualCapture(f, {waitForStop = true} = {}) {
  assert.equal((await f.session.start({mode:'manual'})).ok, true);
  const interpretations = f.calls.interpret.length, transcriptions = f.calls.transcribe.length;
  speechPcm(f.session);
  assert.equal(f.calls.interpret.length, interpretations); assert.equal(f.calls.transcribe.length, transcriptions);
  assert.equal(await f.session.batch.finish(), true);
  if (waitForStop) await f.waitStopped();
}

test('automatic manual capture shutdown preserves reminder clarification for typed time', {timeout:5000}, async t => {
  const f = await fixture(t); await manualCapture(f);
  assert.equal(f.session.state, 'stopped'); assert.equal(f.calls.stops, 0);
  assert.deepEqual(f.reminders, []); assert.equal(f.calls.interpret.length, 1);
  const initial = f.events.find(event => event.type === 'result').report;
  assert.equal(initial.reason, 'clarification_required'); assert.equal(f.calls.speech.length, 1);
  assert.match(f.calls.speech[0].text, /Во сколько завтра/);
  const report = await f.session.runTyped({command:'в 18:30'});
  assert.equal(report.reason, 'local_completed'); assert.deepEqual(f.reminders, [expected]);
  assert.equal(report.clarificationResolution.originalRunId, initial.runId);
  assert.equal(f.calls.interpret.length, 1); assert.equal(f.calls.transcribe.length, 1);
  assert.equal(f.calls.stops, 0); assert.equal(f.session.state, 'stopped');
});

test('a new manual voice capture resolves the pending reminder with final в18:30', {timeout:5000}, async t => {
  const f = await fixture(t, {transcripts:[original, 'в18:30']});
  await manualCapture(f); assert.equal(f.session.state, 'stopped');
  await manualCapture(f);
  assert.deepEqual(f.reminders, [expected]); assert.equal(f.calls.interpret.length, 1);
  assert.equal(f.calls.transcribe.length, 2); assert.equal(f.calls.speech.length, 2);
  assert.equal(f.calls.stops, 0); assert.equal(f.session.state, 'stopped');
  const reports = f.events.filter(event => event.type === 'result');
  assert.deepEqual(reports.map(event => event.report.reason), ['clarification_required', 'local_completed']);
  assert.equal(reports[1].report.command, 'в18:30');
  assert.ok(f.events.filter(event => event.type === 'transcript').every(event => event.final && event.autoExecute));
});

test('explicit session stop after automatic capture shutdown clears reminder context', {timeout:5000}, async t => {
  const f = await fixture(t); await manualCapture(f);
  assert.equal(f.session.state, 'stopped'); assert.equal(f.calls.stops, 0);
  await f.session.stop(); assert.equal(f.calls.stops, 1);
  const report = await f.session.runTyped({command:'в 18:30'});
  assert.equal(report.reason, 'no_request'); assert.deepEqual(f.reminders, []);
  assert.deepEqual(f.calls.interpret.map(call => call.command), [original, 'в 18:30']);
});

test('review-only captures neither start nor resolve a reminder until explicit typed execution', {timeout:5000}, async t => {
  const f = await fixture(t, {transcripts:[original, 'в18:30'], autoExecute:false});
  await manualCapture(f);
  assert.equal(f.calls.interpret.length, 0); assert.equal(f.calls.speech.length, 0); assert.deepEqual(f.reminders, []);
  const firstTranscript = f.events.find(event => event.type === 'transcript');
  assert.equal(firstTranscript.final, true); assert.equal(firstTranscript.autoExecute, false);
  assert.equal((await f.session.runTyped({command:firstTranscript.text})).reason, 'clarification_required');
  assert.equal(f.calls.interpret.length, 1); assert.deepEqual(f.reminders, []);
  await manualCapture(f);
  assert.equal(f.calls.interpret.length, 1); assert.equal(f.calls.speech.length, 1); assert.deepEqual(f.reminders, []);
  const lastTranscript = f.events.filter(event => event.type === 'transcript').at(-1);
  assert.equal(lastTranscript.autoExecute, false); assert.equal(lastTranscript.text, 'в18:30');
  assert.equal((await f.session.runTyped({command:lastTranscript.text})).reason, 'local_completed');
  assert.deepEqual(f.reminders, [expected]); assert.equal(f.calls.interpret.length, 1); assert.equal(f.calls.stops, 0);
});

test('a stale automatic stop timer cannot cancel a new manual recording', {timeout:5000}, async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f = await fixture(t, {transcripts:[original, 'в18:30']});
  await manualCapture(f, {waitForStop:false});
  assert.equal(f.session.state, 'waiting');
  assert.equal((await f.session.start({mode:'manual'})).ok, true);
  assert.equal(f.session.state, 'recording');
  const generation = f.session.batch.generation;
  t.mock.timers.tick(0);
  assert.equal(f.session.state, 'recording'); assert.equal(f.session.batch.generation, generation);
  assert.equal(f.calls.stops, 0);
  speechPcm(f.session); assert.equal(await f.session.batch.finish(), true);
  t.mock.timers.tick(0); await f.waitStopped();
  assert.deepEqual(f.reminders, [expected]); assert.equal(f.calls.interpret.length, 1);
  assert.equal(f.calls.transcribe.length, 2); assert.equal(f.calls.stops, 0);
});

test('a stale automatic stop timer cannot cancel a typed task started after voice clarification', {timeout:5000}, async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const entered = deferred(), resume = deferred(); let typedSignal;
  const f = await fixture(t, {interpret:async (command, details) => {
    if (command === original) return {route:'reminder', needsClarification:true, message:'Во сколько завтра?', clarification:{field:'time', day:'завтра', text:body}};
    typedSignal = details.signal; entered.resolve(); await resume.promise; return {route:'chat'};
  }});
  await manualCapture(f, {waitForStop:false}); assert.equal(f.session.state, 'waiting');
  const pending = f.session.runTyped({command:'Расскажи о чае'}); await entered.promise;
  assert.equal(f.commands.running, true); assert.equal(f.session.state, 'processing');
  t.mock.timers.tick(0);
  assert.equal(typedSignal.aborted, false); assert.equal(f.commands.running, true);
  assert.equal(f.session.state, 'processing'); assert.equal(f.calls.stops, 0);
  resume.resolve(); const report = await pending;
  assert.equal(report.reason, 'chat_answer'); assert.deepEqual(f.reminders, []);
  assert.equal(f.calls.chat.length, 1); assert.equal(f.session.state, 'stopped'); assert.equal(f.calls.stops, 0);
});
