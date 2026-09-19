import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObservedCandidates, runObservedTask } from '../desktop/automation/observed-task.mjs';

const snapshot = (version = 'v1') => ({ version, app: 'Fixture', summary: 'Observed controls', elements: [{ id: 'settings', label: 'Настройки', capabilities: ['activate'] }, { id: 'dark', label: 'Тёмная тема', capabilities: ['select', 'click'] }] });
const decision = candidate => ({ choice: candidate.id, actionId: candidate.id, probability: 0.8, confidence: 0.8 });
function fixture(overrides = {}) {
  let state = snapshot();
  let goal = false;
  const executions = [];
  const modelInputs = [];
  const adapter = {
    observe: () => structuredClone(state),
    execute: (candidate, options) => { executions.push({ candidate, version: options.expectedVersion }); state = snapshot('v2'); goal = true; return { sent: true, private: 'LOCAL RECEIPT' }; },
    verify: () => ({ outcome: 'verified', evidence: 'Fixture state changed as requested.' }),
    isGoalSatisfied: () => goal,
    ...overrides,
  };
  const choose = async input => { modelInputs.push(input); return decision(input.candidates[0]); };
  return { adapter, choose, executions, modelInputs, setState: value => { state = value; } };
}
const run = (f, options = {}) => runObservedTask({ command: 'Открой настройки', adapter: f.adapter, choose: f.choose, ...options });

test('dynamic candidates are stable by target/operation, bounded, and contain no private fields', () => {
  const before = snapshot();
  before.elements[0].handle = 999;
  before.screenshot = 'PRIVATE';
  const candidates = buildObservedCandidates(before);
  assert.deepEqual(candidates, [
    { id: 'a_dark_select', targetId: 'dark', label: 'Тёмная тема', operation: 'select' },
    { id: 'a_dark_click', targetId: 'dark', label: 'Тёмная тема', operation: 'click' },
    { id: 'a_settings_activate', targetId: 'settings', label: 'Настройки', operation: 'activate' },
  ]);
  before.elements.reverse();
  assert.deepEqual(buildObservedCandidates(before), candidates);
  const invalid = snapshot(); invalid.elements[0].capabilities = ['shell'];
  assert.throws(() => buildObservedCandidates(invalid));
  const many = snapshot(); many.elements = Array.from({ length: 17 }, (_, i) => ({ id: `x${i}`, label: 'Item', capabilities: ['click', 'select'] }));
  assert.throws(() => buildObservedCandidates(many));
});

test('successful loop sends projected model input and independently verifies goal', async () => {
  const f = fixture();
  const privateSnapshot = snapshot(); privateSnapshot.handle = 777; privateSnapshot.screenshot = 'PRIVATE IMAGE';
  privateSnapshot.elements[0].native = 'PRIVATE HANDLE'; f.setState(privateSnapshot);
  const result = await run(f);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'goal_verified');
  assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0].version, 'v1');
  assert.deepEqual(Object.keys(f.modelInputs[0]), ['command', 'observation', 'candidates', 'completed']);
  assert.deepEqual(Object.keys(f.modelInputs[0].candidates[0]), ['id', 'label', 'operation']);
  assert.doesNotMatch(JSON.stringify(f.modelInputs), /PRIVATE|targetId|screenshot|handle/);
  assert.doesNotMatch(JSON.stringify(result), /LOCAL RECEIPT|PRIVATE/);
  assert.equal(result.completed[0].outcome, 'verified');
});

test('unknown ids, unsupported and low confidence never execute', async () => {
  for (const [response, reason] of [
    [{ choice: 'missing', actionId: 'missing', probability: 1, confidence: 1 }, 'unknown_action'],
    [{ choice: 'unsupported', actionId: null }, 'unsupported'],
    [{ choice: 'g1_a_dark_select', actionId: null }, 'no_action'],
    [{ choice: 'g1_a_dark_select', actionId: 'g1_a_dark_select', probability: 0.79, confidence: 1 }, 'low_confidence'],
    [{ choice: 'g1_a_dark_select', actionId: 'g1_a_dark_select', probability: 1, confidence: 0.79 }, 'low_confidence'],
  ]) {
    const f = fixture();
    const result = await run(f, { choose: async () => response });
    assert.equal(result.reason, reason);
    assert.equal(f.executions.length, 0);
  }
});

test('stale observation triggers bounded reobserve without executing old choice', async () => {
  let observations = 0;
  const f = fixture({ observe: () => snapshot(`v${++observations}`), isGoalSatisfied: () => false });
  const result = await run(f, { maxSteps: 2 });
  assert.equal(result.reason, 'step_limit');
  assert.equal(f.executions.length, 0);
  assert.equal(result.trace.filter(event => event.phase === 'stale').length, 2);
});

test('a changed snapshot can be reconsidered once and execute only with new version', async () => {
  let observations = 0;
  let complete = false;
  const executedVersions = [];
  const f = fixture({
    observe: () => snapshot(++observations === 1 ? 'v1' : 'v2'),
    execute: (candidate, { expectedVersion }) => { executedVersions.push(expectedVersion); complete = true; return {}; },
    isGoalSatisfied: () => complete,
  });
  const result = await run(f);
  assert.equal(result.ok, true);
  assert.deepEqual(executedVersions, ['v2']);
});

test('abort after model response stops before effect', async () => {
  const controller = new AbortController();
  const f = fixture();
  const result = await run(f, { signal: controller.signal, choose: async input => { controller.abort(); return decision(input.candidates[0]); } });
  assert.equal(result.reason, 'aborted');
  assert.equal(f.executions.length, 0);
});

test('model done cannot replace independent goal evidence', async () => {
  const f = fixture({ isGoalSatisfied: () => false });
  const result = await run(f, { choose: async () => ({ choice: 'done', actionId: null }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'goal_not_verified');
  assert.equal(f.executions.length, 0);
});

test('unverified or absent verification stops, even if goal method would report success', async () => {
  for (const verification of [undefined, { outcome: 'not_verified', evidence: 'Click had no observed effect.' }, { outcome: 'verified' }]) {
    const f = fixture({ verify: () => verification });
    const result = await run(f);
    assert.equal(result.reason, 'not_verified');
    assert.equal(result.ok, false);
    assert.equal(f.executions.length, 1);
    assert.deepEqual(result.completed, []);
  }
});

test('partial failure keeps earlier verified completion and never retries uncertain effect', async () => {
  let version = 1;
  let effects = 0;
  const f = fixture({
    observe: () => snapshot(`v${version}`),
    execute: () => { effects++; version++; if (effects === 2) throw new Error('PRIVATE failure'); return {}; },
    isGoalSatisfied: () => false,
  });
  const result = await run(f);
  assert.equal(result.reason, 'execution_uncertain');
  assert.equal(effects, 2);
  assert.equal(result.completed.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('deadline bounds an unresponsive executor and aborts its signal without retry', async () => {
  let effects = 0;
  let executeSignal;
  const f = fixture({ execute: (candidate, { signal }) => { effects++; executeSignal = signal; return new Promise(() => {}); } });
  const result = await run(f, { maxDurationMs: 30 });
  assert.equal(result.reason, 'time_limit');
  assert.equal(effects, 1);
  assert.equal(executeSignal.aborted, true);
  assert.equal(result.ok, false);
});

test('invalid snapshots and missing execution receipts stop without retry', async () => {
  const invalid = fixture({ observe: () => ({}) });
  assert.equal((await run(invalid)).reason, 'invalid_snapshot');
  assert.equal(invalid.executions.length, 0);
  let calls = 0;
  const missing = fixture({ execute: () => { calls++; return undefined; } });
  assert.equal((await run(missing)).reason, 'execution_uncertain');
  assert.equal(calls, 1);
});

test('fresh generations permit A to B to A while preserving prior labels as history', async () => {
  let version = 1;
  const targets = [];
  const candidatesSeen = [];
  const historySeen = [];
  const adapter = {
    observe: () => ({ version: `v${version}`, app: 'Fixture', summary: 'Two tabs', elements: [
      { id: 'tabA', label: 'Tab A', capabilities: ['activate'] },
      { id: 'tabB', label: 'Tab B', capabilities: ['activate'] },
    ] }),
    execute: candidate => { targets.push(candidate.targetId); version++; return {}; },
    verify: () => ({ outcome: 'verified', evidence: 'Requested tab is active.' }),
    isGoalSatisfied: () => targets.length === 3,
  };
  const result = await runObservedTask({ command: 'Переключись A, затем B, затем A', adapter, choose: async input => {
    const desired = targets.length === 1 ? 'Tab B' : 'Tab A';
    const selected = input.candidates.find(candidate => candidate.label === desired);
    candidatesSeen.push(selected.id);
    historySeen.push(input.completed.map(item => item.label));
    return decision(selected);
  } });
  assert.equal(result.ok, true);
  assert.deepEqual(targets, ['tabA', 'tabB', 'tabA']);
  assert.deepEqual(candidatesSeen, ['g1_a_tabA_activate', 'g2_a_tabB_activate', 'g3_a_tabA_activate']);
  assert.deepEqual(historySeen, [[], ['Tab A'], ['Tab A', 'Tab B']]);
});

test('same generation cannot replay the already verified candidate', async () => {
  let effects = 0;
  let choices = 0;
  const adapter = {
    observe: () => ({ version: 'fixed', app: 'Fixture', summary: 'One control', elements: [{ id: 'tabA', label: 'Tab A', capabilities: ['activate'] }] }),
    execute: () => { effects++; return {}; },
    verify: () => ({ outcome: 'verified', evidence: 'Action observed.' }),
    isGoalSatisfied: () => false,
  };
  const result = await runObservedTask({ command: 'Активируй вкладку', adapter, choose: async input => { choices++; return decision(input.candidates[0]); } });
  assert.equal(result.reason, 'no_candidates');
  assert.equal(effects, 1);
  assert.equal(choices, 1);
});
