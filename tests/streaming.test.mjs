import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AssemblyStream } from '../desktop/audio/streaming.mjs';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  send(value) { this.sent.push(value); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  message(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
function setup(options = {}) {
  const socket = new Socket();
  const events = [], errors = [];
  let request;
  const stream = new AssemblyStream({ apiKey: 'test-secret',
    createSocket: (url, config) => { request = { url, config }; return socket; },
    onTranscript: value => events.push(value), onError: value => errors.push(value), ...options });
  return { stream, socket, events, errors, get request() { return request; } };
}

test('auth is a header, start waits for Begin, early PCM is copied and bounded', async () => {
  const ctx = setup();
  const pending = ctx.stream.start();
  let resolved = false;
  pending.then(() => { resolved = true; });
  const samples = new Int16Array([123, -321]);
  assert.equal(ctx.stream.send(samples), true);
  samples[0] = 0;
  assert.equal(ctx.stream.send(Buffer.alloc(63_996)), true);
  assert.equal(ctx.stream.send(Buffer.alloc(2)), false);
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(ctx.socket.sent.length, 0);
  assert.equal(ctx.request.config.headers.Authorization, 'test-secret');
  assert.ok(!ctx.request.url.includes('test-secret'));
  assert.equal(new URL(ctx.request.url).searchParams.get('speech_model'), 'whisper-rt');
  assert.equal(new URL(ctx.request.url).searchParams.has('language_codes'), false);
  ctx.socket.message({ type: 'Begin' });
  await pending;
  assert.equal(ctx.socket.sent[0].readInt16LE(0), 123);
  assert.equal(ctx.socket.sent[0].readInt16LE(2), -321);
  ctx.stream.close();
});

test('partial updates deduplicate; only first final is emitted and stream terminates', async () => {
  const { stream, socket, events, errors } = setup();
  const pending = stream.start(); socket.message({ type: 'Begin' }); await pending;
  socket.message({ type: 'Turn', transcript: 'привет', end_of_turn: false });
  socket.message({ type: 'Turn', transcript: 'привет', end_of_turn: false });
  socket.message({ type: 'Turn', transcript: 'привет мир', end_of_turn: true });
  socket.message({ type: 'Turn', transcript: 'Привет, мир.', end_of_turn: true, turn_is_formatted: true });
  assert.deepEqual(events, [{ text: 'привет', final: false }, { text: 'привет мир', final: true }]);
  assert.equal(errors.length, 0);
  assert.equal(JSON.parse(socket.sent.at(-1)).type, 'Terminate');
  assert.equal(stream.send(Buffer.alloc(2)), false);
});

test('finish before Begin flushes audio then forces endpoint once', async () => {
  const { stream, socket } = setup();
  const pending = stream.start();
  stream.send(Buffer.alloc(3200)); stream.finish();
  assert.equal(stream.send(Buffer.alloc(2)), false);
  socket.message({ type: 'Begin' }); await pending; stream.finish();
  assert.equal(socket.sent.length, 2);
  assert.equal(JSON.parse(socket.sent[1]).type, 'ForceEndpoint');
  stream.close();
});

test('provider errors never expose raw details and reject pending start', async () => {
  const { stream, socket, errors } = setup();
  const pending = stream.start();
  socket.message({ type: 'Error', error: 'private text test-secret' });
  await assert.rejects(pending, error => !error.message.includes('test-secret'));
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes('private'));
  socket.emit('error', new Error('test-secret'));
  assert.equal(errors.length, 1);
});

test('connect and utterance deadlines close stalled streams', async () => {
  const first = setup({ connectTimeoutMs: 10 });
  await assert.rejects(first.stream.start());
  assert.equal(first.stream.state, 'closed');
  const second = setup({ maxSessionMs: 10 });
  const pending = second.stream.start(); second.socket.message({ type: 'Begin' }); await pending;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(second.stream.state, 'closed');
  assert.equal(second.errors.length, 1);
  second.socket.message({ type: 'Turn', transcript: 'truncated command', end_of_turn: true });
  assert.equal(second.events.length, 0);
});

test('universal profile sends explicit language steering', async () => {
  const ctx = setup({ model: 'universal-3-5-pro' });
  const pending = ctx.stream.start();
  assert.equal(new URL(ctx.request.url).searchParams.get('language_codes'), '["ru"]');
  ctx.socket.message({ type: 'Begin' }); await pending; ctx.stream.close();
});

test('socket backlog stops transmission, cancellation and empty final are safe', async () => {
  const ctx = setup();
  const pending = ctx.stream.start(); ctx.socket.message({ type: 'Begin' }); await pending;
  ctx.socket.bufferedAmount = 64_001;
  assert.equal(ctx.stream.send(Buffer.alloc(2)), false);
  assert.equal(ctx.errors.length, 1);
  const empty = setup();
  const other = empty.stream.start(); empty.socket.message({ type: 'Begin' }); await other;
  empty.socket.message({ type: 'Turn', transcript: '', end_of_turn: true });
  assert.deepEqual(empty.events, [{ text: '', final: true }]);
  const cancelled = setup();
  const starting = cancelled.stream.start(); cancelled.stream.close();
  await assert.rejects(starting);
});
