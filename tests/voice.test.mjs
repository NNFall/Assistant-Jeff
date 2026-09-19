import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../desktop/audio/controller.mjs';
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(overrides = {}) {
  const events = [], commands = [], streams = [];
  const wake = { accept: async () => ({ triggered: false }), reset() {}, async close() { this.closed = true; } };
  const settings = { cloudEnabled: true, speakReplies: false, wakeWord: 'hey_jarvis', wakeThreshold: .5 };
  const controller = new VoiceController({ modelsDir: 'mock', getSettings: () => settings,
    getAssemblyKey: async () => 'mock-key', emit: e => events.push(e),
    onCommand: async text => { commands.push(text); return 'Готово'; }, createWake: async () => wake,
    createStream: options => { const stream = { options, begin: defer(), sent: [], start() { return this.begin.promise; },
      send(pcm) { this.sent.push(pcm); return true; }, finish() { this.finished = true; }, close() { this.closed = true; } };
      streams.push(stream); return stream; }, ...overrides });
  return { controller, events, streams, wake, settings, commands };
}

test('explicit start loads wake without cloud; beep only follows Begin; final executes once', async () => {
  const x = setup(); await x.controller.start();
  assert.equal(x.controller.state, 'waiting'); assert.equal(x.streams.length, 0);
  const activation = x.controller.activate(); await tick();
  assert.equal(x.streams[0].options.model, 'whisper-rt');
  assert.equal(x.events.some(e => e.type === 'wake'), false);
  x.streams[0].begin.resolve(); await activation;
  assert.equal(x.controller.state, 'listening');
  assert.equal(await x.controller.accept(new Int16Array(1280)), false);
  x.controller.mutedUntil = 0;
  assert.equal(await x.controller.accept(new Int16Array(1280)), true);
  x.controller.finish(); assert.equal(x.streams[0].finished, true);
  x.streams[0].options.onTranscript({ text: 'заметка тест', final: true });
  x.streams[0].options.onTranscript({ text: 'дубликат', final: true }); await tick();
  assert.deepEqual(x.commands, ['заметка тест']); assert.equal(x.controller.state, 'waiting');
  await x.controller.stop();
});

test('slow inference drops new frames and stop waits before closing wake', async () => {
  const slow = defer(); const x = setup(); x.wake.accept = () => slow.promise;
  await x.controller.start(); const accepted = x.controller.accept(new Int16Array(1280)); await tick();
  for (let i = 0; i < 100; i++) assert.equal(await x.controller.accept(new Int16Array(1280)), false);
  const stopped = x.controller.stop(); assert.equal(x.wake.closed, undefined);
  slow.resolve({ triggered: true }); await accepted; await stopped;
  assert.equal(x.wake.closed, true); assert.equal(x.streams.length, 0); assert.equal(x.controller.state, 'off');
});

test('stopped key retrieval and stopped stream connection cannot wake or restart', async () => {
  const key = defer(); const x = setup({ getAssemblyKey: () => key.promise });
  await x.controller.start(); const activation = x.controller.activate(); await x.controller.stop();
  key.resolve('mock'); await activation; assert.equal(x.streams.length, 0);
  const y = setup(); await y.controller.start(); const other = y.controller.activate(); await tick();
  await y.controller.stop(); y.streams[0].begin.resolve(); await other;
  assert.equal(y.controller.state, 'off'); assert.equal(y.events.some(e => e.type === 'wake'), false);
});

test('cloud off or missing key never creates a stream', async () => {
  const x = setup(); x.settings.cloudEnabled = false; await x.controller.start(); await x.controller.activate();
  assert.equal(x.streams.length, 0); assert.equal(x.controller.state, 'error'); await x.controller.stop();
  const y = setup({ getAssemblyKey: async () => '' }); await y.controller.start(); await y.controller.activate();
  assert.equal(y.streams.length, 0); await y.controller.stop();
});

test('stop during command prevents speech; stop during wake load disposes stale detector', async () => {
  const command = defer(); let speech = 0; const x = setup({ onCommand: () => command.promise, speak: async () => { speech++; } });
  x.settings.speakReplies = true; await x.controller.start();
  const activation = x.controller.activate(); await tick(); x.streams[0].begin.resolve(); await activation;
  x.streams[0].options.onTranscript({ text: 'тест', final: true });
  assert.equal(await x.controller.accept(new Int16Array(1280)), false);
  await x.controller.stop(); command.resolve('ответ'); await tick();
  assert.equal(speech, 0); assert.equal(x.controller.state, 'off');
  const loading = defer(); const y = setup({ createWake: () => loading.promise }); const started = y.controller.start();
  const stopped = y.controller.stop(); loading.resolve(y.wake); await started; await stopped;
  assert.equal(y.wake.closed, true); assert.equal(y.controller.state, 'off');
});

test('stop aborts in-flight command signal and prevents delayed local effects', async () => {
  const pendingCommand = defer(); let signal; let effects = 0;
  const x = setup({ onCommand: async (_text, options) => {
    signal = options.signal;
    await pendingCommand.promise;
    if (!signal.aborted) effects++;
    return 'Готово';
  } });
  x.settings.streamingModel = 'universal-3-5-pro';
  await x.controller.start(); const activating = x.controller.activate(); await tick();
  assert.equal(x.streams[0].options.model, 'universal-3-5-pro');
  x.streams[0].begin.resolve(); await activating;
  x.streams[0].options.onTranscript({ text: 'поставь таймер', final: true });
  assert.equal(signal.aborted, false);
  await x.controller.stop(); assert.equal(signal.aborted, true);
  pendingCommand.resolve(); await tick();
  assert.equal(effects, 0); assert.equal(x.controller.state, 'off');
});

test('announcements restore waiting/off after speech without activating microphone', async () => {
  const spoken = [];
  const x = setup({ speak: async text => spoken.push(text) });
  x.settings.speakReplies = true;
  assert.equal(await x.controller.announce('напоминание'), true);
  assert.equal(x.controller.state, 'off'); assert.equal(x.streams.length, 0);
  await x.controller.start();
  const announcement = x.controller.announce('таймер');
  assert.equal(x.controller.state, 'speaking');
  assert.equal(await x.controller.accept(new Int16Array(1280)), false);
  assert.equal(await x.controller.announce('очередь'), false);
  await announcement;
  assert.equal(x.controller.state, 'waiting');
  assert.deepEqual(spoken, ['напоминание', 'таймер']);
  assert.equal(x.streams.length, 0); await x.controller.stop();
});

test('announcement waits inference, disabled speech is silent, stop prevents resume', async () => {
  let spoken = 0;
  const x = setup({ speak: async () => { spoken++; } });
  assert.equal(await x.controller.announce('тихо'), true); assert.equal(spoken, 0);
  x.settings.speakReplies = true;
  const inference = defer(); x.wake.accept = () => inference.promise;
  let resets = 0; x.wake.reset = () => { resets++; };
  await x.controller.start(); const accepting = x.controller.accept(new Int16Array(1280));
  const announced = x.controller.announce('тест'); await tick();
  assert.equal(spoken, 0); assert.equal(resets, 0);
  const stopped = x.controller.stop(); inference.resolve({ triggered: true });
  await accepting; await announced; await stopped;
  assert.equal(spoken, 0); assert.equal(x.controller.state, 'off');
  const speech = defer(); const y = setup({ speak: () => speech.promise });
  y.settings.speakReplies = true;
  const pending = y.controller.announce('тест'); await tick();
  await y.controller.stop(); speech.resolve(); await pending;
  assert.equal(y.controller.state, 'off');
});
