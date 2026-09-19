import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseUiAction, buildUiChoiceRequest } from '../desktop/providers/ui-choice.mjs';

const input = () => ({ command: 'Выбери тёмную тему', observation: { app: 'Settings', summary: 'Appearance page with theme choices' }, candidates: [{ id: 'theme_dark', label: 'Тёмная тема', operation: 'select' }, { id: 'theme_light', label: 'Светлая тема', operation: 'select' }], completed: [] });
function payload(state, choice = 'theme_dark', confidence = 1, probability = 1) {
  const labels = Object.keys(buildUiChoiceRequest(state).questions.next_action.criteria);
  const probabilities = Object.fromEntries(labels.map(id => [id, id === choice ? probability : 0]));
  if (probability !== 1) probabilities.unsupported = 1 - probability;
  return { model: 'jev-latest', usage: { input_tokens: 150, output_tokens: 30 }, answers: { next_action: { type: 'choice', choice, confidence, probabilities } } };
}
function choose(state, result, inspect = () => {}) {
  return chooseUiAction(state, { apiKey: 'fake-key', fetchImpl: async (url, options) => { inspect(url, options); return new Response(JSON.stringify(result)); } });
}

test('chooses only current candidate id and exposes validated full distribution', async () => {
  const state = input();
  const result = payload(state);
  const answer = await choose(state, result, (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body).state, state);
    state.candidates[0].id = 'mutated_later';
  });
  assert.equal(answer.actionId, 'theme_dark');
  assert.deepEqual(answer.probabilities, result.answers.next_action.probabilities);
  assert.deepEqual(Object.keys(answer).sort(), ['actionId', 'choice', 'confidence', 'latencyMs', 'model', 'probabilities', 'probability', 'usage']);
});

test('user-selected probability/confidence boundaries and stop options produce no accidental action', async () => {
  const state = input();
  assert.equal((await choose(state, payload(state, 'theme_dark', 0.8, 0.85))).actionId, 'theme_dark');
  assert.equal((await choose(state, payload(state, 'theme_dark', 0.79, 1))).actionId, null);
  assert.equal((await choose(state, payload(state, 'theme_dark', 1, 0.84))).actionId, null);
  for (const stop of ['done', 'unsupported']) assert.equal((await choose(state, payload(state, stop))).actionId, null);
});

test('unknown id, missing/extra distribution fields and malformed probabilities fail closed', async () => {
  const state = input();
  for (const change of [
    p => { p.answers.next_action.choice = 'unseen'; },
    p => { delete p.answers.next_action.probabilities.theme_light; },
    p => { p.answers.next_action.probabilities.unseen = 0; },
    p => { p.answers.next_action.probabilities.theme_dark = 0.5; },
    p => { p.answers.next_action.confidence = -0.1; },
    p => { p.answers.next_action.probabilities.theme_dark = 0.4; p.answers.next_action.probabilities.theme_light = 0.6; },
    p => { p.usage.input_tokens = -1; }
  ]) {
    const result = payload(state); change(result);
    await assert.rejects(choose(state, result), { code: 'UI_RESPONSE' });
  }
});

test('completed ids are excluded and failed outcomes expose stops only', async () => {
  const state = input();
  const stale = payload(state);
  state.completed.push({ id: 'theme_dark', label: 'Тёмная тема', outcome: 'verified' });
  assert.equal(Object.hasOwn(buildUiChoiceRequest(state).questions.next_action.criteria, 'theme_dark'), false);
  await assert.rejects(choose(state, stale), { code: 'UI_RESPONSE' });
  for (const outcome of ['failed', 'unknown', 'not_verified', 'click_not_verified', 'new_unrecognized_outcome']) {
    state.completed[0].outcome = outcome;
    assert.deepEqual(Object.keys(buildUiChoiceRequest(state).questions.next_action.criteria), ['done', 'unsupported']);
    await assert.rejects(choose(state, stale), { code: 'UI_RESPONSE' });
  }
});

test('only verified or success outcomes permit progression to another candidate', async () => {
  for (const outcome of ['verified', 'success', ' VERIFIED ', 'SUCCESS']) {
    const state = input();
    state.completed.push({ id: 'prior_step', label: 'Открыта страница тем', outcome });
    assert.equal((await choose(state, payload(state))).actionId, 'theme_dark');
  }
});

test('input bounds and projection reject unsafe shapes and drop private extra fields', () => {
  const state = input();
  state.secret = 'PRIVATE EXTRA';
  state.observation.screenshot = 'PRIVATE IMAGE';
  state.candidates[0].shell = 'PRIVATE COMMAND';
  assert.doesNotMatch(JSON.stringify(buildUiChoiceRequest(state)), /PRIVATE/);
  for (const mutate of [
    s => { s.candidates.push({ ...s.candidates[0] }); },
    s => { s.candidates[0].id = 'done'; },
    s => { s.candidates[0].operation = 'shell'; },
    s => { s.command = 'x'.repeat(4097); },
    s => { s.observation.summary = ''; },
    s => { s.candidates[0].id = '../path'; },
    s => { s.candidates[0].label = 'x'.repeat(501); }
  ]) { const bad = input(); mutate(bad); assert.throws(() => buildUiChoiceRequest(bad), { code: 'UI_INPUT' }); }
  const empty = input(); empty.candidates = [];
  assert.deepEqual(Object.keys(buildUiChoiceRequest(empty).questions.next_action.criteria), ['done', 'unsupported']);
});

test('aborted requests never return action; network errors and oversized bodies are sanitized', async () => {
  const state = input();
  await assert.rejects(chooseUiAction(state, { apiKey: 'fake-key', signal: AbortSignal.abort(), fetchImpl: () => assert.fail('no fetch') }), { code: 'UI_ABORTED' });
  const controller = new AbortController();
  await assert.rejects(chooseUiAction(state, { apiKey: 'fake-key', signal: controller.signal, fetchImpl: async () => { controller.abort(); return new Response(JSON.stringify(payload(state))); } }), { code: 'UI_ABORTED' });
  await assert.rejects(chooseUiAction(state, { apiKey: 'fake-key', fetchImpl: async () => { throw new Error('SECRET'); } }), error => error.code === 'UI_NETWORK' && !error.message.includes('SECRET'));
  await assert.rejects(chooseUiAction(state, { apiKey: 'fake-key', fetchImpl: async () => new Response('x'.repeat(65537)) }), { code: 'UI_RESPONSE' });
});
