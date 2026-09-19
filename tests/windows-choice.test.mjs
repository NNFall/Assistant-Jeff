import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWindowsChoiceRequest, chooseWindowsAction } from '../desktop/providers/windows-choice.mjs';

const state = () => ({
  command: 'Не закрывай Chrome, сверни HAPP, затем открой первую вкладку ВК в Яндекс Браузере.',
  observation: { app: 'Windows desktop', summary: 'HAPP window Normal. Chrome window Normal. Яндекс Браузер window Normal; contents not inspected.' },
  phase: 'windows',
  candidates: [
    { id: 'happ_minimize', label: 'Свернуть HAPP', operation: 'minimize' },
    { id: 'chrome_close', label: 'Закрыть Chrome', operation: 'close' },
    { id: 'yandex_inspect', label: 'Прочитать элементы окна Яндекс Браузер', operation: 'inspect' },
  ],
  completed: [], constraints: ['Do not type or send messages.'],
});
function answer(labels, choice, confidence = 1, probability = 1) {
  const probabilities = Object.fromEntries(labels.map(label => [label, label === choice ? probability : 0]));
  if (probability !== 1) probabilities[labels.find(label => label !== choice)] = 1 - probability;
  return { type: 'choice', choice, confidence, probabilities };
}
function payload(input, next = 'happ_minimize', goal = 'not_achieved') {
  const request = buildWindowsChoiceRequest(input);
  return { model: 'jev-latest', answers: {
    next_action: answer(Object.keys(request.questions.next_action.criteria), next),
    goal_status: answer(Object.keys(request.questions.goal_status.criteria), goal),
  }, usage: { input_tokens: 700, output_tokens: 60 } };
}
const choose = (input, result, options = {}) => chooseWindowsAction(input, { apiKey: 'mock-key', fetchImpl: async () => new Response(JSON.stringify(result)), ...options });

test('two independent Choice questions select a supplied Windows action with no generated arguments', async () => {
  const input = state(); const result = payload(input);
  const decision = await choose(input, result, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer mock-key');
    assert.deepEqual(JSON.parse(options.body).state, input);
    input.candidates[0].id = 'changed_during_fetch';
    return new Response(JSON.stringify(result));
  } });
  assert.equal(decision.actionId, 'happ_minimize');
  assert.equal(decision.goalStatus, 'not_achieved');
  assert.deepEqual(decision.probabilities, result.answers.next_action.probabilities);
  assert.deepEqual(Object.keys(decision).sort(), ['actionId', 'choice', 'confidence', 'goalConfidence', 'goalProbability', 'goalStatus', 'latencyMs', 'model', 'probabilities', 'probability', 'usage']);
});

test('mixed negation and unknown contents are preserved as source data with explicit interpretation rules', () => {
  const request = buildWindowsChoiceRequest(state());
  assert.equal(request.state.command, state().command);
  assert.match(request.questions.next_action.instructions, /Negated actions are forbidden/u);
  assert.match(request.questions.next_action.instructions, /separate affirmative clause/u);
  assert.match(request.questions.next_action.instructions, /contents.*unknown.*inspect/u);
  assert.match(request.questions.next_action.instructions, /Polite action requests/u);
  assert.match(request.questions.next_action.instructions, /untrusted UI data/u);
  assert.match(request.questions.goal_status.instructions, /Inspection alone never proves/u);
  assert.ok(Object.hasOwn(request.questions.next_action.criteria, 'no_request'));
  // This verifies the request contract, not the model's semantic accuracy.
});

test('window-only commands describe activate directly when that action is already supplied', () => {
  const input = {
    command: 'Открой Steam.', phase: 'controls', completed: [],
    observation: { app: 'Windows desktop', summary: 'Steam exists, is minimized and not foreground. Window contents are unknown.' },
    candidates: [
      { id: 'steam_activate', label: 'Активировать Steam', operation: 'activate' },
      { id: 'steam_restore', label: 'Восстановить Steam', operation: 'restore' },
    ],
  };
  const request = buildWindowsChoiceRequest(input);
  assert.match(request.questions.next_action.instructions, /matching real window\/control action is already supplied, select it directly/u);
  assert.match(request.questions.next_action.instructions, /EXISTING selected window, select its supplied activate action/u);
  assert.match(request.questions.next_action.criteria.steam_activate, /restore it if minimized/u);
  assert.match(request.questions.next_action.criteria.steam_restore, /not merely to show\/open\/focus/u);
  assert.match(request.questions.goal_status.instructions, /Mere presence in the window inventory is not enough/u);
  // Prompt/contract regression only; actual Jev choice needs a separate live run.
});

test('hierarchical access selects a window before exposing its actual operations', () => {
  const access = {
    command: 'Сверни Steam.', phase: 'windows', completed: [],
    observation: { app: 'Windows desktop', summary: 'Steam window Normal. No automation target selected.' },
    candidates: [{ id: 'steam_inspect', label: 'Выбрать и прочитать Steam', operation: 'inspect' }],
  };
  const first = buildWindowsChoiceRequest(access);
  assert.deepEqual(Object.keys(first.questions.next_action.criteria), ['steam_inspect', 'done', 'unsupported', 'no_request']);
  assert.match(first.questions.next_action.instructions, /In phase windows, no window is selected/u);
  assert.match(first.questions.next_action.criteria.steam_inspect, /required ACCESS step/u);
  assert.match(first.questions.next_action.criteria.steam_inspect, /including a pure show\/minimize\/close goal/u);
  const selected = {
    ...access, phase: 'controls',
    completed: [{ id: 'steam_inspect', label: 'Выбрать и прочитать Steam', outcome: 'verified', evidence: 'Steam selected; window Normal.' }],
    candidates: [
      { id: 'steam_minimize', label: 'Свернуть Steam', operation: 'minimize' },
      { id: 'other_inspect', label: 'Выбрать другое окно', operation: 'inspect' },
    ],
  };
  const second = buildWindowsChoiceRequest(selected);
  assert.ok(Object.hasOwn(second.questions.next_action.criteria, 'steam_minimize'));
  assert.ok(Object.hasOwn(second.questions.next_action.criteria, 'other_inspect'));
  assert.equal(Object.hasOwn(second.questions.next_action.criteria, 'steam_inspect'), false);
  assert.match(second.questions.next_action.instructions, /selected window is automatically observed again after each step/u);
  // This verifies hierarchical candidate semantics; live model selection is separate.
});

test('ordered window commands evaluate earlier native evidence and latest applicable state separately', () => {
  const input = {
    command: 'Покажи Google Chrome, затем сверни Google Chrome.', phase: 'windows',
    observation: { app: 'Windows desktop', summary: 'Google Chrome is minimized and not foreground.' },
    candidates: [],
    completed: [
      { id: 'chrome_activate', label: 'Показать Google Chrome', outcome: 'verified', evidence: 'window_active: visible, not minimized, foreground' },
      { id: 'chrome_minimize', label: 'Свернуть Google Chrome', outcome: 'verified', evidence: 'window_minimized: minimized, not foreground' },
    ],
  };
  const request = buildWindowsChoiceRequest(input);
  assert.deepEqual(request.state.completed, input.completed);
  for (const question of Object.values(request.questions)) {
    assert.match(question.instructions, /Do not require mutually exclusive states to hold simultaneously/u);
    assert.match(question.instructions, /window_active then window_minimized receipts/u);
  }
  assert.match(request.questions.goal_status.instructions, /foreground AT THAT STEP/u);
  assert.match(request.questions.goal_status.criteria.achieved, /later requested step may supersede an earlier state/u);
  assert.match(request.questions.goal_status.criteria.not_achieved, /Do not select merely because an earlier verified state was intentionally superseded/u);
  // Checks the evidence contract, not live model accuracy or completion acceptance.
});

test('UI Automation control tasks do not introduce activation for an inactive nonminimized window', () => {
  const input = {
    command: 'Выбери первую вкладку ВКонтакте в Яндекс Браузере.', phase: 'windows', completed: [],
    observation: { app: 'Windows desktop', summary: 'Яндекс Браузер is Normal, not foreground; its tabs have not been inspected.' },
    candidates: [
      { id: 'browser_inspect', label: 'Прочитать элементы Яндекс Браузера', operation: 'inspect' },
      { id: 'browser_activate', label: 'Показать Яндекс Браузер', operation: 'activate' },
    ],
  };
  const request = buildWindowsChoiceRequest(input);
  assert.match(request.questions.next_action.instructions, /Activation is NOT a prerequisite/u);
  assert.match(request.questions.next_action.instructions, /unknown tab\/control in a nonminimized window, inspect directly/u);
  assert.match(request.questions.next_action.criteria.browser_activate, /only to expose a MINIMIZED surface/u);
  assert.match(request.questions.next_action.criteria.browser_inspect, /even when it is inactive or behind other windows/u);
  assert.match(request.questions.goal_status.instructions, /foreground is not a requirement for a control\/tab goal/u);
  // Adapter-semantics contract; live selection is tested separately by the caller.
});

test('effects require BOTH user-selected 0.80 probability and confidence boundaries', async () => {
  const input = state(); const request = buildWindowsChoiceRequest(input);
  for (const [probability, confidence, expected] of [[0.8, 0.8, 'happ_minimize'], [0.799, 1, null], [1, 0.799, null]]) {
    const result = payload(input);
    result.answers.next_action = answer(Object.keys(request.questions.next_action.criteria), 'happ_minimize', confidence, probability);
    assert.equal((await choose(input, result)).actionId, expected);
  }
  for (const stop of ['done', 'unsupported', 'no_request']) assert.equal((await choose(input, payload(input, stop))).actionId, null);
});

test('completion preserves independent goal judgment and does not turn done into an action', async () => {
  const input = state();
  const completionGate = result => result.choice === 'done' && result.goalStatus === 'achieved' && result.probability >= 0.8 && result.confidence >= 0.8 && result.goalProbability >= 0.8 && result.goalConfidence >= 0.8;
  for (const goal of ['unknown', 'not_achieved', 'achieved']) {
    const result = await choose(input, payload(input, 'done', goal));
    assert.equal(result.actionId, null);
    assert.equal(completionGate(result), goal === 'achieved');
  }
  for (const [probability, confidence] of [[0.79, 1], [1, 0.79]]) {
    const result = payload(input, 'done', 'achieved');
    result.answers.goal_status = answer(['achieved', 'not_achieved', 'unknown'], 'achieved', confidence, probability);
    assert.equal(completionGate(await choose(input, result)), false);
  }
});

test('completed candidate ids cannot replay; observed changes allow next steps but are not goal proof', async () => {
  const input = state(); const stale = payload(input);
  input.completed = [{ id: 'happ_minimize', label: 'Свернуть HAPP', outcome: 'verified', evidence: 'windowState Minimized' }];
  assert.equal(Object.hasOwn(buildWindowsChoiceRequest(input).questions.next_action.criteria, 'happ_minimize'), false);
  await assert.rejects(choose(input, stale), { code: 'WINDOWS_CHOICE_RESPONSE' });
  for (const outcome of ['verified', 'success', 'observed_change', ' OBSERVED_CHANGE ']) {
    input.completed[0].outcome = outcome;
    assert.equal((await choose(input, payload(input, 'yandex_inspect', 'unknown'))).actionId, 'yandex_inspect');
  }
  assert.match(buildWindowsChoiceRequest(input).questions.goal_status.instructions, /observed_change.*does not verify/u);
});

test('failed, uncertain or unknown outcome history exposes only safe stop options', async () => {
  for (const outcome of ['failed', 'uncertain', 'not_verified', 'sent', 'observed', 'unknown_outcome']) {
    const input = state(); const stale = payload(input);
    input.completed = [{ id: 'prior', label: 'Предыдущее действие', outcome }];
    assert.deepEqual(Object.keys(buildWindowsChoiceRequest(input).questions.next_action.criteria), ['done', 'unsupported', 'no_request']);
    await assert.rejects(choose(input, stale), { code: 'WINDOWS_CHOICE_RESPONSE' });
  }
});

test('malformed model, usage, question sets and either probability distribution fail closed', async () => {
  const input = state();
  for (const mutate of [
    p => { p.model = 'other-provider'; },
    p => { p.usage.input_tokens = -1; },
    p => { p.usage.output_tokens = 0.5; },
    p => { p.answers.extra = {}; },
    p => { delete p.answers.goal_status; },
    p => { p.answers.next_action.choice = 'unobserved'; },
    p => { p.answers.next_action.confidence = 1.01; },
    p => { delete p.answers.next_action.probabilities.chrome_close; },
    p => { p.answers.next_action.probabilities.unknown = 0; },
    p => { p.answers.next_action.probabilities.happ_minimize = 0.5; },
    p => { p.answers.next_action.probabilities.happ_minimize = 0.4; p.answers.next_action.probabilities.chrome_close = 0.6; },
    p => { p.answers.goal_status.type = 'noul'; },
    p => { p.answers.goal_status.probabilities.achieved = -1; },
    p => { p.answers.goal_status.confidence = '1'; },
  ]) {
    const result = payload(input); mutate(result);
    await assert.rejects(choose(input, result), { code: 'WINDOWS_CHOICE_RESPONSE' });
  }
});

test('rejected known response fields remain inspectable with precise safe validation diagnostics', async () => {
  const input = state(); const result = payload(input);
  result.answers.goal_status.probabilities.not_achieved = 0.97;
  let audited;
  await assert.rejects(choose(input, result, { onResponse: data => { audited = data; } }), error => error.code === 'WINDOWS_CHOICE_RESPONSE' && error.validationError.reason === 'probability_sum');
  assert.equal(audited.validation, 'rejected');
  assert.deepEqual(audited.validationError, { code: 'WINDOWS_CHOICE_RESPONSE', reason: 'probability_sum', question: 'goal_status', sum: 0.97 });
  assert.deepEqual(audited.answers, result.answers);
  assert.deepEqual(audited.usage, result.usage);
});

test('small API probability mass rounding is preserved raw and never raises scores across the action gate', async () => {
  const input = state();
  for (const [probability, remainder, expectedAction] of [[0.8, 0.19, 'happ_minimize'], [0.799, 0.191, null], [0.8, 0.21, 'happ_minimize']]) {
    const result = payload(input);
    result.answers.next_action.probabilities.happ_minimize = probability;
    result.answers.next_action.probabilities.unsupported = remainder;
    const decision = await choose(input, result);
    assert.equal(decision.probability, probability);
    assert.equal(decision.actionId, expectedAction);
    assert.deepEqual(decision.probabilities, result.answers.next_action.probabilities);
  }
  const largeError = payload(input); largeError.answers.next_action.probabilities.happ_minimize = 0.9;
  await assert.rejects(choose(input, largeError), error => error.code === 'WINDOWS_CHOICE_RESPONSE' && error.validationError.reason === 'probability_sum');
});

test('invalid response audit excludes arbitrary strings, nested data and unexpected probability labels', async () => {
  const input = state(); const result = payload(input);
  result.model = 'PRIVATE_MODEL';
  result.usage = { input_tokens: { secret: 'PRIVATE_USAGE' }, output_tokens: 1, secret: 'PRIVATE_EXTRA' };
  result.answers.next_action.type = 'PRIVATE_TYPE';
  result.answers.next_action.choice = 'PRIVATE_CHOICE';
  result.answers.next_action.confidence = 'PRIVATE_CONFIDENCE';
  result.answers.next_action.probabilities.happ_minimize = { secret: 'PRIVATE_VALUE' };
  result.answers.next_action.probabilities.PRIVATE_LABEL = 0;
  result.answers.next_action.secret = 'PRIVATE_NESTED';
  result.answers.PRIVATE_QUESTION = { secret: 'PRIVATE_ANSWER' };
  let audited;
  await assert.rejects(choose(input, result, { apiKey: 'PRIVATE_ACTUAL_KEY', onResponse: data => { audited = data; } }), { code: 'WINDOWS_CHOICE_RESPONSE' });
  assert.doesNotMatch(JSON.stringify(audited), /PRIVATE_/u);
  assert.equal(audited.model, '[invalid model]');
  assert.equal(audited.answers.next_action.choice, '[invalid choice]');
  assert.equal(audited.answers.next_action.probabilities.happ_minimize, '[invalid number]');
  assert.deepEqual(Object.keys(audited.answers), ['next_action', 'goal_status']);
});

test('missing and extra probability labels are reported as counts without echoing unknown names', async () => {
  const input = state(); const result = payload(input);
  delete result.answers.next_action.probabilities.chrome_close;
  result.answers.next_action.probabilities.PRIVATE_LABEL = 0;
  let audited;
  await assert.rejects(choose(input, result, { onResponse: data => { audited = data; } }), { code: 'WINDOWS_CHOICE_RESPONSE' });
  assert.deepEqual(audited.validationError, { code: 'WINDOWS_CHOICE_RESPONSE', reason: 'probability_fields', question: 'next_action', missingCount: 1, unexpectedCount: 1 });
  assert.equal(Object.hasOwn(audited.answers.next_action.probabilities, 'chrome_close'), false);
  assert.doesNotMatch(JSON.stringify(audited), /PRIVATE_LABEL/u);
});

test('closed operations, unique ids, optional evidence, candidate count and input limits are enforced', () => {
  for (const mutate of [
    s => { s.command = 'x'.repeat(1025); },
    s => { s.observation.summary = 'x'.repeat(24001); },
    s => { s.observation.app = ''; },
    s => { s.candidates.push({ ...s.candidates[0] }); },
    s => { s.candidates[0].operation = 'shell'; },
    s => { s.candidates[0].id = '../window'; },
    s => { s.candidates[0].id = 'done'; },
    s => { s.candidates[0].id = 'constructor'; },
    s => { s.candidates[0].label = 'x'.repeat(801); },
    s => { s.candidates = Array.from({ length: 97 }, (_, i) => ({ id: `w${i}`, label: 'window', operation: 'inspect' })); },
    s => { s.completed = Array.from({ length: 25 }, (_, i) => ({ id: `h${i}`, label: 'window', outcome: 'verified' })); },
    s => { s.completed = [{ id: 'prior', label: 'window', outcome: 'verified', evidence: { raw: 'unbounded' } }]; },
    s => { s.phase = 'anything'; },
    s => { s.constraints = { raw: 'object' }; },
    s => { s.constraints = Array(13).fill('x'); },
  ]) {
    const input = state(); mutate(input);
    assert.throws(() => buildWindowsChoiceRequest(input), { code: 'WINDOWS_CHOICE_INPUT' });
  }
  const max = state(); max.candidates = Array.from({ length: 96 }, (_, i) => ({ id: `w${i}`, label: `Window ${i}`, operation: 'inspect' }));
  assert.equal(Object.keys(buildWindowsChoiceRequest(max).questions.next_action.criteria).length, 99);
  max.candidates = []; max.constraints = 'Only supplied operations.';
  assert.deepEqual(Object.keys(buildWindowsChoiceRequest(max).questions.next_action.criteria), ['done', 'unsupported', 'no_request']);
  const byteLimit = state(); byteLimit.candidates = Array.from({ length: 96 }, (_, i) => ({ id: `w${i}`, label: 'Я'.repeat(800), operation: 'inspect' }));
  assert.throws(() => buildWindowsChoiceRequest(byteLimit), { code: 'WINDOWS_CHOICE_INPUT' });
});

test('private extra input fields and credentials are excluded from request body and response hook', async () => {
  const input = state(); input.secret = 'PRIVATE_INPUT'; input.observation.screenshot = 'PRIVATE_IMAGE'; input.candidates[0].shell = 'PRIVATE_SHELL';
  assert.doesNotMatch(JSON.stringify(buildWindowsChoiceRequest(input)), /PRIVATE_/u);
  const result = payload(input); result.headers = { Authorization: 'PRIVATE_REMOTE_HEADER' }; result.apiKey = 'PRIVATE_REMOTE_KEY';
  result.answers.next_action.secret = 'PRIVATE_NESTED_ANSWER'; result.usage.secret = 'PRIVATE_NESTED_USAGE';
  let audited;
  const chosen = await choose(input, result, { apiKey: 'PRIVATE_ACTUAL_KEY', onResponse: data => {
    audited = structuredClone(data);
    data.answers.next_action.choice = 'chrome_close';
  } });
  assert.equal(chosen.actionId, 'happ_minimize');
  assert.deepEqual(Object.keys(audited).sort(), ['answers', 'model', 'usage']);
  assert.doesNotMatch(JSON.stringify(audited), /PRIVATE_/u);
});

test('late responses from an abort-ignoring transport cannot emit an audit event', async () => {
  const input = state(); const controller = new AbortController(); let resolveFetch;
  const pending = choose(input, payload(input), {
    signal: controller.signal,
    fetchImpl: () => new Promise(resolve => { resolveFetch = resolve; }),
    onResponse: () => assert.fail('no audit after the caller receives cancellation'),
  });
  controller.abort();
  await assert.rejects(pending, { code: 'WINDOWS_CHOICE_ABORTED' });
  resolveFetch(new Response(JSON.stringify(payload(input))));
  await new Promise(resolve => setImmediate(resolve));
});

test('invalid keys, cancellation, HTTP failures and network errors cannot yield an action', async () => {
  const input = state();
  for (const apiKey of ['', 'key\nInjected: yes', 'key\tbad']) await assert.rejects(choose(input, payload(input), { apiKey }), { code: 'WINDOWS_CHOICE_KEY' });
  await assert.rejects(choose(input, payload(input), { signal: AbortSignal.abort(), fetchImpl: () => assert.fail('no fetch after abort') }), { code: 'WINDOWS_CHOICE_ABORTED' });
  const cancellation = new AbortController();
  await assert.rejects(choose(input, payload(input), { signal: cancellation.signal, onResponse: () => cancellation.abort() }), { code: 'WINDOWS_CHOICE_ABORTED' });
  await assert.rejects(choose(input, payload(input), { fetchImpl: async () => new Response('PRIVATE_ERROR', { status: 401 }) }), error => error.code === 'WINDOWS_CHOICE_HTTP' && !error.message.includes('PRIVATE'));
  await assert.rejects(choose(input, payload(input), { fetchImpl: async () => { throw new Error('PRIVATE_NETWORK'); } }), error => error.code === 'WINDOWS_CHOICE_NETWORK' && !error.message.includes('PRIVATE'));
});

test('response byte limits hold for streamed and text fallback bodies before the audit hook', async () => {
  const input = state();
  for (const response of [new Response('x'.repeat(65537)), new Response('{}', { headers: { 'content-length': '65537' } }), { ok: true, text: async () => 'Я'.repeat(32769) }]) {
    await assert.rejects(choose(input, null, { fetchImpl: async () => response, onResponse: () => assert.fail('oversized body must not enter audit') }), { code: 'WINDOWS_CHOICE_RESPONSE' });
  }
  await assert.rejects(choose(input, null, { fetchImpl: async () => new Response('not JSON') }), { code: 'WINDOWS_CHOICE_RESPONSE' });
});
