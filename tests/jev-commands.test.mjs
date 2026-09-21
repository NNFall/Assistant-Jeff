import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JevCommands } from '../desktop/agent/jev-commands.mjs';
import { buildJevStepRequest } from '../desktop/providers/jev-step.mjs';
import { RunJournal } from '../scripts/desktop-lab/journal.mjs';

const command = 'Открой настройки звука и выбери колонки';
const action = (id = 'step_1', overrides = {}) => ({ id, label: 'Открыть настройки', operation: 'invoke', effect: true, stableKey: 'settings', ...overrides });
const selected = (id, overrides = {}) => ({ choice: id, actionId: ['done', 'unavailable'].includes(id) ? null : id, probability: 0.96, confidence: 0.91, probabilities: { [id]: 0.96 }, model: 'jev-test', latencyMs: 4, usage: { input_tokens: 120, output_tokens: 8 }, ...overrides });
const completed = (overrides = {}) => ({ ok: true, verified: true, effectAttempted: true, status: 'completed', message: 'Действие проверено.', evidence: 'native_postcondition', ...overrides });
const stale = (overrides = {}) => ({ ok: false, verified: false, effectAttempted: false, status: 'stale', error: 'STALE_SNAPSHOT', ...overrides });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function create(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jeff-jev-loop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new JevCommands({
    directory, apiKeyResolver: async () => 'synthetic-test-key',
    createSession: () => ({ observe: async () => ({ observation: { screen: 'settings' }, candidates: [action()] }), execute: async () => completed() }),
    choose: async () => selected('done'), ...options,
  });
}

test('Jev alone executes a three-step menu path and records assessed goal separately from native effects', async t => {
  let stage = 0;
  const inputs = [];
  const executions = [];
  const labels = ['Открыть меню', 'Открыть настройки звука', 'Выбрать колонки'];
  const service = await create(t, {
    createSession: ({ command: supplied, signal }) => {
      assert.equal(supplied, command);
      assert.equal(signal.aborted, false);
      return {
        observe: async () => ({ observation: { stage }, candidates: stage < 3 ? [action(`step_${stage}`, { label: labels[stage], stableKey: `stage_${stage}` })] : [], snapshot: { secretLargeSnapshot: true } }),
        execute: async (id, { signal: executionSignal }) => {
          assert.equal(executionSignal, signal);
          executions.push(id);
          stage++;
          return stage < 3 ? completed({ verified: false, effectConfirmed: true, status: 'dispatched', evidence: 'state_changed' }) : completed();
        },
      };
    },
    choose: async (input, { onResponse }) => {
      inputs.push(structuredClone(input));
      const result = selected(input.candidates[0]?.id ?? 'done');
      onResponse({ model: 'jev-test', decision: result });
      return result;
    },
  });
  const report = await service.run({ command });
  assert.equal(report.ok, true);
  assert.equal(report.reason, 'goal_model_assessed');
  assert.equal(report.goalVerification, 'model_assessed');
  assert.equal(report.effectVerification, 'observed_change');
  assert.equal(report.mode, 'JEV_DESKTOP');
  assert.equal(report.provider, 'jev');
  assert.deepEqual(executions, ['step_0', 'step_1', 'step_2']);
  assert.deepEqual(inputs.map(item => item.observation.stage), [0, 1, 2, 3]);
  assert.deepEqual(report.completed.map(item => item.outcome), ['observed_change', 'observed_change', 'verified']);
  assert.equal(service.running, false);
  assert.equal(service.activeRunId, null);
  assert.equal(service.clearContext(), true);
  const saved = JSON.parse(await readFile(report.logPath, 'utf8'));
  assert.equal(saved.status, 'finished');
  assert.deepEqual(saved.events.find(item => item.phase === 'model_request').request, buildJevStepRequest(inputs[0]));
  assert.equal(saved.events.filter(item => item.phase === 'model_response').length, 4);
  assert.equal(saved.events.find(item => item.phase === 'model_decision').label, labels[0]);
  assert.equal(saved.events.find(item => item.phase === 'execute_result').result.effectConfirmed, true);
  assert.doesNotMatch(JSON.stringify(inputs), /secretLargeSnapshot|synthetic-test-key/u);
});

test('unknown, mismatched and low-confidence choices never execute', async t => {
  for (const [result, expected] of [
    [selected('missing'), 'unknown_action'],
    [selected('different', { actionId: 'step_1' }), 'unknown_action'],
    [selected('done', { actionId: 'step_1' }), 'unknown_action'],
    [selected('step_1', { probability: 0.79 }), 'low_confidence'],
    [selected('step_1', { confidence: 0.79 }), 'low_confidence'],
    [selected('step_1', { confidence: 1.1 }), 'low_confidence'],
    [selected('step_1', { probability: Number.NaN }), 'low_confidence'],
  ]) {
    let effects = 0;
    const service = await create(t, {
      choose: async () => result,
      createSession: () => ({ observe: async () => ({ observation: {}, candidates: [action()] }), execute: async () => { effects++; return completed(); } }),
    });
    const report = await service.run({ command });
    assert.equal(report.reason, expected);
    assert.equal(report.ok, false);
    assert.equal(effects, 0);
  }
});

test('single flight, stop, and cancellation release a stalled model without effects', async t => {
  const entered = deferred();
  const service = await create(t, { choose: async () => { entered.resolve(); return new Promise(() => {}); } });
  const running = service.run({ command });
  await entered.promise;
  assert.equal(service.running, true);
  assert.ok(service.activeRunId);
  assert.equal(service.clearContext(), false);
  assert.throws(() => service.run({ command }), { code: 'TASK_ALREADY_RUNNING' });
  assert.equal(service.stop(), true);
  const report = await running;
  assert.equal(report.reason, 'aborted');
  assert.equal(report.executionUncertain, false);
  assert.equal(service.running, false);
  assert.equal(service.stop(), false);
});

test('external cancellation is applied before session creation', async t => {
  let sessions = 0;
  const controller = new AbortController();
  controller.abort();
  const service = await create(t, { createSession: () => { sessions++; return {}; } });
  const report = await service.run({ command, signal: controller.signal });
  assert.equal(report.reason, 'aborted');
  assert.equal(sessions, 0);
});

test('time limit bounds even a chooser that ignores AbortSignal', async t => {
  const service = await create(t, { maxDurationMs: 25, choose: async () => new Promise(() => {}) });
  const report = await service.run({ command });
  assert.equal(report.reason, 'time_limit');
  assert.equal(report.executionUncertain, false);
  assert.ok(report.elapsedMs < 2000);
});

test('an aborted in-flight effect holds the single-flight lock until the executor settles', async t => {
  const entered = deferred();
  const execution = deferred();
  const service = await create(t, {
    choose: async () => selected('step_1'),
    createSession: () => ({
      observe: async () => ({ observation: {}, candidates: [action()] }),
      execute: async () => { entered.resolve(); return execution.promise; },
    }),
  });
  const running = service.run({ command });
  await entered.promise;
  service.stop();
  const report = await running;
  assert.equal(report.reason, 'execution_uncertain');
  assert.equal(report.executionUncertain, true);
  assert.equal(service.running, true);
  assert.throws(() => service.run({ command }), { code: 'TASK_ALREADY_RUNNING' });
  execution.resolve(completed());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.running, false);
});

test('known pre-effect stale results trigger fresh observation and fresh selection', async t => {
  let observed = 0;
  let executed = 0;
  const chosen = [];
  const service = await create(t, {
    createSession: () => ({
      observe: async () => ({ observation: { version: ++observed }, candidates: [action(`step_${observed}`)] }),
      execute: async id => { chosen.push(id); return ++executed === 1 ? stale() : completed(); },
    }),
    choose: async input => selected(executed < 2 ? input.candidates[0].id : 'done'),
  });
  const report = await service.run({ command });
  assert.equal(report.ok, true);
  assert.deepEqual(chosen, ['step_1', 'step_2']);
  assert.equal(observed, 3);
  assert.equal(report.completed.length, 1);
  assert.ok(report.events.some(item => item.phase === 'stale'));
});

test('pre-effect stale exceptions are retried at most twice', async t => {
  let attempts = 0;
  const service = await create(t, {
    choose: async input => selected(input.candidates[0].id),
    createSession: () => ({
      observe: async () => ({ observation: {}, candidates: [action(`step_${attempts}`)] }),
      execute: async () => { attempts++; throw Object.assign(new Error('stale'), { code: 'STALE_SNAPSHOT', details: { effectAttempted: false } }); },
    }),
  });
  const report = await service.run({ command });
  assert.equal(attempts, 3);
  assert.equal(report.reason, 'stale_limit');
  assert.equal(report.executionUncertain, false);
});

test('unknown or failed effects stop instead of retrying even if their error says stale', async t => {
  for (const result of [{}, completed({ verified: false }), stale({ effectAttempted: true })]) {
    let attempts = 0;
    const service = await create(t, {
      choose: async () => selected('step_1'),
      createSession: () => ({ observe: async () => ({ observation: {}, candidates: [action()] }), execute: async () => { attempts++; return result; } }),
    });
    const report = await service.run({ command });
    assert.equal(attempts, 1);
    assert.equal(report.reason, 'execution_uncertain');
    assert.equal(report.executionUncertain, true);
  }
});

test('stale code without explicit pre-effect evidence is not safe to retry', async t => {
  const service = await create(t, {
    choose: async () => selected('step_1'),
    createSession: () => ({ observe: async () => ({ observation: {}, candidates: [action()] }), execute: async () => { throw Object.assign(new Error('stale'), { code: 'STALE_SNAPSHOT' }); } }),
  });
  const report = await service.run({ command });
  assert.equal(report.reason, 'execution_uncertain');
  assert.equal(report.events.filter(item => item.phase === 'execute_request').length, 1);
});

test('model history holds only the last eight compact outcomes, and no run-to-run UI ids', async t => {
  let sessions = 0;
  const inputs = [];
  const service = await create(t, {
    createSession: () => {
      sessions++;
      let stage = 0;
      return {
        observe: async () => ({ observation: { stage }, candidates: [action(`step_${sessions}_${stage}`, { stableKey: `stage_${stage}`, label: `Action ${stage}` })], snapshot: { completeSnapshot: 'x'.repeat(80000) } }),
        execute: async () => { stage++; return completed({ evidence: 'e'.repeat(1800), data: { snapshot: { completeSnapshot: 'x'.repeat(40000) }, actionId: 'old_action', controls: ['old_control'] } }); },
      };
    },
    choose: async input => { inputs.push(structuredClone(input)); return selected(input.observation.stage < 11 ? input.candidates[0].id : 'done'); },
  });
  const first = await service.run({ command });
  assert.equal(first.ok, true);
  assert.equal(inputs.length, 12);
  assert.deepEqual(inputs.at(-1).recentSteps.map(item => item.label), Array.from({ length: 8 }, (_, index) => `Action ${index + 3}`));
  assert.ok(inputs.every(item => item.recentSteps.length <= 8));
  assert.ok(inputs.every(item => JSON.stringify(item.recentSteps).length < 8000));
  assert.doesNotMatch(JSON.stringify(inputs), /completeSnapshot|old_action|old_control/u);
  assert.doesNotMatch(JSON.stringify(inputs.at(-1).recentSteps), /actionId|snapshot|controls|candidates|step_1_/u);
  await service.run({ command: 'Ещё раз открой настройки' });
  assert.deepEqual(inputs[12].recentSteps, []);
  assert.doesNotMatch(JSON.stringify(inputs[12]), /step_1_/u);
});

test('read-only inspect evidence and premature done do not count as completed goal', async t => {
  let inspected = false;
  const service = await create(t, {
    createSession: () => ({
      observe: async () => ({ observation: { inspected }, candidates: [action('inspect_1', { operation: 'inspect', effect: false })] }),
      execute: async () => { inspected = true; return completed({ effectAttempted: false, status: 'observed', evidence: 'window_inspected' }); },
    }),
    choose: async () => selected(inspected ? 'done' : 'inspect_1'),
  });
  const report = await service.run({ command });
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'goal_not_verified');
  assert.equal(report.goalVerification, 'not_verified');
  assert.deepEqual(report.completed, []);
  assert.deepEqual(report.satisfiedPostconditions, []);
});

test('verified self-minimize no-op supports model-assessed completion without claiming a performed effect', async t => {
  let checked = false;
  const inputs = [];
  const service = await create(t, {
    createSession: () => ({
      observe: async () => ({ observation: { minimized: true }, candidates: [action('self_minimize', { operation: 'self_minimize', label: 'Свернуть Jeff' })] }),
      execute: async () => {
        checked = true;
        return completed({ effectAttempted: false, status: 'goal_verified', operation: 'self_minimize',
          before: { minimized: true }, after: { minimized: true }, evidence: 'assistant_minimized' });
      },
      verifyGoal: async () => ({ applicable: false, verified: false }),
    }),
    choose: async input => { inputs.push(structuredClone(input)); return selected(checked ? 'done' : 'self_minimize'); },
  });
  const report = await service.run({ command: 'Сверни Jeff' });
  assert.equal(report.ok, true);
  assert.equal(report.reason, 'goal_model_assessed');
  assert.equal(report.goalVerification, 'model_assessed');
  assert.equal(report.alreadySatisfied, true);
  assert.equal(report.effectVerification, 'none');
  assert.deepEqual(report.completed, []);
  assert.equal(report.satisfiedPostconditions.length, 1);
  assert.equal(report.satisfiedPostconditions[0].operation, 'self_minimize');
  assert.deepEqual(report.satisfiedPostconditions[0].evidence, ['assistant_minimized']);
  assert.equal(inputs[1].recentSteps[0].alreadySatisfied, true);
  assert.equal(inputs[1].recentSteps[0].effectAttempted, false);
  assert.equal(report.events.find(item => item.phase === 'verify').outcome, 'already_satisfied');
});

test('an exact measured postcondition can prove the goal was already satisfied without effects', async t => {
  const proof = { verified: true, scope: 'default_audio_output', evidence: ['selected_output_matches_request'] };
  const service = await create(t, {
    createSession: () => ({ observe: async () => ({ observation: { selectedOutput: 'Speakers' }, candidates: [] }), execute: async () => { assert.fail('no effect expected'); }, verifyGoal: async (supplied, { signal }) => { assert.equal(supplied, command); assert.equal(signal.aborted, false); return proof; } }),
  });
  const report = await service.run({ command });
  assert.equal(report.ok, true);
  assert.equal(report.reason, 'goal_verified');
  assert.equal(report.goalVerification, 'native_verified');
  assert.equal(report.effectVerification, 'none');
  assert.equal(report.alreadySatisfied, true);
  assert.deepEqual(report.goalEvidence, proof);
});

test('an applicable false postcondition overrides Jev done and allows only two correction observations', async t => {
  let effects = 0;
  let observes = 0;
  let checks = 0;
  const service = await create(t, {
    createSession: () => ({
      observe: async () => ({ observation: { observed: ++observes }, candidates: [action()] }),
      execute: async () => { effects++; return completed(); },
      verifyGoal: async () => { checks++; return { verified: false, scope: 'selected_audio_output', evidence: ['wrong_output'] }; },
    }),
    choose: async input => { if (checks) assert.equal(input.recentSteps.at(-1).status, 'goal_not_verified'); return selected(effects ? 'done' : 'step_1'); },
  });
  const report = await service.run({ command });
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'goal_not_verified');
  assert.equal(report.goalVerification, 'not_verified');
  assert.equal(checks, 3);
  assert.equal(observes, 4);
  assert.equal(effects, 1);
});

test('an inapplicable verifier does not claim native verification for a generic goal', async t => {
  let effects = 0;
  const service = await create(t, {
    createSession: () => ({ observe: async () => ({ observation: {}, candidates: [action()] }), execute: async () => { effects++; return completed(); }, verifyGoal: async () => ({ applicable: false, verified: false }) }),
    choose: async () => selected(effects ? 'done' : 'step_1'),
  });
  const report = await service.run({ command });
  assert.equal(report.reason, 'goal_model_assessed');
  assert.equal(report.goalVerification, 'model_assessed');
});

test('dispatched and state_changed invoke can continue but cannot repeat with a fresh id', async t => {
  for (const status of ['dispatched', 'state_changed']) {
    let effects = 0;
    let observes = 0;
    const service = await create(t, {
      createSession: () => ({
        observe: async () => ({ observation: { version: ++observes }, candidates: [action(`step_${observes}`)] }),
        execute: async () => { effects++; return completed({ status, verified: false }); },
      }),
      choose: async input => selected(input.candidates[0].id),
    });
    const report = await service.run({ command });
    assert.equal(report.reason, 'repeated_action');
    assert.equal(report.executionUncertain, false);
    assert.equal(effects, 1);
    assert.equal(observes, 2);
  }
});

test('verified effects still have a bounded repetition count across changed action ids', async t => {
  let effects = 0;
  const service = await create(t, {
    createSession: () => ({ observe: async () => ({ observation: {}, candidates: [action(`step_${effects}`)] }), execute: async () => { effects++; return completed(); } }),
    choose: async input => selected(input.candidates[0].id),
  });
  const report = await service.run({ command });
  assert.equal(report.reason, 'repeated_action');
  assert.equal(effects, 2);
});

test('journal flush failure prevents all effects even when model selection was valid', async t => {
  let effects = 0;
  const service = await create(t, {
    choose: async () => selected('step_1'),
    journalFactory: async (...args) => {
      const journal = await RunJournal.create(...args);
      journal.flush = async () => { throw new Error('test disk failure'); };
      return journal;
    },
    createSession: () => ({ observe: async () => ({ observation: {}, candidates: [action()] }), execute: async () => { effects++; return completed(); } }),
  });
  const report = await service.run({ command });
  assert.equal(report.reason, 'LOG_WRITE_FAILED');
  assert.equal(report.executionUncertain, false);
  assert.equal(effects, 0);
});

test('request and response are durable before execution, independent of renderer errors', async t => {
  let journal;
  const service = await create(t, {
    maxSteps: 1,
    progress: () => { throw new Error('renderer unavailable'); },
    journalFactory: async (...args) => { journal = await RunJournal.create(...args); return journal; },
    choose: async (input, { onResponse }) => { onResponse({ normalized: true }); return selected(input.candidates[0].id); },
    createSession: () => ({
      observe: async () => ({ observation: {}, candidates: [action()] }),
      execute: async () => {
        const events = (await readFile(journal.eventPath, 'utf8')).trim().split('\n').map(JSON.parse);
        assert.ok(events.some(event => event.phase === 'model_request'));
        assert.ok(events.some(event => event.phase === 'model_response'));
        assert.equal(events.at(-1).phase, 'execute_request');
        return completed();
      },
    }),
  });
  const report = await service.run({ command });
  assert.equal(report.reason, 'step_limit');
  assert.equal(report.completed.length, 1);
  assert.equal(report.ok, false);
});

test('bounded low-confidence inspect reveals a strongly chosen effect without lowering its gate', async t => {
  let stage = 0;
  const executed = [];
  const service = await create(t, {
    createSession: () => ({
      observe: async () => ({ observation: { stage }, candidates: stage === 0
        ? [action('read_audio', { operation: 'inspect', effect: false, stableKey: 'audio_inventory', label: 'Прочитать устройства вывода звука' })]
        : [action('set_audio', { stableKey: 'select_speakers', label: 'Выбрать колонки' })] }),
      execute: async id => { executed.push(id); stage++; return completed({ effectAttempted: id === 'set_audio', status: id === 'set_audio' ? 'completed' : 'observed' }); },
    }),
    choose: async () => stage === 0 ? selected('read_audio', { actionId: null, probability: 0.43, confidence: 0.39 }) : selected(stage === 1 ? 'set_audio' : 'done'),
  });
  const report = await service.run({ command });
  assert.equal(report.ok, true);
  assert.deepEqual(executed, ['read_audio', 'set_audio']);
  assert.equal(report.lowConfidenceReads, 1);
  const exploration = report.events.find(item => item.phase === 'low_confidence_exploration');
  assert.equal(exploration.effect, false);
  assert.equal(exploration.probability, 0.43);
  assert.equal(exploration.label, 'Прочитать устройства вывода звука');
  assert.equal(report.events.find(item => item.phase === 'model_decision').label, exploration.label);
  assert.equal(report.completed.length, 1);
});

test('low-confidence exploration is limited to three inspect attempts and cannot complete a goal', async t => {
  let reads = 0;
  const service = await create(t, {
    createSession: () => ({
      observe: async () => ({ observation: { reads }, candidates: [action(`read_${reads}`, { effect: false, operation: 'inspect', stableKey: `inventory_${reads}` })] }),
      execute: async () => { reads++; return completed({ effectAttempted: false, status: 'observed' }); },
    }),
    choose: async input => selected(input.candidates[0].id, { actionId: null, probability: 0.3, confidence: 0.3 }),
  });
  const report = await service.run({ command });
  assert.equal(report.reason, 'low_confidence');
  assert.equal(report.ok, false);
  assert.equal(reads, 3);
  assert.equal(report.lowConfidenceReads, 3);
  assert.equal(report.events.filter(item => item.phase === 'low_confidence_exploration').length, 3);
  assert.deepEqual(report.completed, []);
});

test('exploration never allows weak effects, weak completion or reads below 0.2', async t => {
  for (const [candidate, choice, probability, confidence] of [
    [action(), 'step_1', 0.79, 0.79],
    [action('step_1', { operation: 'inspect', effect: true }), 'step_1', 0.5, 0.5],
    [action('step_1', { operation: 'query', effect: false }), 'step_1', 0.5, 0.5],
    [action('step_1', { operation: 'inspect', effect: false }), 'step_1', 0.19, 0.5],
    [action('step_1', { operation: 'inspect', effect: false }), 'step_1', 0.5, 0.19],
    [action('step_1', { operation: 'inspect', effect: false }), 'done', 0.5, 0.5],
  ]) {
    let executed = 0;
    const service = await create(t, {
      createSession: () => ({ observe: async () => ({ observation: {}, candidates: [candidate] }), execute: async () => { executed++; return completed(); } }),
      choose: async () => selected(choice, { actionId: null, probability, confidence }),
    });
    const report = await service.run({ command });
    assert.equal(report.reason, 'low_confidence');
    assert.equal(report.lowConfidenceReads, 0);
    assert.equal(executed, 0);
  }
});
