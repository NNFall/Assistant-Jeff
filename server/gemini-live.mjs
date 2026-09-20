import WebSocket, { WebSocketServer } from 'ws';
import { timingSafeEqual } from 'node:crypto';

const MAX_AUDIO_BYTES = 16000 * 2 * 30;
const MAX_MESSAGE_BYTES = 32 * 1024;
const UPSTREAM = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** Narrow authenticated PCM bridge. Provider credentials and raw errors stay on the server. */
export function attachLiveTranscription(server, { token, apiKey, model = 'gemini-3.5-transcribe-live',
  createUpstream = (url, options) => new WebSocket(url, options), acquire = () => true, release = () => {},
  connectTimeoutMs = 15000, finishTimeoutMs = 15000, maxSessionMs = 60000 } = {}) {
  const expected = Buffer.from(`Bearer ${token}`);
  const hub = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    const given = Buffer.from(request.headers.authorization || '');
    const deny = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return deny('401 Unauthorized');
    if (request.url !== '/transcribe/live') return deny('404 Not Found');
    if (!acquire()) return deny('429 Too Many Requests');
    // ws can reject malformed handshake headers without throwing or invoking
    // its callback. Release that reserved slot when the rejected socket closes.
    let pending = true;
    const releasePending = () => { if (pending) { pending = false; release(); } };
    socket.once('close', releasePending);
    try { hub.handleUpgrade(request, socket, head, client => {
      pending = false; socket.off('close', releasePending); session(client);
    }); }
    catch { releasePending(); socket.destroy(); }
  });

  function session(client) {
    let upstream, ready = false, ended = false, terminal = false, released = false;
    let audioBytes = 0, text = '', interim = '', finalAfterEnd = false, generationAfterEnd = false;
    const started = performance.now(); let finishTimer;
    const connectTimer = setTimeout(() => fail('LIVE_CONNECT_TIMEOUT'), Math.min(connectTimeoutMs, 15000));
    const sessionTimer = setTimeout(() => fail('LIVE_SESSION_TIMEOUT'), Math.min(maxSessionMs, 60000));
    function send(payload) {
      if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > MAX_MESSAGE_BYTES) { cleanup(); return false; }
      try { client.send(JSON.stringify(payload)); return true; } catch { cleanup(); return false; }
    }
    function cleanup() {
      if (!released) { released = true; release(); }
      terminal = true; clearTimeout(connectTimer); clearTimeout(sessionTimer); clearTimeout(finishTimer);
      upstream?.terminate(); client.close(); text = ''; interim = '';
    }
    function fail(code) { if (terminal) return; send({ type: 'error', code }); cleanup(); }
    function upstreamSend(payload) {
      if (upstream?.readyState !== WebSocket.OPEN) { fail('GEMINI_UNAVAILABLE'); return false; }
      if (upstream.bufferedAmount > MAX_AUDIO_BYTES * 2) { fail('LIVE_BACKPRESSURE'); return false; }
      try { upstream.send(JSON.stringify(payload)); return true; } catch { fail('GEMINI_UNAVAILABLE'); return false; }
    }
    function complete() {
      // Dedicated Transcribe Live emits generationComplete, not conversational
      // turnComplete (verified with synthetic speech). Its finalized input text
      // is independent of completion messages: require both, in either order.
      if (!ended || !generationAfterEnd || !finalAfterEnd || terminal) return;
      if (!text.trim()) return fail('EMPTY_TRANSCRIPT');
      send({ type: 'result', text: text.trim(), model, latencyMs: Math.round(performance.now() - started) });
      cleanup();
    }
    client.on('close', cleanup);
    client.on('error', cleanup);
    client.on('message', (data, binary) => {
      if (terminal) return;
      if (!ready || ended) return fail('LIVE_PROTOCOL_ERROR');
      if (binary) {
        if (!data.length || data.length % 2 || data.length > 32000) return fail('LIVE_PROTOCOL_ERROR');
        audioBytes += data.length;
        if (audioBytes > MAX_AUDIO_BYTES) return fail('LIVE_AUDIO_LIMIT');
        upstreamSend({ realtimeInput: { audio: { data: data.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });
      } else {
        let message;
        try { message = JSON.parse(data.toString()); } catch { return fail('LIVE_PROTOCOL_ERROR'); }
        if (message?.type !== 'finish' || Object.keys(message).length !== 1 || !audioBytes) return fail('LIVE_PROTOCOL_ERROR');
        ended = true;
        finishTimer = setTimeout(() => fail('LIVE_FINISH_TIMEOUT'), Math.min(finishTimeoutMs, 15000));
        upstreamSend({ realtimeInput: { activityEnd: {} } });
      }
    });
    try {
      const url = new URL(UPSTREAM); url.searchParams.set('key', apiKey);
      upstream = createUpstream(url.toString(), { maxPayload: 256 * 1024, perMessageDeflate: false });
      upstream.on('error', () => fail('GEMINI_UNAVAILABLE'));
      upstream.on('close', () => { if (!terminal) fail('GEMINI_UNAVAILABLE'); });
      upstream.on('open', () => upstreamSend({ setup: {
        model: `models/${model}`, generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: { languageCodes: ['ru-RU'], mode: 'VERBATIM' },
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      } }));
      upstream.on('message', data => {
        if (terminal) return;
        if (data.length > 256 * 1024) return fail('LIVE_PROTOCOL_ERROR');
        let message;
        try { message = JSON.parse(data.toString()); } catch { return fail('LIVE_PROTOCOL_ERROR'); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return fail('LIVE_PROTOCOL_ERROR');
        if (message.error || message.goAway) return fail('GEMINI_UNAVAILABLE');
        if (message.setupComplete) {
          if (ready) return fail('LIVE_PROTOCOL_ERROR');
          clearTimeout(connectTimer); ready = true;
          if (upstreamSend({ realtimeInput: { activityStart: {} } })) send({ type: 'ready', model });
        }
        const content = message.serverContent;
        if (!content) return;
        if (content.inputTranscription) {
          if (typeof content.inputTranscription.text !== 'string') return fail('LIVE_PROTOCOL_ERROR');
          const segment = content.inputTranscription.text.trim();
          if (segment) text = text ? `${text} ${segment}` : segment;
          interim = '';
          if (ended) finalAfterEnd = true;
        }
        if (content.interimInputTranscription) {
          if (typeof content.interimInputTranscription.text !== 'string') return fail('LIVE_PROTOCOL_ERROR');
          interim = content.interimInputTranscription.text;
        }
        const preview = [text, interim].filter(Boolean).join(' ');
        if (preview.length > 16384) return fail('LIVE_PROTOCOL_ERROR');
        if (content.inputTranscription || content.interimInputTranscription) send({ type: 'transcript', text: preview, final: false });
        if (ended && content.generationComplete === true) generationAfterEnd = true;
        complete();
      });
    } catch { fail('GEMINI_UNAVAILABLE'); }
  }
  const close = () => { for (const client of hub.clients) client.terminate(); hub.close(); };
  server.on('close', close);
  return { close };
}
