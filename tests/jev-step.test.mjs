import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJevStepRequest, chooseJevStep } from '../desktop/providers/jev-step.mjs';

const state = () => ({
  command: 'Не закрывай Chrome. Сверни HAPP, затем открой первую вкладку ВК в Яндексе.',
  observation: { app: 'Desktop', windows: [{ id: 'w1', name: 'HAPP', state: 'Normal' }, { id: 'w2', name: 'Яндекс', controls: 'unknown' }] },
  candidates: [
    { id: 'happ_minimize', label: 'Свернуть HAPP', operation: 'minimize', effect: 'window becomes minimized', target: { window: 'w1' } },
    { id: 'yandex_read', label: 'Прочитать элементы Яндекса', operation: 'inspect', effect: 'read', target: { window: 'w2' } },
  ],
  recentSteps: [], context: { surface: 'windows' },
});
function payload(input, choice = 'happ_minimize', probability = 1, confidence = 1) {
  const labels = Object.keys(buildJevStepRequest(input).questions.next_step.criteria);
  const probabilities = Object.fromEntries(labels.map(label => [label, label === choice ? probability : 0]));
  if (probability < 1) probabilities[labels.find(label => label !== choice)] = 1 - probability;
  return { model: 'jev-1.13.0', answers: { next_step: { type: 'choice', choice, confidence, probabilities } }, usage: { input_tokens: 500, output_tokens: 30 } };
}
const choose = (input, response = payload(input), options = {}) => chooseJevStep(input, {
  apiKey: 'mock-key', fetchImpl: async () => new Response(JSON.stringify(response)), ...options,
});

test('one compact Choice preserves full command, structured evidence and exact caller-supplied IDs', () => {
  const input = state();
  input.recentSteps = Array.from({ length: 12 }, (_, index) => ({ id: `step${index}`, outcome: 'verified', evidence: { observed: index } }));
  input.secret = 'PRIVATE_INPUT';
  const request = buildJevStepRequest(input);
  assert.deepEqual(Object.keys(request.questions), ['next_step']);
  assert.equal(request.model, 'jev-latest');
  assert.equal(request.questions.next_step.type, 'choice');
  assert.deepEqual(Object.keys(request.questions.next_step.criteria), ['happ_minimize', 'yandex_read', 'done', 'unavailable']);
  assert.equal(request.state.command, input.command);
  assert.deepEqual(request.state.recentSteps, input.recentSteps.slice(-8));
  assert.deepEqual(request.state.candidates, input.candidates);
  assert.deepEqual(request.state.observation, input.observation);
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE_INPUT/u);
  input.candidates[0].target.window = 'mutated';
  input.observation.windows[0].name = 'mutated';
  input.recentSteps[11].evidence.observed = 'mutated';
  assert.equal(request.state.candidates[0].target.window, 'w1');
  assert.equal(request.state.observation.windows[0].name, 'HAPP');
  assert.equal(request.state.recentSteps[7].evidence.observed, 11);
  // Offline size guard, not a claim about the service tokenizer or semantic accuracy.
  assert.ok(request.questions.next_step.instructions.length < 2400);
  assert.ok(Buffer.byteLength(JSON.stringify(buildJevStepRequest(state())), 'utf8') < 4000);
});

test('empty candidates, omitted operation/history, and string observations remain valid', async () => {
  const input = { command: 'Открой заметки', observation: 'No matching application is available.', candidates: [] };
  assert.deepEqual(buildJevStepRequest(input).state.recentSteps, []);
  assert.deepEqual(Object.keys(buildJevStepRequest(input).questions.next_step.criteria), ['done', 'unavailable']);
  assert.equal((await choose(input, payload(input, 'unavailable'))).actionId, null);
  input.candidates = [{ id: 'read_apps', label: 'Прочитать список доступных приложений' }];
  assert.equal((await choose(input, payload(input, 'read_apps'))).actionId, 'read_apps');
});

test('transport sends the exported request and returns only the fixed result contract', async () => {
  const input = state(); const response = payload(input); const expectedRequest = buildJevStepRequest(input);
  const result = await choose(input, response, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer mock-key');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), expectedRequest);
    input.candidates[0].id = 'changed_during_fetch';
    return new Response(JSON.stringify(response));
  } });
  assert.equal(result.actionId, 'happ_minimize');
  assert.deepEqual(result.probabilities, response.answers.next_step.probabilities);
  assert.deepEqual(Object.keys(result).sort(), ['actionId', 'choice', 'confidence', 'latencyMs', 'model', 'probabilities', 'probability', 'usage']);
  assert.ok(Number.isInteger(result.latencyMs) && result.latencyMs >= 0);
});

test('both 0.80 gates must pass and terminal choices never become action IDs', async () => {
  const input = state();
  for (const [probability, confidence, expected] of [[0.8, 0.8, 'happ_minimize'], [0.799, 1, null], [1, 0.799, null]]) {
    const result = await choose(input, payload(input, 'happ_minimize', probability, confidence));
    assert.equal(result.choice, 'happ_minimize');
    assert.equal(result.actionId, expected);
    assert.equal(result.probability, probability);
  }
  for (const terminal of ['done', 'unavailable']) for (const confidence of [0.79, 1]) {
    const result = await choose(input, payload(input, terminal, 1, confidence));
    assert.equal(result.choice, terminal);
    assert.equal(result.actionId, null);
    assert.equal(result.confidence, confidence);
  }
});

test('malformed answers, unknown IDs, missing labels and invalid probabilities fail closed', async () => {
  const input = state();
  for (const mutate of [
    p => { p.model = 'another-model'; },
    p => { p.usage.input_tokens = -1; },
    p => { p.usage.output_tokens = 0.1; },
    p => { p.answers.extra = {}; },
    p => { delete p.answers.next_step; },
    p => { p.answers.next_step.type = 'noul'; },
    p => { p.answers.next_step.choice = 'unknown'; },
    p => { p.answers.next_step.confidence = 1.01; },
    p => { p.answers.next_step.confidence = '1'; },
    p => { p.answers.next_step.probabilities = []; },
    p => { delete p.answers.next_step.probabilities.yandex_read; },
    p => { p.answers.next_step.probabilities.unknown = 0; },
    p => { p.answers.next_step.probabilities.yandex_read = -0.1; },
    p => { p.answers.next_step.probabilities.yandex_read = '0'; },
    p => { p.answers.next_step.probabilities.happ_minimize = 0.5; },
    p => { p.answers.next_step.probabilities.happ_minimize = 0.4; p.answers.next_step.probabilities.yandex_read = 0.6; },
  ]) {
    const response = payload(input); mutate(response);
    await assert.rejects(choose(input, response), { code: 'JEV_STEP_RESPONSE' });
  }
  for (const response of [null, [], {}, { answers: null }]) await assert.rejects(choose(input, response), { code: 'JEV_STEP_RESPONSE' });
});

test('small probability rounding is retained without promoting a below-threshold action', async () => {
  const input = state();
  for (const [probability, other, expected] of [[0.8, 0.19, 'happ_minimize'], [0.799, 0.191, null], [0.8, 0.21, 'happ_minimize']]) {
    const response = payload(input); response.answers.next_step.probabilities.happ_minimize = probability;
    response.answers.next_step.probabilities.unavailable = other;
    const result = await choose(input, response);
    assert.equal(result.probability, probability);
    assert.equal(result.actionId, expected);
  }
});

test('invalid input IDs, text sizes, duplicate candidates and JSON metadata are rejected', () => {
  for (const mutate of [
    s => { s.command = ''; },
    s => { s.command = 'x'.repeat(4097); },
    s => { s.observation = 'x'.repeat(24001); },
    s => { s.observation = { huge: 'x'.repeat(24000) }; },
    s => { s.observation = null; },
    s => { s.candidates[0].id = 'done'; },
    s => { s.candidates[0].id = 'unavailable'; },
    s => { s.candidates[0].id = 'constructor'; },
    s => { s.candidates[0].id = '../target'; },
    s => { s.candidates[0].id = '__proto__'; },
    s => { s.candidates.push({ ...s.candidates[0] }); },
    s => { s.candidates[0].label = 'x'.repeat(801); },
    s => { s.candidates[0].operation = ''; },
    s => { s.candidates[0].target = { huge: 'x'.repeat(4000) }; },
    s => { s.candidates = Array.from({ length: 97 }, (_, index) => ({ id: `c${index}`, label: 'read' })); },
    s => { s.candidates = Array.from({ length: 96 }, (_, index) => ({ id: `c${index}`, label: 'x'.repeat(600) })); },
    s => { s.context = { huge: 'x'.repeat(6000) }; },
    s => { s.recentSteps = [{ evidence: 'x'.repeat(16000) }]; },
    s => { s.recentSteps = 'not an array'; },
    s => { s.observation = { bad: Number.NaN }; },
    s => { s.observation = { bad: () => 'text' }; },
    s => { s.observation.self = s.observation; },
    s => { s.observation = new Date(); },
  ]) {
    const input = state(); mutate(input);
    assert.throws(() => buildJevStepRequest(input), { code: 'JEV_STEP_INPUT' });
  }
  const input = state(); input.command = 'x'.repeat(4096);
  input.candidates = Array.from({ length: 96 }, (_, index) => ({ id: `c${index}`, label: 'read', operation: 'inspect' }));
  assert.equal(Object.keys(buildJevStepRequest(input).questions.next_step.criteria).length, 98);
});

test('large fresh candidate menus preserve every label and metadata without silent truncation', () => {
  const input = state();
  input.candidates = Array.from({ length: 86 }, (_, index) => ({
    id: `step_${index + 1}`, label: `Открыть наблюдаемый элемент ${index + 1}: ${'название '.repeat(30).trim()}`,
    operation: 'inspect', effect: 'read', target: { group: 'Панель задач', ordinal: index + 1 },
  }));
  const candidateChars = JSON.stringify(input.candidates).length;
  assert.ok(candidateChars > 24000 && candidateChars < 48000);
  const request = buildJevStepRequest(input);
  assert.deepEqual(request.state.candidates, input.candidates);
  for (const candidate of input.candidates) assert.equal(request.questions.next_step.criteria[candidate.id], candidate.label);
  assert.ok(Buffer.byteLength(JSON.stringify(request.state), 'utf8') < 128 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(request), 'utf8') < 192 * 1024);
});

test('validated audit is detached and strips extra remote fields and credentials', async () => {
  const input = state(); const response = payload(input);
  response.apiKey = 'PRIVATE_REMOTE_KEY'; response.answers.next_step.secret = 'PRIVATE_NESTED'; response.usage.secret = 'PRIVATE_USAGE';
  let audited;
  const result = await choose(input, response, { apiKey: 'PRIVATE_ACTUAL_KEY', onResponse: data => {
    audited = structuredClone(data); data.answers.next_step.choice = 'yandex_read'; data.answers.next_step.probabilities.happ_minimize = 0;
  } });
  assert.equal(result.actionId, 'happ_minimize');
  assert.equal(result.probabilities.happ_minimize, 1);
  assert.deepEqual(Object.keys(audited).sort(), ['answers', 'model', 'usage']);
  assert.doesNotMatch(JSON.stringify(audited), /PRIVATE_/u);
});

test('rejected audit preserves safe diagnostics without arbitrary server strings', async () => {
  const input = state(); const response = payload(input);
  response.answers.next_step.probabilities.happ_minimize = 0.9;
  let audited;
  await assert.rejects(choose(input, response, { onResponse: data => { audited = data; } }), { code: 'JEV_STEP_RESPONSE' });
  assert.deepEqual(audited.validationError, { code: 'JEV_STEP_RESPONSE', reason: 'probability_sum', question: 'next_step', sum: 0.9 });
  assert.deepEqual(audited.answers, response.answers);
  response.model = 'PRIVATE_MODEL'; response.usage.input_tokens = { secret: 'PRIVATE_USAGE' };
  response.answers.next_step.type = 'PRIVATE_TYPE'; response.answers.next_step.choice = 'PRIVATE_CHOICE';
  response.answers.next_step.confidence = 'PRIVATE_CONFIDENCE'; response.answers.next_step.probabilities.happ_minimize = { secret: 'PRIVATE_VALUE' };
  response.answers.next_step.probabilities.PRIVATE_LABEL = 0;
  await assert.rejects(choose(input, response, { onResponse: data => { audited = data; } }), { code: 'JEV_STEP_RESPONSE' });
  assert.doesNotMatch(JSON.stringify(audited), /PRIVATE_/u);
  assert.equal(audited.answers.next_step.choice, '[invalid choice]');
  assert.equal(audited.answers.next_step.probabilities.happ_minimize, '[invalid number]');
});

test('cancellation prevents fetch or suppresses late transport and audit responses', async () => {
  const input = state();
  await assert.rejects(choose(input, payload(input), { signal: AbortSignal.abort(), fetchImpl: () => assert.fail('no fetch') }), { code: 'JEV_STEP_ABORTED' });
  const controller = new AbortController(); let resolveFetch; let transportSignal;
  const pending = choose(input, payload(input), { signal: controller.signal, fetchImpl: (_url, options) => {
    transportSignal = options.signal; return new Promise(resolve => { resolveFetch = resolve; });
  }, onResponse: () => assert.fail('no audit after abort') });
  controller.abort();
  await assert.rejects(pending, { code: 'JEV_STEP_ABORTED' });
  assert.equal(transportSignal.aborted, true);
  resolveFetch(new Response(JSON.stringify(payload(input))));
  await new Promise(resolve => setImmediate(resolve));
  const duringAudit = new AbortController();
  await assert.rejects(choose(input, payload(input), { signal: duringAudit.signal, onResponse: () => duringAudit.abort() }), { code: 'JEV_STEP_ABORTED' });
});

test('timeout cancels an abort-ignoring transport and discards its late response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input = state(); let resolveFetch; let transportSignal;
  const pending = choose(input, payload(input), { fetchImpl: (_url, options) => {
    transportSignal = options.signal; return new Promise(resolve => { resolveFetch = resolve; });
  }, onResponse: () => assert.fail('no audit after timeout') });
  t.mock.timers.tick(12000);
  await assert.rejects(pending, { code: 'JEV_STEP_TIMEOUT' });
  assert.equal(transportSignal.aborted, true);
  resolveFetch(new Response(JSON.stringify(payload(input))));
  await new Promise(resolve => setImmediate(resolve));
});

test('bad keys and transport errors fail without exposing response bodies or network secrets', async () => {
  const input = state();
  for (const apiKey of ['', 'key\nInjected: yes', 'key\tbad']) await assert.rejects(choose(input, payload(input), { apiKey, fetchImpl: () => assert.fail('no fetch') }), { code: 'JEV_STEP_KEY' });
  await assert.rejects(choose(input, payload(input), { fetchImpl: async () => new Response('PRIVATE_HTTP', { status: 401 }) }), error => error.code === 'JEV_STEP_HTTP' && !error.message.includes('PRIVATE'));
  await assert.rejects(choose(input, payload(input), { fetchImpl: async () => { throw new Error('PRIVATE_NETWORK'); } }), error => error.code === 'JEV_STEP_NETWORK' && !error.message.includes('PRIVATE'));
});

test('response limits reject oversized stream, header and fallback text before audit', async () => {
  const input = state();
  for (const response of [new Response('x'.repeat(65537)), new Response('{}', { headers: { 'content-length': '65537' } }), { ok: true, text: async () => 'Я'.repeat(32769) }, new Response('not JSON')]) {
    await assert.rejects(choose(input, null, { fetchImpl: async () => response, onResponse: () => assert.fail('unbounded/invalid body is not audited') }), { code: 'JEV_STEP_RESPONSE' });
  }
});
