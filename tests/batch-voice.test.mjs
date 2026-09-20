import test from 'node:test';
import assert from 'node:assert/strict';
import { BatchVoiceController } from '../desktop/audio/batch-controller.mjs';
import {
  SampleRing, UtteranceRecorder, PRE_ROLL_SAMPLES, MAX_UTTERANCE_SAMPLES,
  SAMPLE_RATE, WAKE_FRAME_SAMPLES, validPcm, stripWakePrefix,
} from '../desktop/audio/utterance.mjs';

const pcm = (samples, value = 0) => new Int16Array(samples).fill(value);
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 30 && !predicate(); i++) await turn();
  assert.ok(predicate(), 'Expected asynchronous state was not reached');
}
function feed(target, samples, value = 0) {
  while (samples) {
    const count = Math.min(SAMPLE_RATE, samples);
    assert.equal(target.accept(pcm(count, value)), true);
    samples -= count;
  }
}
function harness(overrides = {}) {
  const events = [];
  const encoded = [];
  const requests = [];
  const transcripts = [];
  const controller = new BatchVoiceController({
    createWake: async () => ({ accept: async () => ({ triggered: false }), reset() {}, async close() {} }),
    encodeMp3: async (audio, options) => {
      encoded.push({ audio: audio.slice(), options });
      return Buffer.from('test mp3');
    },
    transcribe: async (audio, options) => {
      requests.push({ audio, options });
      return 'Jarvis, открой браузер';
    },
    onTranscript: async (text, options) => { transcripts.push({ text, options }); },
    emit: event => events.push(event),
    getSettings: () => ({ cloudEnabled: true }),
    ...overrides,
  });
  return { controller, events, encoded, requests, transcripts };
}
async function manual(h) {
  await h.controller.start({ manual: true });
  assert.equal(h.controller.activate(), true);
}

test('PCM input accepts exactly Int16 chunks of 1 through 16000 samples', async () => {
  const h = harness();
  await h.controller.start({ manual: true });
  for (const input of [pcm(1), pcm(1280), pcm(16000)]) {
    assert.equal(validPcm(input), true);
    assert.equal(h.controller.accept(input), true);
  }
  for (const input of [pcm(0), pcm(16001), new Float32Array(1280), Buffer.alloc(1280), [1, 2], null]) {
    assert.equal(validPcm(input), false);
    assert.equal(h.controller.accept(input), false);
  }
  await h.controller.stop();
  assert.equal(h.controller.accept(pcm(1280)), false);
});

test('PCM ring retains precisely the last 700 ms in order and owns its copies', () => {
  const ring = new SampleRing();
  const first = Int16Array.from({ length: 16000 }, (_, index) => index);
  ring.push(first);
  const expected = first.slice(first.length - PRE_ROLL_SAMPLES);
  first.fill(-1);
  assert.deepEqual(ring.snapshot(), expected);
  const snapshot = ring.snapshot();
  snapshot.fill(-2);
  assert.deepEqual(ring.snapshot(), expected);
  ring.push(pcm(300, 30000));
  assert.deepEqual(ring.snapshot().slice(0, -300), expected.slice(300));
  assert.deepEqual(ring.snapshot().slice(-300), pcm(300, 30000));
  ring.clear();
  assert.equal(ring.snapshot().length, 0);
  assert.ok(ring.data.every(value => value === 0));
});

test('manual activation retains 700 ms pre-roll and the first command frame without streaming to cloud', async () => {
  const h = harness();
  await h.controller.start({ manual: true });
  const before = Int16Array.from({ length: 16000 }, (_, index) => index % 120);
  assert.equal(h.controller.accept(before), true);
  assert.equal(h.controller.activate(), true);
  const firstCommand = pcm(3200, 1400);
  assert.equal(h.controller.accept(firstCommand), true);
  firstCommand.fill(-1);
  assert.equal(h.encoded.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.transcripts.length, 0);
  assert.equal(await h.controller.finish(), true);
  assert.deepEqual(h.encoded[0].audio.slice(0, PRE_ROLL_SAMPLES), before.slice(-PRE_ROLL_SAMPLES));
  assert.deepEqual(h.encoded[0].audio.slice(PRE_ROLL_SAMPLES), pcm(3200, 1400));
  assert.equal(h.encoded[0].options.sampleRate, 16000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.transcripts[0].text, 'открой браузер');
  await h.controller.stop();
});

test('speech arriving during asynchronous wake detection is retained and counts as command speech', async () => {
  const inference = deferred();
  let calls = 0;
  const h = harness({ createWake: async () => ({
    accept: () => { calls++; return inference.promise; }, reset() {}, async close() {},
  }) });
  await h.controller.start();
  h.controller.accept(pcm(WAKE_FRAME_SAMPLES));
  assert.equal(calls, 1);
  h.controller.accept(pcm(3840, 2400));
  assert.equal(h.controller.snapshot().state, 'waiting');
  assert.equal(h.requests.length, 0);
  inference.resolve({ triggered: true });
  await until(() => h.controller.snapshot().state === 'recording');
  feed(h.controller, SAMPLE_RATE * 2.5);
  await until(() => h.controller.snapshot().state === 'waiting');
  assert.equal(h.requests.length, 1);
  assert.equal(h.transcripts.length, 1);
  assert.deepEqual(h.encoded[0].audio.slice(WAKE_FRAME_SAMPLES, WAKE_FRAME_SAMPLES + 3840), pcm(3840, 2400));
  assert.equal(h.transcripts[0].options.reason, 'silence');
  await h.controller.stop();
});

test('pending wake frames are bounded when inference is slow', async () => {
  const inference = deferred();
  let calls = 0;
  const h = harness({ createWake: async () => ({
    accept: () => ++calls === 1 ? inference.promise : Promise.resolve({ triggered: false }),
    reset() {}, async close() {},
  }) });
  await h.controller.start();
  for (let i = 0; i < 100; i++) h.controller.accept(pcm(WAKE_FRAME_SAMPLES, i));
  assert.equal(calls, 1);
  assert.ok(h.controller.wakeFrames.length <= 6);
  assert.equal(h.controller.ring.snapshot().length, PRE_ROLL_SAMPLES);
  inference.resolve({ triggered: false });
  await until(() => h.controller.inference === null);
  assert.ok(calls <= 7, `Unbounded inference backlog: ${calls}`);
  assert.equal(h.requests.length, 0);
  await h.controller.stop();
});

test('a stale wake trigger cannot execute a command whose initial audio has left pre-roll', async () => {
  const inference = deferred();
  let calls = 0;
  const h = harness({ createWake: async () => ({
    accept: () => ++calls === 1 ? inference.promise : Promise.resolve({ triggered: false }),
    reset() {}, async close() {},
  }) });
  await h.controller.start();
  h.controller.accept(pcm(WAKE_FRAME_SAMPLES));
  h.controller.accept(pcm(PRE_ROLL_SAMPLES + 1, 2400));
  inference.resolve({ triggered: true });
  await until(() => h.controller.inference === null);
  assert.equal(h.controller.snapshot().state, 'waiting');
  assert.equal(h.events.filter(event => event.type === 'wake').length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.transcripts.length, 0);
  await h.controller.stop();
});

test('eight seconds with no command speech ends locally and never calls cloud', async () => {
  const h = harness();
  await h.controller.start({ manual: true });
  // Even a loud wake-name pre-roll is not evidence of a spoken command.
  h.controller.accept(pcm(PRE_ROLL_SAMPLES, 4000));
  h.controller.activate();
  feed(h.controller, SAMPLE_RATE * 8 - 1);
  assert.equal(h.controller.snapshot().state, 'recording');
  h.controller.accept(pcm(1));
  await until(() => h.controller.snapshot().state === 'waiting');
  assert.equal(h.encoded.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.transcripts.length, 0);
  assert.ok(h.events.some(event => event.reason === 'no_speech'));
  await h.controller.stop();
});

test('at least 200 ms speech is required, and exactly 200 ms is accepted', async () => {
  const h = harness();
  await manual(h);
  h.controller.accept(pcm(3199, 1200));
  assert.equal(await h.controller.finish(), false);
  assert.equal(h.requests.length, 0);
  h.controller.activate();
  h.controller.accept(pcm(3200, 1200));
  assert.equal(await h.controller.finish(), true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.transcripts[0].options.speechMs, 200);
  await h.controller.stop();
});

test('default silence timeout is precisely 2500 ms after speech, not while speech continues', () => {
  const recorder = new UtteranceRecorder();
  recorder.accept(pcm(3200, 1200));
  feed(recorder, SAMPLE_RATE * 2.5 - 1);
  assert.equal(recorder.complete, false);
  recorder.accept(pcm(1));
  assert.equal(recorder.complete, true);
  assert.equal(recorder.metadata().reason, 'silence');
  assert.equal(recorder.metadata().durationMs, 2700);
  assert.equal(recorder.take().length, 43200);
});

test('silence countdown resets when the user continues speaking', () => {
  const recorder = new UtteranceRecorder();
  recorder.accept(pcm(3200, 1200));
  feed(recorder, SAMPLE_RATE * 2);
  recorder.accept(pcm(1280, 1200));
  feed(recorder, SAMPLE_RATE * 2);
  assert.equal(recorder.complete, false);
  recorder.accept(pcm(8000));
  assert.equal(recorder.metadata().reason, 'silence');
});

test('recording is bounded to 30 seconds including pre-roll and releases retained PCM', () => {
  const recorder = new UtteranceRecorder({ preRoll: pcm(PRE_ROLL_SAMPLES, 1) });
  feed(recorder, SAMPLE_RATE * 30, 2000);
  assert.equal(recorder.complete, true);
  assert.equal(recorder.metadata().reason, 'max_duration');
  assert.equal(recorder.metadata().durationMs, 30000);
  const audio = recorder.take();
  assert.equal(audio.length, MAX_UTTERANCE_SAMPLES);
  assert.deepEqual(audio.slice(0, PRE_ROLL_SAMPLES), pcm(PRE_ROLL_SAMPLES, 1));
  assert.ok(recorder.data.every(value => value === 0));
  assert.equal(recorder.accept(pcm(1)), false);
});

test('manual finish delivers one final command despite double finish and late frames', async () => {
  const transcription = deferred();
  const h = harness({ transcribe: () => transcription.promise });
  await manual(h);
  h.controller.accept(pcm(3200, 1600));
  const finishing = h.controller.finish();
  assert.equal(await h.controller.finish(), false);
  assert.equal(h.controller.accept(pcm(3200, 1700)), false);
  transcription.resolve('Эй, Джарвис, открой диспетчер задач');
  await finishing;
  assert.equal(h.encoded.length, 1);
  assert.equal(h.transcripts.length, 1);
  assert.equal(h.transcripts[0].text, 'открой диспетчер задач');
  assert.equal(h.events.filter(event => event.type === 'transcript').length, 1);
  await h.controller.stop();
});

test('stopping during transcription aborts the request and suppresses a late transcript', async () => {
  const transcription = deferred();
  let requestSignal;
  const h = harness({ transcribe: (audio, { signal }) => { requestSignal = signal; return transcription.promise; } });
  await manual(h);
  h.controller.accept(pcm(3200, 1600));
  const finishing = h.controller.finish();
  await until(() => !!requestSignal);
  await h.controller.stop();
  assert.equal(requestSignal.aborted, true);
  assert.equal(h.controller.accept(pcm(16000, 2000)), false);
  transcription.resolve('открой браузер');
  assert.equal(await finishing, false);
  assert.equal(h.transcripts.length, 0);
  assert.equal(h.events.filter(event => event.type === 'transcript').length, 0);
  assert.equal(h.controller.snapshot().state, 'stopped');
});

test('stopping during encoding clears its PCM and prevents a late cloud request', async () => {
  const encoding = deferred();
  let ownedAudio;
  let encoderSignal;
  const h = harness({ encodeMp3: (audio, { signal }) => {
    ownedAudio = audio;
    encoderSignal = signal;
    return encoding.promise;
  } });
  await manual(h);
  h.controller.accept(pcm(3200, 1600));
  const finishing = h.controller.finish();
  assert.ok(ownedAudio.some(value => value !== 0));
  await h.controller.stop();
  assert.equal(encoderSignal.aborted, true);
  assert.ok(ownedAudio.every(value => value === 0));
  encoding.resolve(Buffer.from('late MP3'));
  assert.equal(await finishing, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.transcripts.length, 0);
});

test('stopping during local model loading closes the late detector once without activating', async () => {
  const loading = deferred();
  let closeCalls = 0;
  const h = harness({ createWake: () => loading.promise });
  const starting = h.controller.start();
  const stopping = h.controller.stop();
  assert.equal(h.controller.snapshot().state, 'stopped');
  assert.equal(h.controller.accept(pcm(1280, 1600)), false);
  loading.resolve({ accept: async () => ({ triggered: true }), reset() {}, async close() { closeCalls++; } });
  await Promise.all([starting, stopping]);
  assert.equal(closeCalls, 1);
  assert.equal(h.controller.snapshot().state, 'stopped');
  assert.equal(h.requests.length, 0);
});

test('wake prefix stripping is anchored and preserves names within ordinary commands', () => {
  for (const [input, expected] of [
    [' Jarvis, открой браузер ', 'открой браузер'],
    ['hey Jarvis: open Chrome', 'open Chrome'],
    ['Джарвис — открой диспетчер задач', 'открой диспетчер задач'],
    ['Хей Джарвис! найди вкладку', 'найди вкладку'],
    ['Эй, Джарвис, открой диспетчер задач', 'открой диспетчер задач'],
    ['Hey, Jarvis: open Chrome', 'open Chrome'],
    ['открой приложение Jarvis', 'открой приложение Jarvis'],
    ['найди слово джарвис в тексте', 'найди слово джарвис в тексте'],
    ['JarvisAssistant открой', 'JarvisAssistant открой'],
    ['Jarvis', ''],
  ]) assert.equal(stripWakePrefix(input), expected);
  assert.equal(stripWakePrefix(null), '');
});

test('empty and oversized final transcripts never reach command execution', async () => {
  const replies = ['Jarvis!', 'а'.repeat(1025), 'а'.repeat(1024)];
  const h = harness({ transcribe: async () => replies.shift() });
  await h.controller.start({ manual: true });
  for (let index = 0; index < 3; index++) {
    h.controller.activate();
    h.controller.accept(pcm(3200, 1600));
    assert.equal(await h.controller.finish(), index === 2);
  }
  assert.equal(h.transcripts.length, 1);
  assert.equal(h.transcripts[0].text.length, 1024);
  assert.ok(h.events.some(event => event.code === 'EMPTY_TRANSCRIPT'));
  assert.ok(h.events.some(event => event.code === 'TRANSCRIPT_TOO_LONG'));
  await h.controller.stop();
});

test('controller waits for execution and TTS before resuming wake listening and resets pre-roll', async () => {
  const spoken = deferred();
  let resetCalls = 0;
  let executions = 0;
  let inferenceCalls = 0;
  const h = harness({
    createWake: async () => ({
      accept: async () => { inferenceCalls++; return { triggered: false }; },
      reset() { resetCalls++; }, async close() {},
    }),
    onTranscript: () => { executions++; return spoken.promise; },
  });
  await h.controller.start();
  h.controller.accept(pcm(1280));
  await until(() => h.controller.inference === null);
  h.controller.activate();
  h.controller.accept(pcm(3200, 1600));
  const finishing = h.controller.finish();
  await until(() => executions === 1);
  assert.equal(h.controller.snapshot().state, 'ready');
  assert.equal(h.controller.accept(pcm(16000, 3000)), false, 'TTS output must not enter wake detector');
  assert.equal(h.controller.activate(), false);
  assert.equal(inferenceCalls, 1);
  assert.equal(resetCalls, 0);
  spoken.resolve();
  assert.equal(await finishing, true);
  assert.equal(h.controller.snapshot().state, 'waiting');
  assert.equal(resetCalls, 1);
  assert.equal(h.controller.ring.snapshot().length, 0);
  assert.equal(h.controller.wakeFrames.length, 0);
  assert.equal(h.controller.wakeTail.length, 0);
  await h.controller.stop();
});

test('cloud disabled is an enforced gate even if a command was recorded', async () => {
  const h = harness({ getSettings: () => ({ cloudEnabled: false }) });
  await manual(h);
  h.controller.accept(pcm(3200, 1600));
  assert.equal(await h.controller.finish(), false);
  assert.equal(h.encoded.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.transcripts.length, 0);
  await h.controller.stop();
});

test('start recovers after a processing error with a fresh signal and clean recording', async () => {
  let attempts = 0;
  let firstSignal;
  const h = harness({ transcribe: async (audio, { signal }) => {
    if (++attempts === 1) {
      firstSignal = signal;
      throw Object.assign(new Error('API-key secret must not be exposed'), { code: 'TRANSCRIBE_FAILED' });
    }
    return 'открой браузер';
  } });
  await manual(h);
  h.controller.accept(pcm(3200, 1600));
  assert.equal(await h.controller.finish(), false);
  assert.equal(h.controller.snapshot().state, 'error');
  assert.ok(!JSON.stringify(h.events).includes('API-key secret'));
  await h.controller.start({ manual: true });
  assert.equal(firstSignal.aborted, true);
  assert.equal(h.controller.snapshot().state, 'waiting');
  assert.equal(h.controller.ring.snapshot().length, 0);
  assert.equal(h.controller.activate(), true);
  h.controller.accept(pcm(3200, 2000));
  assert.equal(await h.controller.finish(), true);
  assert.equal(h.transcripts.length, 1);
  assert.equal(h.transcripts[0].options.signal.aborted, false);
  assert.deepEqual(h.encoded[1].audio, pcm(3200, 2000));
  await h.controller.stop();
});
