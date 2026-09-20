import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, request as requestHttp } from 'node:http';
import WebSocket from 'ws';
import { GeminiLiveStream } from '../desktop/providers/gemini-live.mjs';
import { attachLiveTranscription } from '../server/gemini-live.mjs';
import { createGatewayServer } from '../server/gateway.mjs';

const TOKEN = 'test-live-gateway-token';
const KEY = 'test-live-provider-key';
const MODEL = 'gemini-3.5-transcribe-live';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function until(predicate, message = 'Expected asynchronous event') {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  send(value, options, callback) {
    this.sent.push(typeof value === 'string' ? value : Buffer.from(value));
    (typeof options === 'function' ? options : callback)?.();
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
  terminate() { this.close(); }
  message(value) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
}

function client(t, options = {}) {
  const socket = new Socket();
  const events = [], metrics = [];
  let request;
  const stream = new GeminiLiveStream({
    connect: async () => ({ url: 'ws://127.0.0.1:43210/transcribe/live', token: TOKEN }),
    createSocket: (url, config) => { request = { url, config }; return socket; },
    onTranscript: value => events.push(value),
    onMetrics: value => metrics.push(value),
    ...options,
  });
  t.after(() => stream.close());
  return { stream, socket, events, metrics, get request() { return request; } };
}

async function ready(ctx) {
  const starting = ctx.stream.start();
  await until(() => ctx.request);
  ctx.socket.message({ type: 'ready', model: MODEL });
  await starting;
}

test('live client copies and preserves PCM before start, during connection, and until ready', async t => {
  const connecting = deferred();
  const ctx = client(t, { connect: () => connecting.promise });
  const first = new Int16Array([123, -321]);
  assert.equal(ctx.stream.send(first), true);
  first.fill(0);
  const starting = ctx.stream.start();
  assert.equal(ctx.stream.send(new Int16Array([456, -654])), true);
  assert.equal(ctx.socket.sent.length, 0);
  connecting.resolve({ url: 'ws://127.0.0.1:43210/transcribe/live', token: TOKEN });
  await until(() => ctx.request);
  assert.equal(ctx.stream.send(new Int16Array([789, -987])), true);
  assert.equal(ctx.socket.sent.length, 0);
  assert.equal(ctx.request.config.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!ctx.request.url.includes(TOKEN));
  ctx.socket.message({ type: 'ready', model: MODEL });
  await starting;
  const pcm = Buffer.concat(ctx.socket.sent.filter(Buffer.isBuffer));
  assert.deepEqual(Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2)), [123, -321, 456, -654, 789, -987]);
});

test('live client finish while connecting flushes audio before one finish message', async t => {
  const connecting = deferred();
  const ctx = client(t, { connect: () => connecting.promise });
  const starting = ctx.stream.start();
  assert.equal(ctx.stream.send(new Int16Array([42, -42])), true);
  const finishing = ctx.stream.finish();
  let complete = false;
  finishing.then(() => { complete = true; }, () => {});
  assert.equal(ctx.stream.send(new Int16Array([7])), false);
  connecting.resolve({ url: 'ws://127.0.0.1:43210/transcribe/live', token: TOKEN });
  await until(() => ctx.request);
  ctx.socket.message({ type: 'ready', model: MODEL });
  await starting;
  assert.equal(complete, false);
  assert.ok(Buffer.isBuffer(ctx.socket.sent[0]));
  assert.equal(ctx.socket.sent[0].readInt16LE(0), 42);
  assert.deepEqual(ctx.socket.sent.filter(value => typeof value === 'string').map(JSON.parse), [{ type: 'finish' }]);
  const again = ctx.stream.finish();
  ctx.socket.message({ type: 'result', text: 'Открой калькулятор.', model: MODEL, latencyMs: 17 });
  assert.equal((await finishing).text, 'Открой калькулятор.');
  assert.equal((await again).text, 'Открой калькулятор.');
  assert.equal(ctx.socket.sent.filter(value => typeof value === 'string').length, 1);
});

test('live client cancellation rejects unfinished text and ignores late final results', async t => {
  const abort = new AbortController();
  const ctx = client(t, { signal: abort.signal });
  await ready(ctx);
  ctx.socket.message({ type: 'transcript', text: 'Открой', final: false });
  assert.equal(ctx.events.at(-1).text, 'Открой');
  assert.equal(ctx.events.at(-1).final, false);
  const finishing = ctx.stream.finish();
  const rejected = assert.rejects(finishing, { code: 'ABORTED' });
  abort.abort();
  await rejected;
  ctx.socket.message({ type: 'result', text: 'Открой калькулятор', model: MODEL, latencyMs: 1 });
  assert.equal(ctx.events.filter(value => value.final).length, 0);
  assert.equal(ctx.socket.readyState, 3);
});

test('live client cancellation interrupts a pending gateway connection without opening a socket later', async t => {
  const connecting = deferred();
  const abort = new AbortController();
  const ctx = client(t, { signal: abort.signal, connect: () => connecting.promise });
  const starting = ctx.stream.start();
  const rejected = assert.rejects(starting, { code: 'ABORTED' });
  abort.abort();
  await rejected;
  connecting.resolve({ url: 'ws://127.0.0.1:43210/transcribe/live', token: TOKEN });
  await tick();
  assert.equal(ctx.request, undefined);
  assert.equal(ctx.socket.sent.length, 0);
});

test('live client limits preconnection audio to thirty seconds', t => {
  const ctx = client(t);
  for (let i = 0; i < 30; i++) assert.equal(ctx.stream.send(new Int16Array(16_000)), true);
  assert.equal(ctx.stream.send(new Int16Array(1)), false);
  assert.equal(ctx.socket.sent.length, 0);
});

test('live client rejects a premature result instead of promoting it into a completed command', async t => {
  const ctx = client(t);
  await ready(ctx);
  ctx.socket.message({ type: 'result', text: 'Ранний результат', model: MODEL, latencyMs: 1 });
  await assert.rejects(ctx.stream.finish(), { code: 'LIVE_PROTOCOL_ERROR' });
  assert.equal(ctx.events.some(value => value.final), false);
  assert.equal(ctx.metrics.length, 0);
});

test('live client deadlines reject a stalled connection and an unfinished partial', async t => {
  const neverConnects = client(t, { connect: () => new Promise(() => {}), connectTimeoutMs: 15 });
  await assert.rejects(neverConnects.stream.start(), { code: 'LIVE_CONNECT_TIMEOUT' });
  const ctx = client(t, { finishTimeoutMs: 15 });
  await ready(ctx);
  ctx.socket.message({ type: 'transcript', text: 'Незаконченная команда', final: false });
  await assert.rejects(ctx.stream.finish(), { code: 'LIVE_FINISH_TIMEOUT' });
  assert.equal(ctx.events.some(value => value.final), false);
});

test('live client fails on socket backpressure without returning its partial transcript', async t => {
  const ctx = client(t);
  await ready(ctx);
  ctx.socket.message({ type: 'transcript', text: 'Незаконченная команда', final: false });
  ctx.socket.bufferedAmount = 2 * 1024 * 1024;
  assert.equal(ctx.stream.send(new Int16Array([1])), false);
  await assert.rejects(ctx.stream.finish());
  assert.equal(ctx.events.some(value => value.final), false);
  assert.equal(ctx.socket.sent.filter(Buffer.isBuffer).length, 0);
});

test('live client redacts connection, socket, and gateway error details', async t => {
  const privateText = `${KEY} ${TOKEN} private transcript`;
  const failedConnect = client(t, { connect: async () => { throw new Error(privateText); } });
  await assert.rejects(failedConnect.stream.start(), error => !error.message.includes(KEY) && !error.message.includes('private'));
  const ctx = client(t);
  await ready(ctx);
  const finishing = ctx.stream.finish();
  const rejected = assert.rejects(finishing, error => !error.message.includes(KEY) && !error.message.includes('private'));
  ctx.socket.message({ type: 'error', code: 'provider_error', message: privateText, error: privateText });
  await rejected;
  ctx.socket.emit('error', new Error(privateText));
  assert.equal(JSON.stringify(ctx.events).includes(KEY), false);
  assert.equal(JSON.stringify(ctx.metrics).includes(KEY), false);
});

test('live client rejects JSON values that are not message objects without crashing or returning a result', async t => {
  for (const value of [null, [], 1, 'text']) {
    const ctx = client(t);
    await ready(ctx);
    assert.doesNotThrow(() => ctx.socket.message(value), JSON.stringify(value));
    await assert.rejects(ctx.stream.finish(), { code: 'LIVE_PROTOCOL_ERROR' });
    assert.equal(ctx.socket.readyState, 3);
    assert.equal(ctx.events.length, 0);
    assert.equal(ctx.metrics.length, 0);
  }
});

async function server(t, options = {}) {
  const upstreams = [], connections = [], messages = [];
  let acquired = 0, released = 0;
  const http = createServer();
  const attached = attachLiveTranscription(http, {
    token: TOKEN, apiKey: KEY,
    acquire: () => { acquired++; return true; },
    release: () => { released++; },
    createUpstream: (url, config) => {
      const socket = new Socket();
      socket.readyState = 0;
      upstreams.push({ socket, url, config });
      setImmediate(() => { if (socket.readyState === 0) { socket.readyState = 1; socket.emit('open'); } });
      return socket;
    },
    ...options,
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(async () => {
    for (const socket of connections) socket.terminate();
    for (const { socket } of upstreams) socket.close();
    attached?.close?.();
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
  });
  const url = `ws://127.0.0.1:${http.address().port}/transcribe/live`;
  function open(token = TOKEN) {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    socket.on('message', data => messages.push(JSON.parse(data.toString())));
    socket.on('error', () => {});
    connections.push(socket);
    return socket;
  }
  return { url, open, upstreams, messages, get acquired() { return acquired; }, get released() { return released; } };
}

async function serverReady(ctx) {
  const socket = ctx.open();
  await once(socket, 'open');
  await until(() => ctx.upstreams[0]?.socket.sent.length > 0);
  const upstream = ctx.upstreams[0].socket;
  upstream.message({ setupComplete: {} });
  await until(() => ctx.messages.some(message => message.type === 'ready'));
  return { socket, upstream };
}

const sentJson = socket => socket.sent.filter(value => typeof value === 'string').map(JSON.parse);
const content = (socket, body) => socket.message({ serverContent: body });

test('live gateway rejects unauthorized upgrades before creating an upstream', async t => {
  const ctx = await server(t);
  const socket = ctx.open('wrong-token');
  const [request, response] = await once(socket, 'unexpected-response');
  response.resume();
  request.destroy();
  assert.equal(response.statusCode, 401);
  assert.equal(ctx.upstreams.length, 0);
  assert.equal(ctx.acquired, 0);
});

test('live gateway rejects exhausted capacity before creating an upstream', async t => {
  const ctx = await server(t, { acquire: () => false });
  const socket = ctx.open();
  const [request, response] = await once(socket, 'unexpected-response');
  response.resume();
  request.destroy();
  assert.equal(response.statusCode, 429);
  assert.equal(ctx.upstreams.length, 0);
  assert.equal(ctx.released, 0);
});

test('authenticated malformed websocket handshake releases its slot and leaves both slots available', async t => {
  let active = 0, acquired = 0, released = 0;
  const ctx = await server(t, {
    acquire: () => {
      if (active >= 2) return false;
      active++; acquired++;
      return true;
    },
    release: () => { active--; released++; },
  });
  const status = await new Promise((resolve, reject) => {
    const request = requestHttp(ctx.url.replace('ws:', 'http:'), {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'invalid-key',
      },
    }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 400);
  await until(() => released === 1);
  assert.equal(acquired, 1);
  assert.equal(released, 1);
  assert.equal(active, 0);
  assert.equal(ctx.upstreams.length, 0);
  const first = ctx.open();
  await once(first, 'open');
  const second = ctx.open();
  await once(second, 'open');
  await until(() => ctx.upstreams.length === 2);
  assert.equal(active, 2);
  assert.equal(acquired, 3);
  assert.equal(released, 1);
});

test('live gateway sends Russian verbatim text setup, explicit activity boundaries, and exact PCM', async t => {
  const ctx = await server(t);
  const { socket, upstream } = await serverReady(ctx);
  const provider = ctx.upstreams[0];
  assert.equal(new URL(provider.url).hostname, 'generativelanguage.googleapis.com');
  assert.equal(new URL(provider.url).searchParams.get('key'), KEY);
  assert.equal(provider.config.perMessageDeflate, false);
  assert.deepEqual(sentJson(upstream), [
    { setup: {
      model: `models/${MODEL}`,
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: { languageCodes: ['ru-RU'], mode: 'VERBATIM' },
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    } },
    { realtimeInput: { activityStart: {} } },
  ]);
  assert.deepEqual(ctx.messages, [{ type: 'ready', model: MODEL }]);
  const pcm = Buffer.from([0x34, 0x12, 0xfe, 0xff]);
  socket.send(pcm);
  await until(() => sentJson(upstream).some(value => value.realtimeInput?.audio));
  assert.deepEqual(sentJson(upstream).at(-1), {
    realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } },
  });
  socket.send(JSON.stringify({ type: 'finish' }));
  await until(() => sentJson(upstream).some(value => value.realtimeInput?.activityEnd));
  assert.deepEqual(sentJson(upstream).at(-1), { realtimeInput: { activityEnd: {} } });
  content(upstream, { inputTranscription: { text: 'Открой калькулятор.' }, generationComplete: true });
  await until(() => ctx.messages.some(value => value.type === 'result'));
  const result = ctx.messages.find(value => value.type === 'result');
  assert.equal(result.text, 'Открой калькулятор.');
  assert.equal(result.model, MODEL);
  assert.ok(Number.isInteger(result.latencyMs) && result.latencyMs >= 0);
  await until(() => ctx.released === 1);
  assert.equal(upstream.readyState, 3);
  assert.equal(JSON.stringify(ctx.messages).includes(KEY), false);
});

test('live gateway requires finish, a subsequent final segment, and generation completion in either order', async t => {
  for (const generationFirst of [false, true]) {
    await t.test(generationFirst ? 'generation before final' : 'final before generation', async t => {
      const ctx = await server(t);
      const { socket, upstream } = await serverReady(ctx);
      socket.send(Buffer.alloc(2));
      await until(() => sentJson(upstream).some(value => value.realtimeInput?.audio));
      content(upstream, { inputTranscription: { text: 'Открой' }, generationComplete: true });
      await until(() => ctx.messages.some(value => value.type === 'transcript'));
      assert.equal(ctx.messages.some(value => value.type === 'result'), false);
      assert.ok(ctx.messages.filter(value => value.type === 'transcript').every(value => value.final === false));
      socket.send(JSON.stringify({ type: 'finish' }));
      await until(() => sentJson(upstream).some(value => value.realtimeInput?.activityEnd));
      const final = { inputTranscription: { text: 'калькулятор.' } };
      const generation = { generationComplete: true };
      content(upstream, generationFirst ? generation : final);
      await tick();
      assert.equal(ctx.messages.some(value => value.type === 'result'), false);
      content(upstream, generationFirst ? final : generation);
      await until(() => ctx.messages.some(value => value.type === 'result'));
      assert.equal(ctx.messages.find(value => value.type === 'result').text, 'Открой калькулятор.');
      assert.equal(ctx.messages.filter(value => value.type === 'result').length, 1);
    });
  }
});

test('live gateway never promotes an interim transcript or an old final after finish timeout', async t => {
  const ctx = await server(t, { finishTimeoutMs: 35 });
  const { socket, upstream } = await serverReady(ctx);
  socket.send(Buffer.alloc(2));
  await until(() => sentJson(upstream).some(value => value.realtimeInput?.audio));
  content(upstream, { inputTranscription: { text: 'Старая финальная часть' } });
  content(upstream, { interimInputTranscription: { text: 'незаконченная часть' } });
  socket.send(JSON.stringify({ type: 'finish' }));
  await until(() => sentJson(upstream).some(value => value.realtimeInput?.activityEnd));
  content(upstream, { generationComplete: true });
  await until(() => ctx.messages.some(value => value.type === 'error'));
  assert.equal(ctx.messages.find(value => value.type === 'error').code, 'LIVE_FINISH_TIMEOUT');
  assert.equal(ctx.messages.some(value => value.type === 'result'), false);
  assert.equal(ctx.released, 1);
});

test('live gateway rejects invalid PCM and controls without forwarding audio', async t => {
  const cases = [
    ['odd PCM length', Buffer.alloc(3)],
    ['oversized PCM chunk', Buffer.alloc(32_002)],
    ['empty PCM chunk', Buffer.alloc(0)],
    ['invalid JSON', '{invalid'],
    ['unexpected control', JSON.stringify({ type: 'unknown' })],
    ['finish with extra fields', JSON.stringify({ type: 'finish', token: KEY })],
    ['finish without audio', JSON.stringify({ type: 'finish' })],
  ];
  for (const [name, payload] of cases) {
    await t.test(name, async t => {
      const ctx = await server(t);
      const { socket, upstream } = await serverReady(ctx);
      socket.send(payload);
      await until(() => ctx.messages.some(value => value.type === 'error'));
      assert.deepEqual(ctx.messages.find(value => value.type === 'error'), { type: 'error', code: 'LIVE_PROTOCOL_ERROR' });
      assert.equal(sentJson(upstream).filter(value => value.realtimeInput?.audio).length, 0);
      assert.equal(ctx.released, 1);
    });
  }
});

test('live gateway enforces a thirty-second total PCM limit', async t => {
  const ctx = await server(t);
  const { socket, upstream } = await serverReady(ctx);
  for (let i = 0; i < 30; i++) socket.send(Buffer.alloc(32_000));
  socket.send(Buffer.alloc(2));
  await until(() => ctx.messages.some(value => value.type === 'error'));
  assert.deepEqual(ctx.messages.find(value => value.type === 'error'), { type: 'error', code: 'LIVE_AUDIO_LIMIT' });
  const audio = sentJson(upstream).filter(value => value.realtimeInput?.audio);
  assert.equal(audio.length, 30);
  assert.equal(audio.reduce((sum, value) => sum + Buffer.from(value.realtimeInput.audio.data, 'base64').length, 0), 960_000);
  assert.equal(ctx.messages.some(value => value.type === 'result'), false);
});

test('live gateway enforces websocket payload bounds before forwarding data', async t => {
  const ctx = await server(t);
  const { socket, upstream } = await serverReady(ctx);
  const closed = once(socket, 'close');
  socket.send(Buffer.alloc(40_000));
  const [code] = await closed;
  assert.equal(code, 1009);
  assert.equal(sentJson(upstream).filter(value => value.realtimeInput?.audio).length, 0);
  await until(() => ctx.released === 1);
});

test('live gateway fails bounded upstream backpressure without forwarding new PCM', async t => {
  const ctx = await server(t);
  const { socket, upstream } = await serverReady(ctx);
  upstream.bufferedAmount = 4 * 1024 * 1024;
  socket.send(Buffer.alloc(2));
  await until(() => ctx.messages.some(value => value.type === 'error'));
  assert.deepEqual(ctx.messages.find(value => value.type === 'error'), { type: 'error', code: 'LIVE_BACKPRESSURE' });
  assert.equal(sentJson(upstream).filter(value => value.realtimeInput?.audio).length, 0);
  assert.equal(ctx.released, 1);
});

test('live gateway cancellation closes upstream, releases capacity once, and cannot emit a late result', async t => {
  const ctx = await server(t);
  const { socket, upstream } = await serverReady(ctx);
  content(upstream, { interimInputTranscription: { text: 'Незаконченная команда' } });
  await until(() => ctx.messages.some(value => value.type === 'transcript'));
  socket.terminate();
  await until(() => ctx.released === 1);
  assert.equal(upstream.readyState, 3);
  content(upstream, { inputTranscription: { text: 'Опоздавший результат' }, generationComplete: true });
  upstream.emit('error', new Error(KEY));
  await tick();
  assert.equal(ctx.released, 1);
  assert.equal(ctx.messages.some(value => value.type === 'result'), false);
});

test('live gateway redacts raw provider errors and connection failures', async t => {
  const ctx = await server(t);
  const { upstream } = await serverReady(ctx);
  upstream.message({ error: { message: `${KEY} private transcript`, code: 403 } });
  await until(() => ctx.messages.some(value => value.type === 'error'));
  assert.deepEqual(ctx.messages.find(value => value.type === 'error'), { type: 'error', code: 'GEMINI_UNAVAILABLE' });
  assert.equal(JSON.stringify(ctx.messages).includes(KEY), false);
  assert.equal(JSON.stringify(ctx.messages).includes('private'), false);
  assert.equal(ctx.released, 1);
  const broken = await server(t, { createUpstream: () => { throw new Error(`${KEY} private`); } });
  broken.open();
  await until(() => broken.messages.some(value => value.type === 'error'));
  assert.deepEqual(broken.messages, [{ type: 'error', code: 'GEMINI_UNAVAILABLE' }]);
  assert.equal(broken.released, 1);
});

test('live gateway rejects non-object upstream JSON without crashing or leaking its capacity slot', async t => {
  for (const value of [null, [], 1, 'text']) {
    const ctx = await server(t);
    const { upstream } = await serverReady(ctx);
    assert.doesNotThrow(() => upstream.message(value), JSON.stringify(value));
    await until(() => ctx.messages.some(message => message.type === 'error'));
    assert.deepEqual(ctx.messages.find(message => message.type === 'error'), { type: 'error', code: 'LIVE_PROTOCOL_ERROR' });
    assert.equal(ctx.messages.some(message => message.type === 'result'), false);
    assert.equal(ctx.released, 1);
    assert.equal(upstream.readyState, 3);
  }
});

test('live gateway setup timeout releases its slot and never returns a transcript', async t => {
  const ctx = await server(t, { connectTimeoutMs: 25 });
  ctx.open();
  await until(() => ctx.messages.some(value => value.type === 'error'));
  assert.deepEqual(ctx.messages, [{ type: 'error', code: 'LIVE_CONNECT_TIMEOUT' }]);
  assert.equal(ctx.released, 1);
  assert.equal(ctx.upstreams[0].socket.readyState, 3);
});

test('desktop live client and loopback gateway complete one buffered utterance end to end', async t => {
  const ctx = await server(t);
  const previews = [], metrics = [];
  const stream = new GeminiLiveStream({
    connect: async () => ({ url: ctx.url, token: TOKEN }),
    onTranscript: value => previews.push(value),
    onMetrics: value => metrics.push(value),
  });
  t.after(() => stream.close());
  assert.equal(stream.send(new Int16Array([123, -456])), true);
  const starting = stream.start();
  assert.equal(stream.send(new Int16Array([789, -987])), true);
  const finishing = stream.finish();
  await until(() => ctx.upstreams[0]?.socket.sent.length > 0);
  const upstream = ctx.upstreams[0].socket;
  assert.equal(sentJson(upstream).filter(value => value.realtimeInput?.audio).length, 0);
  upstream.message({ setupComplete: {} });
  await starting;
  await until(() => sentJson(upstream).some(value => value.realtimeInput?.activityEnd));
  const input = sentJson(upstream).filter(value => value.realtimeInput).map(value => value.realtimeInput);
  assert.deepEqual(input.map(value => Object.keys(value)[0]), ['activityStart', 'audio', 'audio', 'activityEnd']);
  const pcm = Buffer.concat(input.filter(value => value.audio).map(value => Buffer.from(value.audio.data, 'base64')));
  assert.deepEqual(Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2)), [123, -456, 789, -987]);
  content(upstream, { interimInputTranscription: { text: 'Открой калькуля' } });
  await until(() => previews.length === 1);
  assert.deepEqual(previews[0], { text: 'Открой калькуля', final: false });
  content(upstream, { inputTranscription: { text: 'Открой калькулятор.' }, generationComplete: true });
  const result = await finishing;
  assert.equal(result.text, 'Открой калькулятор.');
  assert.equal(result.model, MODEL);
  assert.equal(result.audioBytes, 8);
  assert.ok(Number.isInteger(result.connectMs) && result.connectMs >= 0);
  assert.ok(Number.isInteger(result.latencyMs) && result.latencyMs >= 0);
  const { text, ...expectedMetrics } = result;
  assert.deepEqual(metrics, [expectedMetrics]);
  assert.ok(previews.every(value => value.final === false));
  await until(() => ctx.released === 1);
});

test('live gateway does not mistake conversational turn completion for generation completion', async t => {
  const ctx = await server(t, { finishTimeoutMs: 35 });
  const { socket, upstream } = await serverReady(ctx);
  socket.send(Buffer.alloc(2));
  socket.send(JSON.stringify({ type: 'finish' }));
  await until(() => sentJson(upstream).some(value => value.realtimeInput?.activityEnd));
  content(upstream, { inputTranscription: { text: 'Неподтверждённый результат' }, turnComplete: true });
  await until(() => ctx.messages.some(value => value.type === 'error'));
  assert.deepEqual(ctx.messages.find(value => value.type === 'error'), { type: 'error', code: 'LIVE_FINISH_TIMEOUT' });
  assert.equal(ctx.messages.some(value => value.type === 'result'), false);
});

test('gateway health advertises live model and HTTP plus websocket sessions share two capacity slots', async t => {
  const upstreams = [], connections = [];
  const fetchStarted = deferred(), unblockFetch = deferred();
  let requests = 0;
  const http = createGatewayServer({
    token: TOKEN, apiKey: KEY, liveModel: 'test-live-model',
    fetchImpl: async () => {
      if (++requests === 1) { fetchStarted.resolve(); await unblockFetch.promise; }
      return Response.json({ candidates: [{ content: { parts: [{ text: 'Готово' }] } }] });
    },
    liveOptions: {
      createUpstream: () => {
        const socket = new Socket();
        socket.readyState = 0;
        upstreams.push(socket);
        setImmediate(() => { if (socket.readyState === 0) { socket.readyState = 1; socket.emit('open'); } });
        return socket;
      },
    },
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(async () => {
    unblockFetch.resolve();
    for (const socket of connections) socket.terminate();
    for (const socket of upstreams) socket.close();
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
  });
  const url = `http://127.0.0.1:${http.address().port}`;
  const call = () => fetch(`${url}/chat`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Привет' }),
  });
  const open = () => {
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/transcribe/live`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    socket.on('error', () => {});
    connections.push(socket);
    return socket;
  };
  const firstLive = open();
  await once(firstLive, 'open');
  await until(() => upstreams.length === 1);
  const firstHttp = call();
  await fetchStarted.promise;
  const health = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).liveModel, 'test-live-model');
  const busyHttp = await call();
  assert.equal(busyHttp.status, 429);
  assert.deepEqual(await busyHttp.json(), { error: 'Busy' });
  const blockedLive = open();
  const [request, response] = await once(blockedLive, 'unexpected-response');
  response.resume(); request.destroy();
  assert.equal(response.statusCode, 429);
  assert.equal(upstreams.length, 1);
  unblockFetch.resolve();
  const completedHttp = await firstHttp;
  assert.equal(completedHttp.status, 200);
  assert.equal((await completedHttp.json()).text, 'Готово');
  const secondLive = open();
  await once(secondLive, 'open');
  await until(() => upstreams.length === 2);
  firstLive.terminate();
  await until(() => upstreams[0].readyState === 3);
  const afterRelease = await call();
  assert.equal(afterRelease.status, 200);
  assert.equal((await afterRelease.json()).text, 'Готово');
  assert.equal(requests, 2);
});
