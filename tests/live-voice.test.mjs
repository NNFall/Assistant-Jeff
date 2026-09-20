import test from 'node:test';
import assert from 'node:assert/strict';
import { BatchVoiceController } from '../desktop/audio/batch-controller.mjs';
import { MAX_UTTERANCE_SAMPLES, PRE_ROLL_SAMPLES, SAMPLE_RATE, WAKE_FRAME_SAMPLES } from '../desktop/audio/utterance.mjs';

const pcm = (length, value = 0) => new Int16Array(length).fill(value);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let index = 0; index < 50 && !predicate(); index++) await tick();
  assert.ok(predicate(), 'Expected live voice transition');
}
function feed(controller, samples, value = 0) {
  while (samples > 0) {
    const count = Math.min(SAMPLE_RATE, samples);
    assert.equal(controller.accept(pcm(count, value)), true);
    samples -= count;
  }
}
function flatten(chunks) { return Int16Array.from(chunks.flatMap(chunk => [...chunk])); }

function harness(overrides = {}) {
  const events = [], transcripts = [], streams = [], settings = { cloudEnabled: true, transcriptionMode: 'live' };
  let batchCalls = 0;
  const controller = new BatchVoiceController({
    createWake: async () => ({ accept: async () => ({ triggered: false }), reset() {}, async close() {} }),
    encodeMp3: async () => { batchCalls++; return Buffer.from('mp3'); },
    transcribe: async () => { batchCalls++; return 'открой браузер'; },
    createTranscriptionStream: options => {
      const stream = { options, sent: [], queued: [], started: 0, finished: 0, closed: 0, connected: false,
        async start() { this.started++; this.connected = true; },
        send(audio) { this.sent.push(audio.slice()); if (!this.connected) this.queued.push(audio.slice()); return true; },
        async finish() { this.finished++; return { text: 'Джарвис, открой браузер', model: 'fake-live', latencyMs: 10 }; },
        close() { this.closed++; for (const audio of this.queued) audio.fill(0); this.queued = []; },
      };
      streams.push(stream);
      return stream;
    },
    onTranscript: async (text, options) => transcripts.push({ text, options }),
    emit: event => events.push(event), getSettings: () => settings,
    ...overrides,
  });
  return { controller, events, transcripts, streams, settings, get batchCalls() { return batchCalls; } };
}

test('waiting never opens cloud; activation queues the exact opening while connection is pending', async t => {
  const ready = deferred(), h = harness();
  const create = h.controller.createTranscriptionStream;
  h.controller.createTranscriptionStream = options => {
    const stream = create(options);
    stream.start = async function() { this.started++; await ready.promise; this.connected = true; };
    return stream;
  };
  t.after(() => h.controller.stop());
  await h.controller.start({ manual: true });
  const before = Int16Array.from({ length: 16000 }, (_, index) => index % 100);
  h.controller.accept(before);
  assert.equal(h.streams.length, 0);
  assert.equal(h.controller.activate(), true);
  const stream = h.streams[0];
  assert.equal(stream.started, 1);
  assert.equal(stream.connected, false);
  const opening = pcm(3200, 2400);
  h.controller.accept(opening); opening.fill(-1);
  assert.deepEqual(flatten(stream.queued), Int16Array.from([...before.slice(-PRE_ROLL_SAMPLES), ...pcm(3200, 2400)]));
  const finishing = h.controller.finish();
  assert.equal(stream.finished, 0);
  assert.equal(h.transcripts.length, 0);
  ready.resolve();
  assert.equal(await finishing, true);
  assert.equal(stream.finished, 1);
  assert.equal(stream.closed, 1);
  assert.equal(h.transcripts.length, 1);
  assert.equal(h.transcripts[0].text, 'открой браузер');
  assert.equal(h.batchCalls, 0);
});

test('delayed wake detection streams pre-roll plus already captured command exactly once', async t => {
  const wake = deferred(), h = harness({ createWake: async () => ({ accept: () => wake.promise, reset() {}, async close() {} }) });
  t.after(() => h.controller.stop());
  await h.controller.start();
  h.controller.accept(pcm(WAKE_FRAME_SAMPLES, 10));
  h.controller.accept(pcm(3840, 2200));
  assert.equal(h.streams.length, 0);
  wake.resolve({ triggered: true });
  await until(() => h.controller.state === 'recording');
  h.controller.accept(pcm(1280, 2500));
  assert.equal(await h.controller.finish(), true);
  assert.deepEqual(flatten(h.streams[0].sent), Int16Array.from([...pcm(WAKE_FRAME_SAMPLES, 10), ...pcm(3840, 2200), ...pcm(1280, 2500)]));
  assert.equal(h.transcripts[0].options.speechMs, 320);
  assert.equal(h.transcripts[0].options.preRollMs, 80);
});

test('exactly two seconds of silence finalizes once and does not stream the rest of the final frame', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  await h.controller.start({ manual: true }); h.controller.activate();
  h.controller.accept(pcm(3200, 1800));
  feed(h.controller, SAMPLE_RATE * 2 - 1);
  assert.equal(h.controller.state, 'recording');
  assert.equal(h.streams[0].finished, 0);
  h.controller.accept(pcm(1280));
  assert.equal(h.controller.accept(pcm(1280, 2000)), false);
  assert.equal(await h.controller.finish(), false);
  await until(() => h.transcripts.length === 1);
  assert.equal(flatten(h.streams[0].sent).length, 35200);
  assert.equal(h.transcripts[0].options.durationMs, 2200);
  assert.equal(h.transcripts[0].options.reason, 'silence');
  assert.equal(h.streams[0].finished, 1);
});

test('partial and provider-final callbacks are display-only until finish returns the sole final command', async t => {
  const final = deferred(), h = harness(); t.after(() => h.controller.stop());
  await h.controller.start({ manual: true }); h.controller.activate();
  const stream = h.streams[0]; stream.finish = async () => { stream.finished++; return final.promise; };
  h.controller.accept(pcm(3200, 1800));
  stream.options.onTranscript({ text: 'Джарвис, открой', final: false });
  stream.options.onTranscript({ text: 'Джарвис, удали заметку', final: true });
  assert.equal(h.transcripts.length, 0);
  assert.ok(h.events.filter(event => event.type === 'transcript').every(event => !event.final && !event.autoExecute));
  const finishing = h.controller.finish();
  await until(() => stream.finished === 1);
  assert.equal(h.transcripts.length, 0);
  final.resolve({ text: 'Джарвис, открой браузер' });
  assert.equal(await finishing, true);
  assert.equal(h.transcripts.length, 1);
  assert.equal(h.transcripts[0].text, 'открой браузер');
  assert.equal(h.events.filter(event => event.type === 'transcript' && event.final).length, 1);
  stream.options.onTranscript({ text: 'поздний текст' });
  assert.equal(h.events.at(-1).state, 'waiting');
});

test('stop while connecting clears queued audio and suppresses late readiness and callbacks', async () => {
  const ready = deferred(), h = harness(), create = h.controller.createTranscriptionStream;
  h.controller.createTranscriptionStream = options => { const stream = create(options); stream.start = () => ready.promise; return stream; };
  await h.controller.start({ manual: true }); h.controller.activate(); h.controller.accept(pcm(3200, 1800));
  const stream = h.streams[0], queued = stream.queued[0], finishing = h.controller.finish();
  await h.controller.stop();
  const stoppedAt = h.events.length;
  assert.equal(stream.options.signal.aborted, true);
  assert.equal(stream.closed, 1);
  assert.ok(queued.every(value => value === 0));
  stream.options.onTranscript({ text: 'поздняя команда' });
  stream.options.onMetrics({ latencyMs: 1 });
  ready.resolve();
  assert.equal(await finishing, false);
  assert.equal(h.events.length, stoppedAt);
  assert.equal(stream.finished, 0);
  assert.equal(h.transcripts.length, 0);
});

test('stop during finalization aborts stream and ignores a provider that returns a late final', async () => {
  const final = deferred(), h = harness();
  await h.controller.start({ manual: true }); h.controller.activate(); h.controller.accept(pcm(3200, 1800));
  const stream = h.streams[0]; stream.finish = () => { stream.finished++; return final.promise; };
  const finishing = h.controller.finish(); await until(() => stream.finished === 1);
  await h.controller.stop(); const stoppedAt = h.events.length;
  final.resolve({ text: 'выполни позднюю команду' });
  assert.equal(await finishing, false);
  assert.equal(stream.closed, 1);
  assert.equal(stream.options.signal.aborted, true);
  assert.equal(h.transcripts.length, 0);
  assert.equal(h.events.length, stoppedAt);
});

test('connection failure never executes a preview or silently falls back to batch', async t => {
  const h = harness(), create = h.controller.createTranscriptionStream;
  h.controller.createTranscriptionStream = options => {
    const stream = create(options);
    stream.start = async () => { options.onTranscript({ text: 'промежуточная команда' }); throw Object.assign(new Error('PRIVATE upstream details'), { code: 'LIVE_CONNECTION_FAILED' }); };
    return stream;
  };
  t.after(() => h.controller.stop());
  await h.controller.start({ manual: true }); h.controller.activate(); h.controller.accept(pcm(3200, 1800));
  await tick();
  assert.equal(await h.controller.finish(), false);
  assert.equal(h.controller.state, 'error');
  assert.equal(h.streams[0].closed, 1);
  assert.equal(h.transcripts.length, 0);
  assert.equal(h.batchCalls, 0);
  assert.ok(h.events.some(event => event.code === 'LIVE_CONNECTION_FAILED'));
  assert.equal(JSON.stringify(h.events).includes('PRIVATE'), false);
});

test('a rejected audio frame fails the utterance instead of executing an incomplete transcript', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  await h.controller.start({ manual: true }); h.controller.activate();
  h.streams[0].send = () => false;
  h.controller.accept(pcm(3200, 1800));
  assert.equal(h.controller.recorder.length, 3200);
  assert.equal(await h.controller.finish(), false);
  assert.equal(h.streams[0].finished, 0);
  assert.equal(h.streams[0].closed, 1);
  assert.equal(h.transcripts.length, 0);
  assert.equal(h.batchCalls, 0);
  assert.ok(h.events.some(event => event.code === 'LIVE_AUDIO_REJECTED'));
});

test('live cloud audio retains the same bounded 30-second recording including pre-roll', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  await h.controller.start({ manual: true }); h.controller.accept(pcm(PRE_ROLL_SAMPLES, 10)); h.controller.activate();
  feed(h.controller, SAMPLE_RATE * 30, 1800);
  await until(() => h.transcripts.length === 1);
  assert.equal(flatten(h.streams[0].sent).length, MAX_UTTERANCE_SAMPLES);
  assert.equal(h.transcripts[0].options.reason, 'max_duration');
  assert.equal(h.transcripts[0].options.durationMs, 30000);
});

test('no speech closes its activated stream without requesting a final command', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  await h.controller.start({ manual: true }); h.controller.activate();
  feed(h.controller, SAMPLE_RATE * 8);
  await until(() => h.controller.state === 'waiting');
  assert.equal(h.streams[0].finished, 0);
  assert.equal(h.streams[0].closed, 1);
  assert.equal(h.transcripts.length, 0);
});

test('cloud gate applies both before activation and if disabled during the current recording', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  h.settings.cloudEnabled = false;
  await h.controller.start({ manual: true }); h.controller.activate(); h.controller.accept(pcm(3200, 1800));
  assert.equal(h.streams.length, 0);
  assert.equal(await h.controller.finish(), false);
  h.settings.cloudEnabled = true;
  await h.controller.start({ manual: true }); h.controller.activate(); h.controller.accept(pcm(3200, 1800));
  h.settings.cloudEnabled = false; h.controller.accept(pcm(1280, 1800));
  assert.equal(h.streams[0].sent.length, 1);
  assert.equal(await h.controller.finish(), false);
  assert.equal(h.transcripts.length, 0);
  assert.equal(h.streams[0].closed, 1);
});

test('callbacks from a completed utterance cannot overwrite the next recording in the same wake session', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  await h.controller.start(); h.controller.activate(); h.controller.accept(pcm(3200, 1800));
  await h.controller.finish();
  const old = h.streams[0]; h.controller.activate();
  const before = h.events.length;
  old.options.onTranscript({ text: 'старое распознавание' }); old.options.onMetrics({ totalMs: 0 });
  assert.equal(h.events.length, before);
  assert.equal(h.controller.state, 'recording');
  h.controller.accept(pcm(3200, 1800)); await h.controller.finish();
  assert.equal(h.transcripts.length, 2);
});

test('latency metrics distinguish connection, first partial and endpoint-to-final time', async t => {
  let now = 100;
  const final = deferred(), h = harness({ now: () => now }); t.after(() => h.controller.stop());
  await h.controller.start({ manual: true }); h.controller.activate();
  now = 120; await tick();
  h.controller.accept(pcm(3200, 1800));
  now = 150; h.streams[0].options.onTranscript({ text: 'открой' });
  now = 180; h.streams[0].options.onTranscript({ text: 'открой браузер' });
  h.streams[0].finish = () => { h.streams[0].finished++; return final.promise; };
  now = 200; const finishing = h.controller.finish(); await until(() => h.streams[0].finished === 1);
  now = 275; final.resolve({ text: 'открой браузер', model: 'fake-live', latencyMs: 75 }); await finishing;
  const metrics = h.events.find(event => event.type === 'transcription_metrics' && event.endToFinalMs !== undefined);
  assert.equal(metrics.firstPartialMs, 50);
  assert.equal(metrics.providerReadyMs, 20);
  assert.equal(metrics.endToFinalMs, 75);
  assert.equal(metrics.totalMs, 175);
  assert.equal(metrics.bytes, 6400);
});
