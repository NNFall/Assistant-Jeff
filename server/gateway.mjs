import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const MAX_AUDIO_BYTES = 1024 * 1024;
const MAX_TRANSCRIBE_BODY = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

function reply(res, status, obj) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Check the ID3 length and a complete MPEG Layer III frame, without decoding audio.
function isMp3(audio) {
  let offset = 0;
  if (audio.length >= 3 && audio.subarray(0, 3).toString('ascii') === 'ID3') {
    if (audio.length < 14 || audio[3] < 2 || audio[3] > 4 || audio[4] === 255) return false;
    if (audio.subarray(6, 10).some(byte => byte > 127)) return false;
    offset = 10 + audio[6] * 2097152 + audio[7] * 16384 + audio[8] * 128 + audio[9];
    if (audio[3] === 4 && (audio[5] & 0x10)) offset += 10;
  }
  if (offset + 4 > audio.length) return false;
  const [a, b, c] = audio.subarray(offset, offset + 3);
  const version = (b >> 3) & 3;
  const bitrateIndex = c >> 4;
  const sampleIndex = (c >> 2) & 3;
  if (a !== 255 || (b & 0xe0) !== 0xe0 || version === 1 || ((b >> 1) & 3) !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return false;
  const rates = version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  const sampleRate = [44100,48000,32000][sampleIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const frameSize = Math.floor((version === 3 ? 144 : 72) * rates[bitrateIndex] * 1000 / sampleRate) + ((c >> 1) & 1);
  return offset + frameSize <= audio.length;
}

function audioFromBody(body) {
  if (body?.mimeType !== 'audio/mp3' || typeof body.audio !== 'string' || !body.audio.length || body.audio.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4) return null;
  // Buffer.from is permissive; reject whitespace, missing padding and noncanonical encodings.
  if (body.audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio)) return null;
  const audio = Buffer.from(body.audio, 'base64');
  return audio.length <= MAX_AUDIO_BYTES && audio.toString('base64') === body.audio && isMp3(audio) ? audio : null;
}

async function readJson(response, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw new Error('Response too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function transcriptionText(data) {
  if (!data || data.status !== 'completed' || data.errors?.length) return '';
  if (typeof data.output_text === 'string') return data.output_text.trim();
  // REST exposes output steps; input echoes, tool calls and thought summaries are not transcripts.
  return (Array.isArray(data.steps) ? data.steps : [])
    .filter(step => step?.type === 'model_output' && !step.thought)
    .flatMap(step => Array.isArray(step.content) ? step.content : [])
    .filter(content => content?.type === 'text' && !content.thought && typeof content.text === 'string')
    .map(content => content.text).join('').trim();
}

export function createGatewayServer({
  token = process.env.JEFF_GATEWAY_TOKEN,
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
  transcribeModel = process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-3.5-transcribe',
  fetchImpl = globalThis.fetch,
  chatTimeoutMs = 25000,
  transcribeTimeoutMs = 45000,
} = {}) {
  if (!token || !apiKey) throw new Error('Server credentials are not configured');
  const expected = Buffer.from(`Bearer ${token}`);
  let active = 0;
  const server = http.createServer(async (req, res) => {
    const given = Buffer.from(req.headers.authorization || '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply(res, 401, { error: 'Unauthorized' });
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true, service: 'assistant-jeff', model, transcribeModel });
    const transcribe = req.url === '/transcribe';
    if (req.method !== 'POST' || (!transcribe && req.url !== '/chat')) return reply(res, 404, { error: 'Not found' });
    if (active >= 2) return reply(res, 429, { error: 'Busy' });
    const limit = transcribe ? MAX_TRANSCRIBE_BODY : 16384;
    if (Number(req.headers['content-length']) > limit) return reply(res, 413, { error: 'Too large' });
    active++;
    const cancel = new AbortController();
    const disconnect = () => { if (!res.writableEnded) cancel.abort(); };
    res.on('close', disconnect);
    req.on('aborted', disconnect);
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > limit) return reply(res, 413, { error: 'Too large' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400, { error: 'Invalid JSON' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(res, 400, { error: 'Invalid request' });
      if (transcribe ? !audioFromBody(body) : typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4096) return reply(res, 400, { error: transcribe ? 'Invalid MP3 audio' : 'Invalid text' });
      cancel.signal.throwIfAborted();
      const started = performance.now();
      const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(transcribe ? transcribeTimeoutMs : chatTimeoutMs)]);
      const url = transcribe ? 'https://generativelanguage.googleapis.com/v1beta/interactions' : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const payload = transcribe ? {
        model: transcribeModel, store: false,
        input: [{ type: 'audio', mime_type: 'audio/mp3', data: body.audio }],
      } : {
        contents: [{ role: 'user', parts: [{ text: body.text }] }],
        systemInstruction: { parts: [{ text: 'Ты Jeff, личный помощник. Отвечай кратко и естественно по-русски. Ты отвечаешь только текстом. Не утверждай, что открыл программу, создал заметку, напоминание или выполнил действие: у тебя нет инструментов. Не придумывай актуальную погоду или результаты поиска.' }] },
        generationConfig: { maxOutputTokens: 1024 },
      };
      const upstream = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, signal, body: JSON.stringify(payload) });
      if (!upstream.ok) {
        await upstream.body?.cancel?.().catch(() => {});
        return reply(res, 502, { error: 'Gemini unavailable', upstreamStatus: upstream.status });
      }
      const data = await readJson(upstream, MAX_RESPONSE_BYTES);
      signal.throwIfAborted();
      const text = transcribe ? transcriptionText(data) : data.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('').trim();
      if (typeof text !== 'string' || !text || text.length > 16384) return reply(res, 502, { error: 'Empty or invalid response' });
      reply(res, 200, transcribe ? { text, model: transcribeModel, latencyMs: Math.round(performance.now() - started) } : { text, model, usage: data.usageMetadata });
    } catch {
      reply(res, 502, { error: 'Provider request failed' });
    } finally {
      active--;
      res.off('close', disconnect);
      req.off('aborted', disconnect);
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 18741);
  createGatewayServer().listen(port, '127.0.0.1', () => console.log('Assistant Jeff gateway ready on loopback'));
}
