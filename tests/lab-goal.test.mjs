import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLabGoalRequest, compileLabGoal } from '../desktop/providers/lab-goal.mjs';
import { DEFAULT_FACTS, validateCommand, goalSatisfied } from '../scripts/desktop-lab/goal-contract.mjs';

const input = command => ({ command: command ?? 'Включи воспроизведение', currentFacts: { ...DEFAULT_FACTS } });
function response(state, choices = {}) {
  const request = buildLabGoalRequest(state);
  const defaults = { request_kind: 'execute', requested_fields: 'playback', desired_tab: 'keep', desired_playing: 'on', desired_language: 'keep', ...choices };
  return { model: 'jev-latest', usage: { input_tokens: 500, output_tokens: 100 }, answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key, { type: 'choice', choice: defaults[key], confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(label => [label, label === defaults[key] ? 1 : 0])) }])) };
}
const compile = (state, result, options = {}) => compileLabGoal(state, { apiKey: 'fake-key', fetchImpl: async () => new Response(JSON.stringify(result)), ...options });

test('one request compiles compound final predicates and keep remains unconstrained', async () => {
  const state = input('Открой видео ВК, выключи музыку и выбери русский внутри стенда');
  const result = await compile(state, response(state, { requested_fields: 'all', desired_tab: 'VK video', desired_playing: 'off', desired_language: 'Russian' }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.goal, { selectedTab: 'VK video', playing: false, language: 'Russian' });
  assert.equal(goalSatisfied(result.goal, { facts: result.goal }), true);
  assert.equal(goalSatisfied(result.goal, { facts: { ...result.goal, playing: true } }), false);
  const simple = await compile(input(), response(input()));
  assert.deepEqual(simple.goal, { playing: true });
  assert.equal(goalSatisfied(simple.goal, { facts: { selectedTab: 'Music', playing: true, language: 'Russian' } }), true);
});

test('no_action and unsupported never yield an executable goal, nor does empty execute', async () => {
  for (const [command, kind] of [['Не включай музыку', 'no_action'], ['Объясни фразу «включи музыку»', 'no_action'], ['Включи и потом выключи музыку', 'unsupported'], ['Открой вкладку и внешний браузер', 'unsupported']]) {
    const state = input(command);
    const result = await compile(state, response(state, { request_kind: kind }));
    assert.equal(result.ok, false); assert.equal(result.reason, kind); assert.equal(result.goal, null);
  }
  const result = await compile(input(), response(input(), { desired_playing: 'keep' }));
  assert.equal(result.ok, false); assert.equal(result.reason, 'unsupported'); assert.equal(result.goal, null);
});

test('uncertain stop choices still return no goal while execute and reset stay gated', async () => {
  for (const kind of ['no_action', 'unsupported']) {
    const state = input('Ничего не делай');
    const r = response(state, { request_kind: kind });
    const answer = r.answers.request_kind;
    answer.confidence = 0.1;
    answer.probabilities[kind] = 0.4;
    const other = Object.keys(answer.probabilities).filter(label => label !== kind);
    for (const label of other) answer.probabilities[label] = 0.2;
    const result = await compile(state, r);
    assert.equal(result.ok, false);
    assert.equal(result.goal, null);
    assert.equal(result.reason, kind);
  }
  for (const kind of ['execute', 'reset']) {
    const r = response(input(), { request_kind: kind });
    r.answers.request_kind.confidence = 0.79;
    const result = await compile(input(), r);
    assert.equal(result.ok, false);
    assert.equal(result.goal, null);
    assert.equal(result.reason, 'low_confidence');
  }
});

test('uncertain unused fields do not block execute; used fields and mask must be certain', async () => {
  const state = input();
  const uncertain = response(state);
  uncertain.answers.desired_language.confidence = 0.79;
  uncertain.answers.desired_tab.confidence = 0;
  assert.deepEqual((await compile(state, uncertain)).goal, { playing: true });
  uncertain.answers.desired_playing.confidence = 0.79;
  assert.equal((await compile(state, uncertain)).reason, 'low_confidence');
  const maskUncertain = response(state);
  maskUncertain.answers.requested_fields.confidence = 0.79;
  assert.equal((await compile(state, maskUncertain)).reason, 'low_confidence');
  const reset = response(state, { request_kind: 'reset' });
  for (const field of ['requested_fields', 'desired_tab', 'desired_playing', 'desired_language']) reset.answers[field].confidence = 0;
  const result = await compile(state, reset);
  assert.equal(result.ok, true); assert.deepEqual(result.goal, DEFAULT_FACTS);
  reset.answers.request_kind.confidence = 0.79;
  assert.equal((await compile(state, reset)).reason, 'low_confidence');
});

test('all response branches require exact known labels and valid distributions', async () => {
  for (const change of [
    r => { delete r.answers.desired_tab; },
    r => { delete r.answers.requested_fields; },
    r => { r.answers.requested_fields.choice = 'external'; },
    r => { delete r.answers.requested_fields.probabilities.none; },
    r => { r.answers.desired_tab.choice = 'external'; },
    r => { delete r.answers.desired_tab.probabilities.Music; },
    r => { r.answers.desired_tab.probabilities.extra = 0; },
    r => { r.answers.desired_playing.probabilities.on = 0.5; },
    r => { r.answers.desired_playing.probabilities.on = -1; },
    r => { r.answers.desired_playing.confidence = NaN; },
    r => { r.answers.desired_tab.probabilities.keep = 0.4; r.answers.desired_tab.probabilities.Music = 0.6; },
  ]) {
    const r = response(input()); change(r);
    await assert.rejects(compile(input(), r), { code: 'LAB_GOAL_RESPONSE' });
  }
});

test('probability and confidence boundaries apply to mask and consumed dimensions', async () => {
  const state = input();
  const r = response(state);
  for (const [key, answer] of Object.entries(r.answers)) {
    answer.confidence = 0.8;
    answer.probabilities[answer.choice] = 0.8;
    const other = Object.keys(answer.probabilities).find(label => label !== answer.choice);
    answer.probabilities[other] = 0.2;
  }
  assert.equal((await compile(state, r)).ok, true);
  r.answers.requested_fields.probabilities.playback = 0.79;
  r.answers.requested_fields.probabilities.none = 0.21;
  assert.equal((await compile(state, r)).reason, 'low_confidence');
});

test('mask selects precisely its fields and rejects keep in a requested field', async () => {
  const state = input();
  const choices = { desired_tab: 'VK feed', desired_playing: 'off', desired_language: 'Russian' };
  for (const [mask, goal] of [
    ['tab', { selectedTab: 'VK feed' }], ['playback', { playing: false }], ['language', { language: 'Russian' }],
    ['tab_playback', { selectedTab: 'VK feed', playing: false }], ['tab_language', { selectedTab: 'VK feed', language: 'Russian' }], ['playback_language', { playing: false, language: 'Russian' }],
  ]) assert.deepEqual((await compile(state, response(state, { ...choices, requested_fields: mask }))).goal, goal);
  assert.equal((await compile(state, response(state, { requested_fields: 'none' }))).reason, 'unsupported');
  assert.equal((await compile(state, response(state, { requested_fields: 'tab' }))).reason, 'unsupported');
});

test('command/fact bounds and projected hooks exclude extras and credentials', async () => {
  for (const command of ['', ' ', null, 'x'.repeat(1025), 'x\0y']) assert.throws(() => validateCommand(command), { code: 'LAB_GOAL_INPUT' });
  assert.equal(validateCommand(' x '), 'x');
  assert.throws(() => buildLabGoalRequest({ command: 'x', currentFacts: { ...DEFAULT_FACTS, playing: 'yes' } }), { code: 'LAB_GOAL_INPUT' });
  const state = input(); state.secret = 'PRIVATE'; state.currentFacts.extra = 'PRIVATE';
  const r = response(state); r.private = 'PRIVATE';
  const hooks = [];
  await compile(state, r, { onRequest: data => { hooks.push(data); data.state.command = 'Mutated copy'; }, onResponse: data => hooks.push(data) });
  assert.doesNotMatch(JSON.stringify(hooks), /PRIVATE|fake-key|Authorization/);
  assert.equal(goalSatisfied({}, { facts: DEFAULT_FACTS }), false);
  assert.equal(goalSatisfied({ playing: 'on' }, { facts: DEFAULT_FACTS }), false);
});

test('pre/during abort, oversized reply and network errors never return goals', async () => {
  await assert.rejects(compileLabGoal(input(), { apiKey: 'fake', signal: AbortSignal.abort(), fetchImpl: () => assert.fail('No request') }), { code: 'LAB_GOAL_ABORTED' });
  const controller = new AbortController();
  await assert.rejects(compile(input(), response(input()), { signal: controller.signal, onResponse: () => controller.abort() }), { code: 'LAB_GOAL_ABORTED' });
  await assert.rejects(compileLabGoal(input(), { apiKey: 'fake', fetchImpl: async () => new Response('x'.repeat(65537)) }), { code: 'LAB_GOAL_RESPONSE' });
  await assert.rejects(compileLabGoal(input(), { apiKey: 'fake', fetchImpl: async () => { throw new Error('SECRET'); } }), error => error.code === 'LAB_GOAL_NETWORK' && !error.message.includes('SECRET'));
});
