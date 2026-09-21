import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  buildPlan,
  buildReport,
  classifyRecord,
  createEvaluatorFetchAdapter,
  GATES,
  inputFor,
  MODEL,
  PROFILES,
  requestFor,
  scopedCandidates,
  SCOPE_POLICY,
  wireRequestFor,
} from '../scripts/eval-jev-grounding.mjs';
import { chooseWindowsAction } from '../desktop/providers/windows-choice.mjs';
import { JEV_GROUNDING_CASES, SYNTHETIC_SCOPE_NOTE } from './fixtures/jev-grounding-cases.mjs';

const execFileAsync = promisify(execFile);

test('prepared fixture set is synthetic, Russian, and covers the requested grounding cases', () => {
  assert.ok(JEV_GROUNDING_CASES.length >= 12 && JEV_GROUNDING_CASES.length <= 16);
  assert.equal(new Set(JEV_GROUNDING_CASES.map(item => item.id)).size, JEV_GROUNDING_CASES.length);
  const tags = new Set(JEV_GROUNDING_CASES.flatMap(item => item.tags));
  for (const required of ['chrome', 'minimize', 'open', 'unfamiliar-app', 'ambiguity', 'missing-target', 'quoted-command', 'negation', 'already-done', 'compound', 'history', 'tabs', 'partial-coverage']) {
    assert.ok(tags.has(required), `missing fixture tag ${required}`);
  }
  for (const testCase of JEV_GROUNDING_CASES) {
    assert.equal(testCase.synthetic, true);
    assert.equal(testCase.scopeSource, 'externally/prepared supplied current subtask');
    assert.match(testCase.input.command, /[А-Яа-яЁё]/u);
    assert.ok(testCase.input.candidates.some(candidate => candidate.operation === 'inspect'));
  }
  assert.match(SYNTHETIC_SCOPE_NOTE, /not evidence of automatic scope extraction/u);
});

test('full and scoped requests preserve command/facts/history and scope without using expected ids', () => {
  for (const testCase of JEV_GROUNDING_CASES) {
    const full = inputFor(testCase, 'full');
    const scoped = inputFor(testCase, 'scoped');
    assert.deepEqual(scoped.command, full.command);
    assert.deepEqual(scoped.observation, full.observation);
    assert.deepEqual(scoped.completed, full.completed);
    assert.equal(scoped.phase, full.phase);
    assert.deepEqual(scoped.candidates, scopedCandidates(testCase));
    assert.ok(scoped.candidates.every(candidate => testCase.scopeOperation === 'all' || candidate.operation === testCase.scopeOperation || candidate.operation === 'inspect'));
    assert.deepEqual(
      scoped.candidates.filter(candidate => candidate.operation === 'inspect').map(candidate => candidate.id),
      full.candidates.filter(candidate => candidate.operation === 'inspect').map(candidate => candidate.id),
    );

    const fullRequest = requestFor(testCase, 'full');
    const scopedRequest = requestFor(testCase, 'scoped');
    for (const request of [fullRequest, scopedRequest]) {
      const serialized = JSON.stringify(request);
      assert.equal(Object.hasOwn(request, 'expected'), false);
      assert.equal(Object.hasOwn(request, 'scopeOperation'), false);
      assert.equal(serialized.includes('scopeSource'), false);
      assert.match(request.questions.next_action.instructions, /Select the ONE next supplied action/u);
    }
  }
});

test('plan has two counterbalanced repeats and remains below the request cap', () => {
  const plan = buildPlan();
  assert.equal(plan.model, MODEL);
  assert.equal(plan.wireModel, MODEL);
  assert.equal(plan.productionRequestModel, 'jev-latest');
  assert.equal(plan.wireExample.model, MODEL);
  assert.deepEqual(plan.profiles, PROFILES);
  assert.equal(plan.repeats, 2);
  assert.equal(plan.plannedRequests, JEV_GROUNDING_CASES.length * 4);
  assert.ok(plan.plannedRequests <= 64);
  assert.equal(plan.maxRequests, 64);
  assert.equal(plan.counterbalanced, true);
  assert.equal(plan.sequential, true);
  assert.equal(plan.retries, 0);
  assert.equal(plan.scopePolicy.name, SCOPE_POLICY.name);
  assert.equal(plan.scopePolicy.expectedAnswerUsed, false);
});

test('wire request pins the evaluator model while production request construction stays on latest', () => {
  const testCase = JEV_GROUNDING_CASES[0];
  assert.equal(requestFor(testCase, 'full').model, 'jev-latest');
  assert.equal(wireRequestFor(testCase, 'full').model, MODEL);
  assert.deepEqual(wireRequestFor(testCase, 'full').state, requestFor(testCase, 'full').state);
  assert.equal(JSON.stringify(wireRequestFor(testCase, 'full').questions), JSON.stringify(requestFor(testCase, 'full').questions));
});

function choiceAnswer(criteria, selected) {
  const labels = Object.keys(criteria);
  return {
    type: 'choice',
    choice: selected,
    confidence: 1,
    probabilities: Object.fromEntries(labels.map(label => [label, label === selected ? 1 : 0])),
  };
}

test('integration: chooseWindowsAction reaches the evaluator adapter and sends the pinned wire model', async () => {
  const testCase = JEV_GROUNDING_CASES.find(item => item.id === 'chrome_minimize_simple');
  const input = inputFor(testCase, 'full');
  const request = requestFor(testCase, 'full');
  const payload = {
    model: MODEL,
    answers: {
      next_action: choiceAnswer(request.questions.next_action.criteria, testCase.expected),
      goal_status: choiceAnswer(request.questions.goal_status.criteria, 'not_achieved'),
    },
    usage: { input_tokens: 123, output_tokens: 17 },
  };
  const state = { fetchCalls: 0 };
  const harnessErrors = [];
  let capturedBody;
  const fetchImpl = createEvaluatorFetchAdapter({
    testCase,
    profile: 'full',
    state,
    onHarnessError: code => harnessErrors.push(code),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      capturedBody = JSON.parse(options.body);
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await chooseWindowsAction(input, { apiKey: 'test-key', fetchImpl });
  assert.equal(state.fetchCalls, 1);
  assert.deepEqual(harnessErrors, []);
  assert.equal(capturedBody.model, MODEL);
  assert.equal(JSON.stringify(capturedBody), JSON.stringify(wireRequestFor(testCase, 'full')));
  assert.equal(result.choice, testCase.expected);
  assert.equal(result.actionId, testCase.expected);
  assert.equal(result.usage.input_tokens, 123);
});

test('integration: harness errors are retained by the adapter while chooseWindowsAction exposes sanitized NETWORK', async () => {
  const testCase = JEV_GROUNDING_CASES[0];
  const state = { fetchCalls: 64 };
  const harnessErrors = [];
  const fetchImpl = createEvaluatorFetchAdapter({
    testCase,
    profile: 'full',
    state,
    onHarnessError: code => harnessErrors.push(code),
    fetchImpl: async () => assert.fail('request cap must prevent remote fetch'),
  });
  await assert.rejects(
    chooseWindowsAction(inputFor(testCase, 'full'), { apiKey: 'test-key', fetchImpl }),
    { code: 'WINDOWS_CHOICE_NETWORK' },
  );
  assert.deepEqual(harnessErrors, ['HARNESS_REQUEST_CAP']);
});

const result = ({ choice, actionId = null, probability = 0.9, confidence = 0.9, goalStatus = 'not_achieved', goalProbability = 0.9, goalConfidence = 0.9 } = {}) => ({
  choice,
  actionId,
  probability,
  confidence,
  probabilities: {},
  goalStatus,
  goalProbability,
  goalConfidence,
  model: 'jev-1.13.0',
  usage: { input_tokens: 10, output_tokens: 5 },
});

test('classification uses normalized actionId and both 0.8 gates, with false rejection separated', () => {
  assert.deepEqual(GATES, { probability: 0.8, confidence: 0.8 });
  assert.equal(classifyRecord({ expected: 'target', result: result({ choice: 'target', actionId: 'target' }) }).outcome, 'correctAccepted');
  assert.equal(classifyRecord({ expected: 'target', result: result({ choice: 'other', actionId: 'other' }) }).outcome, 'wrongAccepted');
  const falseRejection = classifyRecord({ expected: 'target', result: result({ choice: 'target', probability: 0.79, actionId: null }) });
  assert.equal(falseRejection.outcome, 'wrongStops');
  assert.equal(falseRejection.falseRejection, true);
  assert.equal(classifyRecord({ expected: 'unsupported', result: result({ choice: 'unsupported' }) }).outcome, 'correctStops');
  assert.equal(classifyRecord({ expected: 'target', result: result({ choice: 'unsupported' }) }).outcome, 'wrongStops');
  assert.equal(classifyRecord({ expected: 'done', result: result({ choice: 'done', goalStatus: 'achieved' }) }).outcome, 'correctStops');
  assert.equal(classifyRecord({ expected: 'done', result: result({ choice: 'done', goalStatus: 'not_achieved' }) }).outcome, 'wrongStops');
  assert.equal(classifyRecord({ expected: 'target', result: null }).outcome, 'failures');
});

function rowFor(testCase, profile, repeat, patch = {}) {
  const input = inputFor(testCase, profile);
  return {
    caseId: testCase.id,
    profile,
    repeat,
    expected: testCase.expected,
    candidateCount: input.candidates.length,
    candidateIds: input.candidates.map(candidate => candidate.id),
    result: null,
    errorCode: null,
    httpStatus: null,
    latencyMs: 10,
    ...patch,
  };
}

test('report keeps provider/schema failures in the denominator and emits distributions/counterexamples', () => {
  const targetCase = JEV_GROUNDING_CASES.find(item => item.expected === 'chrome_minimize_docs');
  const stopCase = JEV_GROUNDING_CASES.find(item => item.expected === 'unsupported');
  const records = [
    rowFor(targetCase, 'full', 0, { result: result({ choice: targetCase.expected, actionId: targetCase.expected }), latencyMs: 14 }),
    rowFor(targetCase, 'full', 1, { result: result({ choice: 'edge_minimize_news', actionId: 'edge_minimize_news' }), latencyMs: 18 }),
    rowFor(stopCase, 'scoped', 0, { result: null, errorCode: 'WINDOWS_CHOICE_NETWORK', harnessError: 'HARNESS_WIRE_BODY_MISMATCH', latencyMs: 20 }),
  ];
  const report = buildReport(records);
  assert.equal(report.profiles.full.denominator, 2);
  assert.equal(report.profiles.full.outcome.correctAccepted, 1);
  assert.equal(report.profiles.full.outcome.wrongAccepted, 1);
  assert.equal(report.profiles.scoped.denominator, 1);
  assert.equal(report.profiles.scoped.outcome.failures, 1);
  assert.equal(report.profiles.scoped.rates.serviceOrSchemaFailure, 1);
  assert.equal(report.profiles.scoped.distributions.errorCode.WINDOWS_CHOICE_NETWORK, 1);
  assert.equal(report.profiles.scoped.distributions.harnessError.HARNESS_WIRE_BODY_MISMATCH, 1);
  assert.equal(report.profiles.full.latency.allAttemptsMs.median, 16);
  assert.ok(report.profiles.full.counterexamples.some(item => item.outcome === 'wrongAccepted'));
  assert.ok(report.paired.length === JEV_GROUNDING_CASES.length * 2);
});

test('CLI default is a no-network, no-credential dry run', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/eval-jev-grounding.mjs'], {
    cwd: new URL('..', import.meta.url),
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(stderr, '');
  const output = JSON.parse(stdout.trim());
  assert.equal(output.mode, 'dry-run');
  assert.equal(output.credentialsRead, false);
  assert.equal(output.networkCalls, 0);
  assert.equal(output.desktopEffects, false);
  assert.equal(output.plannedRequests, JEV_GROUNDING_CASES.length * 4);
});
