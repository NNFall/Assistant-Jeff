import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGatewayServer } from '../server/gateway.mjs';
import { GeminiGateway, GEMINI_ERROR_CODES } from '../desktop/providers/gemini.mjs';
import { AGENT_SYSTEM_INSTRUCTION } from '../server/agent-model.mjs';

const TOKEN = 'agent-test-token';
const KEY = 'agent-test-provider-key';
const TOOL = {
  name: 'assistant_respond',
  description: 'Return the final user-facing response or ask one clarification.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' }, question: { type: 'string' } },
    additionalProperties: false,
  },
};
const CONTEXT = { nowIso: '2026-09-20T12:00:00.000Z', timeZone: 'Europe/Samara', capabilities: ['windows_ui'] };
const REQUEST = {
  contents: [
    { role: 'user', parts: [{ text: 'открой диспетчер задач' }] },
    { role: 'model', parts: [{ functionCall: { name: 'assistant_respond', args: { text: 'уточни' }, id: 'call-old' }, thoughtSignature: 'opaque-history-signature' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'assistant_respond', response: { ok: true }, id: 'call-old' } }] },
  ],
  tools: [TOOL],
  context: CONTEXT,
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function start(t, fetchImpl, options = {}) {
  const server = createGatewayServer({ token: TOKEN, apiKey: KEY, fetchImpl, agentModel: 'test-agent-model', ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    call: (route, body, extra = {}) => fetch(`${url}${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...extra,
    }),
  };
}

function modelResponse(parts, usageMetadata = { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 }) {
  return Response.json({ candidates: [{ content: { role: 'model', parts } }], usageMetadata });
}

test('agent system instruction matches final status, evidence and time tool contracts', () => {
  assert.match(AGENT_SYSTEM_INSTRUCTION, /answer, completed, clarification (?:и|and) incomplete/u);
  assert.match(AGENT_SYSTEM_INSTRUCTION, /response\.evidenceId/u);
  assert.match(AGENT_SYSTEM_INSTRUCTION, /data\.dueAt/u);
  assert.match(AGENT_SYSTEM_INSTRUCTION, /data\.expectedDueAt/u);
  assert.match(AGENT_SYSTEM_INSTRUCTION, /time_resolve/u);
  assert.match(AGENT_SYSTEM_INSTRUCTION, /status=clarification/u);
  assert.doesNotMatch(AGENT_SYSTEM_INSTRUCTION, /partial|failed|09:00/u);
});

test('agent sends real generateContent function declarations and preserves signature/id history', async t => {
  let seen;
  const { call } = await start(t, async (url, options) => {
    seen = { url, options, body: JSON.parse(options.body) };
    return modelResponse([
      { text: 'скрыто', thought: true },
      { functionCall: { name: 'assistant_respond', args: { text: 'Готово' }, id: 'call-new' }, thoughtSignature: 'opaque-output-signature' },
      { text: 'Проверенный ответ', thought: false },
    ], { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18, trafficType: 'ON_DEMAND', promptTokensDetails: [{ modality: 'TEXT', tokenCount: 11 }] });
  });
  const response = await call('/agent', REQUEST);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.content, {
    role: 'model',
    parts: [
      { functionCall: { name: 'assistant_respond', args: { text: 'Готово' }, id: 'call-new' }, thoughtSignature: 'opaque-output-signature' },
      { text: 'Проверенный ответ' },
    ],
  });
  assert.equal(result.model, 'test-agent-model');
  assert.deepEqual(result.usage, { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 });
  assert.ok(Number.isInteger(result.latencyMs) && result.latencyMs >= 0);
  assert.equal(seen.url, 'https://generativelanguage.googleapis.com/v1beta/models/test-agent-model:generateContent');
  assert.deepEqual(seen.body.contents, REQUEST.contents);
  assert.deepEqual(seen.body.tools, [{ functionDeclarations: [{ name: TOOL.name, description: TOOL.description, parametersJsonSchema: TOOL.parameters }] }]);
  assert.match(seen.body.systemInstruction.parts[0].text, /assistant_respond/);
  assert.match(seen.body.systemInstruction.parts[0].text, /Europe\/Samara/);
  assert.deepEqual(seen.body.generationConfig, { maxOutputTokens: 4096 });
});

test('agent rejects an unknown model function and malformed args without returning a candidate', async t => {
  const responses = [
    modelResponse([{ functionCall: { name: 'run_shell', args: {} } }]),
    modelResponse([{ functionCall: { name: 'assistant_respond', args: [] } }]),
  ];
  const { call } = await start(t, async () => responses.shift());
  const unknown = await call('/agent', REQUEST);
  assert.equal(unknown.status, 502);
  assert.deepEqual(await unknown.json(), { error: 'Provider request failed', code: 'AGENT_MODEL_INVALID', validation: 'candidate.parts[0].functionCall.name is unknown' });
  const malformed = await call('/agent', REQUEST);
  assert.equal(malformed.status, 502);
  const malformedBody = await malformed.json();
  assert.equal(malformedBody.code, 'AGENT_MODEL_INVALID');
  assert.match(malformedBody.validation, /^candidate\.parts\[0\]\.functionCall\.args/);
});

test('agent reports safe input, upstream and provider error codes without raw bodies', async t => {
  const inputServer = await start(t, async () => modelResponse([{ text: 'unused' }]));
  const invalid = await inputServer.call('/agent', { ...REQUEST, contents: [] });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'Invalid agent request', code: 'AGENT_INPUT_INVALID', validation: 'contents is invalid' });

  const upstreamServer = await start(t, async () => new Response('provider secret body', { status: 503 }));
  const upstream = await upstreamServer.call('/agent', REQUEST);
  assert.equal(upstream.status, 502);
  assert.deepEqual(await upstream.json(), {
    error: 'Gemini unavailable',
    code: 'GEMINI_UPSTREAM_ERROR',
    upstreamStatus: 503,
    details: { status: 502, upstreamStatus: 503 },
  });

  const providerServer = await start(t, async () => { throw new Error('provider secret prompt'); });
  const provider = await providerServer.call('/agent', REQUEST);
  assert.equal(provider.status, 502);
  assert.deepEqual(await provider.json(), { error: 'Provider request failed', code: 'AGENT_PROVIDER_ERROR' });
});

test('agent endpoint requires gateway auth and enforces its 512 KiB body limit', async t => {
  let calls = 0;
  const { url, call } = await start(t, async () => { calls++; return modelResponse([{ text: 'bad' }]); });
  const unauthorized = await fetch(`${url}/agent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(REQUEST) });
  assert.equal(unauthorized.status, 401);
  const oversized = { ...REQUEST, padding: 'x'.repeat(520 * 1024) };
  assert.equal((await call('/agent', oversized)).status, 413);
  assert.equal(calls, 0);
});

test('agent shares the gateway concurrency limit and releases capacity', async t => {
  const bothStarted = deferred();
  const release = deferred();
  let count = 0;
  const { call } = await start(t, async () => {
    if (++count === 2) bothStarted.resolve();
    await release.promise;
    return modelResponse([{ text: 'готово' }]);
  });
  const first = call('/agent', REQUEST);
  const second = call('/agent', REQUEST);
  await bothStarted.promise;
  assert.equal((await call('/agent', REQUEST)).status, 429);
  release.resolve();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal((await call('/agent', REQUEST)).status, 200);
});

test('agent client disconnect aborts upstream and releases its shared slot', async t => {
  const started = deferred();
  const aborted = deferred();
  let count = 0;
  const { call } = await start(t, async (url, { signal }) => {
    if (++count === 1) {
      started.resolve();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted.resolve(); reject(signal.reason); }, { once: true }));
    }
    return modelResponse([{ text: 'после отмены' }]);
  });
  const controller = new AbortController();
  const first = call('/agent', REQUEST, { signal: controller.signal }).catch(error => error);
  await started.promise;
  controller.abort();
  await aborted.promise;
  assert.equal((await first).name, 'AbortError');
  assert.equal((await call('/agent', REQUEST)).status, 200);
});

function localClient(url, fetchImpl = fetch, options = {}) {
  const gateway = new GeminiGateway('unused-test-directory', { fetchImpl, ...options });
  gateway.connect = async () => { gateway.url = url; gateway.token = TOKEN; };
  return gateway;
}

test('desktop agentStep bypasses chat text validation and validates its JSON result', async t => {
  const { url } = await start(t, async () => modelResponse([{ functionCall: { name: 'assistant_respond', args: { text: 'Готово' }, id: 'call-client' }, thoughtSignature: 'sig' }]));
  const gateway = localClient(url);
  t.after(() => gateway.close());
  const result = await gateway.agentStep(REQUEST);
  assert.equal(result.content.parts[0].functionCall.id, 'call-client');
  assert.equal(result.content.parts[0].thoughtSignature, 'sig');
  assert.equal(result.model, 'test-agent-model');
});

test('desktop agentStep exposes only structured upstream diagnostics', async t => {
  const gateway = localClient('http://not-used', async () => Response.json({
    error: 'Gemini unavailable',
    code: 'GEMINI_UPSTREAM_ERROR',
    upstreamStatus: 403,
    details: { status: 502, upstreamStatus: 403 },
    providerBody: 'secret prompt and key',
  }, { status: 502 }));
  t.after(() => gateway.close());
  await assert.rejects(gateway.agentStep(REQUEST), error => {
    assert.equal(error.code, GEMINI_ERROR_CODES.GEMINI_UPSTREAM_ERROR);
    assert.deepEqual(error.details, { status: 502, upstreamStatus: 403 });
    assert.doesNotMatch(error.message, /secret|prompt|key/u);
    return true;
  });
});

test('desktop agentStep retries transient upstream errors with the same payload', async t => {
  const requests = [];
  const delays = [];
  let calls = 0;
  const gateway = localClient('http://not-used', async (url, options) => {
    requests.push({ url, body: options.body });
    calls += 1;
    if (calls < 3) {
      const upstreamStatus = calls === 1 ? 429 : 503;
      return Response.json({ error: 'Gemini unavailable', code: 'GEMINI_UPSTREAM_ERROR', upstreamStatus, details: { status: 502, upstreamStatus } }, { status: 502 });
    }
    return Response.json({ content: { role: 'model', parts: [{ text: 'готово' }] }, model: 'test-agent-model', usage: null, latencyMs: 1 });
  }, { retryDelays: [2, 8], sleepImpl: async (milliseconds, signal) => { delays.push(milliseconds); signal?.throwIfAborted(); } });
  t.after(() => gateway.close());
  const result = await gateway.agentStep(REQUEST);
  assert.equal(result.content.parts[0].text, 'готово');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2, 8]);
  assert.equal(requests[0].url, 'http://not-used/agent');
  assert.deepEqual(requests.map(request => request.body), [requests[0].body, requests[0].body, requests[0].body]);
});

test('desktop agentStep does not retry permanent or malformed provider errors', async t => {
  for (const upstreamStatus of [400, 401, 403]) {
    let calls = 0;
    const gateway = localClient('http://not-used', async () => {
      calls += 1;
      return Response.json({ error: 'Gemini unavailable', code: 'GEMINI_UPSTREAM_ERROR', upstreamStatus, details: { status: 502, upstreamStatus } }, { status: 502 });
    }, { retryDelays: [0, 0], sleepImpl: () => { throw new Error('retry must not run'); } });
    await assert.rejects(gateway.agentStep(REQUEST), { code: GEMINI_ERROR_CODES.GEMINI_UPSTREAM_ERROR });
    assert.equal(calls, 1);
    gateway.close();
  }
  let calls = 0;
  const malformed = localClient('http://not-used', async () => {
    calls += 1;
    return Response.json({ error: 'Provider request failed', code: 'AGENT_MODEL_INVALID', validation: 'candidate.parts[0] is malformed' }, { status: 502 });
  }, { retryDelays: [0, 0], sleepImpl: () => { throw new Error('retry must not run'); } });
  await assert.rejects(malformed.agentStep(REQUEST), { code: GEMINI_ERROR_CODES.AGENT_MODEL_INVALID });
  assert.equal(calls, 1);
  malformed.close();
});

test('desktop agentStep cancellation aborts a transient retry delay', async t => {
  const waiting = deferred();
  let calls = 0;
  const gateway = localClient('http://not-used', async () => {
    calls += 1;
    return Response.json({ error: 'Gemini unavailable', code: 'GEMINI_UPSTREAM_ERROR', upstreamStatus: 429 }, { status: 502 });
  }, {
    retryDelays: [2000, 8000],
    sleepImpl: (milliseconds, signal) => new Promise((resolve, reject) => {
      waiting.resolve();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  t.after(() => gateway.close());
  const controller = new AbortController();
  const request = gateway.agentStep(REQUEST, { signal: controller.signal });
  await waiting.promise;
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('desktop agentStep preserves cancellation and close lifetime abort', async () => {
  const started = deferred();
  const gateway = localClient('http://not-used', async (url, { signal }) => {
    started.resolve();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(gateway.agentStep(REQUEST, { signal: cancelled.signal }), { name: 'AbortError' });
  const request = gateway.agentStep(REQUEST);
  await started.promise;
  gateway.close();
  await assert.rejects(request, { name: 'AbortError' });
});
