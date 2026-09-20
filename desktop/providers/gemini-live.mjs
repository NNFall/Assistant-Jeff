import WebSocket from 'ws';

const MAX_AUDIO_BYTES = 16000 * 2 * 30;
const MAX_MESSAGE_BYTES = 32 * 1024;
const CODES = new Set(['GEMINI_UNAVAILABLE', 'LIVE_CONNECT_TIMEOUT', 'LIVE_FINISH_TIMEOUT', 'LIVE_SESSION_TIMEOUT', 'LIVE_AUDIO_LIMIT', 'LIVE_BACKPRESSURE', 'LIVE_PROTOCOL_ERROR', 'EMPTY_TRANSCRIPT', 'ABORTED']);
const fault = code => Object.assign(new Error('Не удалось завершить потоковое распознавание.'), { code });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A controller can cancel a stream before it has started awaiting finish().
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** One activated utterance; construction/send never opens a network connection. */
export class GeminiLiveStream {
  constructor({ connect, signal, onTranscript = () => {}, onMetrics = () => {},
    createSocket = (url, options) => new WebSocket(url, options),
    connectTimeoutMs = 15000, finishTimeoutMs = 15000, maxSessionMs = 60000 } = {}) {
    Object.assign(this, { connect, signal, onTranscript, onMetrics, createSocket });
    this.connectTimeoutMs = Math.min(15000, connectTimeoutMs);
    this.finishTimeoutMs = Math.min(15000, finishTimeoutMs);
    this.maxSessionMs = Math.min(60000, maxSessionMs);
    this.state = 'idle'; this.queue = []; this.audioBytes = 0;
    this.ready = deferred(); this.result = deferred();
    this.abort = () => this.fail('ABORTED');
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  start() {
    if (this.state !== 'idle') return this.ready.promise;
    this.state = 'connecting'; this.startedAt = performance.now();
    this.connectTimer = setTimeout(() => this.fail('LIVE_CONNECT_TIMEOUT'), this.connectTimeoutMs);
    this.sessionTimer = setTimeout(() => this.fail('LIVE_SESSION_TIMEOUT'), this.maxSessionMs);
    void this.open();
    return this.ready.promise;
  }

  async open() {
    try {
      const { url, token } = await this.connect();
      if (this.state !== 'connecting') return;
      const target = new URL(url);
      // All provider audio travels through the authenticated, SSH-forwarded loopback.
      if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1' || target.pathname !== '/transcribe/live' || !token) throw fault('LIVE_PROTOCOL_ERROR');
      this.socket = this.createSocket(target.toString(), { headers: { Authorization: `Bearer ${token}` }, maxPayload: MAX_MESSAGE_BYTES });
      this.socket.on('message', (data, binary) => this.message(data, binary));
      this.socket.on('error', () => this.fail('GEMINI_UNAVAILABLE'));
      this.socket.on('close', () => { if (!['done', 'closed'].includes(this.state)) this.fail('GEMINI_UNAVAILABLE'); });
    } catch { this.fail('GEMINI_UNAVAILABLE'); }
  }

  send(pcm) {
    if (!(pcm instanceof Int16Array) || !pcm.length || pcm.length > 16000 || this.finishRequested || ['closed', 'done'].includes(this.state)) return false;
    if (this.audioBytes + pcm.byteLength > MAX_AUDIO_BYTES) { this.fail('LIVE_AUDIO_LIMIT'); return false; }
    // Copy caller-owned samples explicitly into little-endian wire bytes.
    const frame = Buffer.allocUnsafe(pcm.byteLength);
    for (let i = 0; i < pcm.length; i++) frame.writeInt16LE(pcm[i], i * 2);
    this.audioBytes += frame.length;
    if (this.state === 'ready') return this.write(frame);
    this.queue.push(frame);
    return true;
  }

  write(data) {
    if (this.socket?.readyState !== WebSocket.OPEN) { this.fail('GEMINI_UNAVAILABLE'); return false; }
    if (this.socket.bufferedAmount > MAX_AUDIO_BYTES) { this.fail('LIVE_BACKPRESSURE'); return false; }
    try { this.socket.send(data, error => { if (error) this.fail('GEMINI_UNAVAILABLE'); }); return true; }
    catch { this.fail('GEMINI_UNAVAILABLE'); return false; }
  }

  finish() {
    if (!this.finishRequested && !['closed', 'done'].includes(this.state)) {
      this.finishRequested = true;
      this.finishedAt = performance.now();
      this.start();
      if (this.state === 'ready') this.endInput();
    }
    return this.result.promise;
  }

  endInput() {
    if (this.endSent || this.state !== 'ready') return;
    this.endSent = true;
    this.finishTimer = setTimeout(() => this.fail('LIVE_FINISH_TIMEOUT'), this.finishTimeoutMs);
    this.write(JSON.stringify({ type: 'finish' }));
  }

  message(data, binary) {
    if (['closed', 'done'].includes(this.state)) return;
    if (binary || data.length > MAX_MESSAGE_BYTES) return this.fail('LIVE_PROTOCOL_ERROR');
    let message;
    try { message = JSON.parse(data.toString()); } catch { return this.fail('LIVE_PROTOCOL_ERROR'); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return this.fail('LIVE_PROTOCOL_ERROR');
    if (message.type === 'ready' && this.state === 'connecting') {
      clearTimeout(this.connectTimer); this.state = 'ready'; this.connectMs = Math.round(performance.now() - this.startedAt);
      for (const frame of this.queue.splice(0)) { if (!this.write(frame)) return; }
      this.ready.resolve();
      if (this.finishRequested) this.endInput();
    } else if (message.type === 'transcript' && this.state === 'ready' && message.final === false && typeof message.text === 'string' && message.text.length <= 16384) {
      try { this.onTranscript({ text: message.text, final: false }); } catch { this.fail('LIVE_PROTOCOL_ERROR'); }
    } else if (message.type === 'result' && this.endSent && typeof message.text === 'string' && message.text.trim() && message.text.length <= 16384 && typeof message.model === 'string') {
      const result = { text: message.text.trim(), model: message.model,
        latencyMs: Math.round(performance.now() - this.finishedAt), connectMs: this.connectMs, audioBytes: this.audioBytes };
      this.state = 'done'; this.cleanup(); this.result.resolve(result);
      const { text, ...metrics } = result;
      try { this.onMetrics(metrics); } catch {}
      this.socket?.close();
    } else if (message.type === 'error') this.fail(CODES.has(message.code) ? message.code : 'GEMINI_UNAVAILABLE');
    else this.fail('LIVE_PROTOCOL_ERROR');
  }

  cleanup() {
    for (const timer of [this.connectTimer, this.sessionTimer, this.finishTimer]) clearTimeout(timer);
    this.signal?.removeEventListener('abort', this.abort);
    for (const frame of this.queue) frame.fill(0);
    this.queue.length = 0;
  }
  fail(code) {
    if (['closed', 'done'].includes(this.state)) return;
    this.state = 'closed'; this.cleanup();
    const error = fault(code); this.ready.reject(error); this.result.reject(error);
    this.socket?.terminate();
  }
  close() { this.fail('ABORTED'); }
}
