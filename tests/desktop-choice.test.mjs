import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDesktopChoiceRequest, chooseDesktopAction } from '../desktop/providers/desktop-choice.mjs';

const initial = () => ({ command: 'Сверни Хром и закрой HAPP', windows: [{ id: 'chrome-1', appId: 'chrome', appName: 'Google Chrome', minimized: false }, { id: 412, appId: 'happ', appName: 'HAPP', minimized: false }], completed: [] });
function payload(input, choice, confidence = 1) {
  const labels = Object.keys(buildDesktopChoiceRequest(input).questions.next_action.criteria);
  return { model: 'jev-latest', usage: { input_tokens: 120, output_tokens: 30 }, answers: { next_action: { type: 'choice', choice, confidence, probabilities: Object.fromEntries(labels.map(label => [label, label === choice ? 1 : 0])) } } };
}
function mockFetch(response, inspect = () => {}) {
  return async (url, init) => { inspect(url, init); return new Response(JSON.stringify(response), { status: 200 }); };
}
const choose = (input, response) => chooseDesktopAction(input, { apiKey: 'fake-key', fetchImpl: mockFetch(response) });

test('request exposes exactly observed bounded candidates and explicit order/negation rubric', () => {
  const request = buildDesktopChoiceRequest(initial());
  assert.deepEqual(Object.keys(request.questions.next_action.criteria), ['w0_minimize', 'w0_close', 'w1_minimize', 'w1_close', 'done', 'unsupported']);
  const rubric = request.questions.next_action.instructions;
  for (const fragment of ['Preserve the order', 'Never repeat', 'negated', 'Quoted commands', 'No shell', 'NOT quit process', 'untrusted DATA']) assert.ok(rubric.includes(fragment), fragment);
  assert.match(request.questions.next_action.criteria.w1_close, /CLOSE WINDOW/);
  assert.equal(request.state.command, initial().command);
  assert.deepEqual(Object.keys(request), ['model', 'state', 'questions']);
});

test('selector maps high-confidence label to snapshot window only, without generated arguments', async () => {
  const input = initial();
  const answer = await chooseDesktopAction(input, { apiKey: 'fake-key', fetchImpl: mockFetch(payload(input, 'w0_minimize'), (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer fake-key');
    assert.deepEqual(JSON.parse(init.body).state, input);
    input.windows[0].id = 'changed-after-request';
  }) });
  assert.deepEqual(answer.action, { windowId: 'chrome-1', appId: 'chrome', operation: 'minimize' });
  assert.equal(answer.probability, 1);
  assert.deepEqual(answer.probabilities, payload(initial(), 'w0_minimize').answers.next_action.probabilities);
  assert.equal(answer.confidence, 1);
  assert.ok(Number.isFinite(answer.latencyMs));
});

test('completed and satisfied operations are omitted; stale omitted selections reject', async () => {
  const input = initial();
  const staleMinimize = payload(input, 'w0_minimize');
  input.completed.push({ appId: 'chrome', operation: 'minimize', outcome: 'verified' });
  assert.equal(Object.hasOwn(buildDesktopChoiceRequest(input).questions.next_action.criteria, 'w0_minimize'), false);
  await assert.rejects(choose(input, staleMinimize), { code: 'DESKTOP_RESPONSE' });
  assert.deepEqual((await choose(input, payload(input, 'w1_close'))).action, { windowId: 412, appId: 'happ', operation: 'close' });
  const staleHappMinimize = payload(input, 'w1_minimize');
  input.windows[1].minimized = true;
  assert.deepEqual(Object.keys(buildDesktopChoiceRequest(input).questions.next_action.criteria), ['w0_close', 'w1_close', 'done', 'unsupported']);
  await assert.rejects(choose(input, staleHappMinimize), { code: 'DESKTOP_RESPONSE' });
  // Original indices remain intact, even though earlier operation labels vanished.
  assert.deepEqual((await choose(input, payload(input, 'w1_close'))).action, { windowId: 412, appId: 'happ', operation: 'close' });
  input.windows.push({ id: 'other-happ', appId: 'happ', appName: 'HAPP', minimized: false });
  assert.equal((await choose(input, payload(input, 'w1_close'))).action, null);
});

test('done, unsupported and uncertain selections have no executable action', async () => {
  const input = initial();
  for (const choice of ['done', 'unsupported']) assert.equal((await choose(input, payload(input, choice))).action, null);
  assert.equal((await choose(input, payload(input, 'w0_minimize', 0.79))).action, null);
  const uncertain = payload(input, 'w0_minimize');
  uncertain.answers.next_action.probabilities.w0_minimize = 0.79;
  uncertain.answers.next_action.probabilities.unsupported = 0.21;
  assert.equal((await choose(input, uncertain)).action, null);
  const boundary = payload(input, 'w0_minimize', 0.8);
  boundary.answers.next_action.probabilities.w0_minimize = 0.8;
  boundary.answers.next_action.probabilities.unsupported = 0.2;
  assert.deepEqual((await choose(input, boundary)).action, { windowId: 'chrome-1', appId: 'chrome', operation: 'minimize' });
});

test('failed or unverified prior step exposes only stops and rejects stale actions', async () => {
  for (const outcome of ['not_verified', 'failed', 'unknown']) {
    const input = initial();
    const stale = payload(input, 'w1_close');
    input.completed.push({ appId: 'chrome', operation: 'minimize', outcome });
    assert.deepEqual(Object.keys(buildDesktopChoiceRequest(input).questions.next_action.criteria), ['done', 'unsupported']);
    await assert.rejects(choose(input, stale), { code: 'DESKTOP_RESPONSE' });
    const answer = await choose(input, payload(input, 'unsupported'));
    assert.equal(answer.action, null);
  }
});

test('unknown, stale, invalid probability and missing labels reject without actions', async () => {
  const input = initial();
  const invalids = [
    p => { p.answers.next_action.choice = 'w9_close'; },
    p => { p.answers.next_action.probabilities.stale_window = 0; },
    p => { delete p.answers.next_action.probabilities.done; },
    p => { p.answers.next_action.probabilities.w0_minimize = -1; },
    p => { p.answers.next_action.probabilities.w0_minimize = 0.2; },
    p => { p.answers.next_action.confidence = 1.1; },
    p => { p.answers.next_action.probabilities.w0_minimize = 0.4; p.answers.next_action.probabilities.done = 0.6; },
    p => { p.model = 'untrusted-model'; },
    p => { p.usage.input_tokens = -1; }
  ];
  for (const mutate of invalids) {
    const p = payload(input, 'w0_minimize'); mutate(p);
    await assert.rejects(choose(input, p), { code: 'DESKTOP_RESPONSE' });
  }
});

test('input projection discards extra private fields and validates bounds', () => {
  const input = initial();
  input.windows[0].title = 'Private browser page';
  input.apiKey = 'DO NOT INCLUDE';
  const body = JSON.stringify(buildDesktopChoiceRequest(input));
  assert.doesNotMatch(body, /Private browser page|DO NOT INCLUDE/);
  for (const bad of [{ ...initial(), command: '' }, { ...initial(), command: 'x'.repeat(4097) }, { ...initial(), windows: [{ id: 'x', appId: 'cmd', appName: 'cmd', minimized: false }] }, { ...initial(), completed: [{ appId: 'chrome', operation: 'kill', outcome: 'success' }] }]) assert.throws(() => buildDesktopChoiceRequest(bad), { code: 'DESKTOP_INPUT' });
  const duplicate = initial(); duplicate.windows.push({ ...duplicate.windows[0] });
  assert.throws(() => buildDesktopChoiceRequest(duplicate), { code: 'DESKTOP_INPUT' });
});

test('abort before/during fetch stops selection; network and oversized replies are sanitized', async () => {
  const input = initial();
  await assert.rejects(chooseDesktopAction(input, { apiKey: 'fake', signal: AbortSignal.abort(), fetchImpl: () => { throw new Error('Must not call'); } }), { code: 'DESKTOP_ABORTED' });
  const controller = new AbortController();
  await assert.rejects(chooseDesktopAction(input, { apiKey: 'fake', signal: controller.signal, fetchImpl: async () => { controller.abort(); return new Response(JSON.stringify(payload(input, 'w0_minimize'))); } }), { code: 'DESKTOP_ABORTED' });
  await assert.rejects(chooseDesktopAction(input, { apiKey: 'fake', fetchImpl: async () => { throw new Error('SECRET network details'); } }), error => error.code === 'DESKTOP_NETWORK' && !error.message.includes('SECRET'));
  await assert.rejects(chooseDesktopAction(input, { apiKey: 'fake', fetchImpl: async () => new Response('x'.repeat(65537)) }), { code: 'DESKTOP_RESPONSE' });
});
