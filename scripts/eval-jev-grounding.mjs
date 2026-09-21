import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { buildWindowsChoiceRequest, chooseWindowsAction } from '../desktop/providers/windows-choice.mjs';
import { MIN_CONFIDENCE, MIN_PROBABILITY } from '../desktop/automation/decision-policy.mjs';
import { readProtected } from '../desktop/secrets.mjs';
import { JEV_GROUNDING_CASES, SYNTHETIC_SCOPE_NOTE } from '../tests/fixtures/jev-grounding-cases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Fixed model and gate settings used by the live comparison. */
export const MODEL = 'jev-1.13.0';
export const REPEATS = 2;
export const MAX_REQUESTS = 64;
export const PROFILES = Object.freeze(['full', 'scoped']);
export const GATES = Object.freeze({ probability: MIN_PROBABILITY, confidence: MIN_CONFIDENCE });
export const STOP_IDS = Object.freeze(['done', 'unsupported', 'no_request']);

/**
 * The scoped arm is deliberately mechanical. It receives a prepared operation
 * label from the fixture and retains every candidate for that operation plus
 * every inspect prerequisite. It never reads the expected answer or picks a
 * target ID. This is a grounding experiment, not a scope-extraction test.
 */
export const SCOPE_POLICY = Object.freeze({
  name: 'prepared-operation-plus-inspect',
  description: SYNTHETIC_SCOPE_NOTE,
  rule: 'Keep all supplied candidates whose operation equals the externally prepared scopeOperation, and keep all supplied inspect candidates. Use scopeOperation=all when no operation is authorized by the command, preserving the supplied set.',
  expectedAnswerUsed: false,
});

const STOP_SET = new Set(STOP_IDS);
const PROFILE_SET = new Set(PROFILES);
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);

export function scopedCandidates(testCase) {
  const operation = testCase?.scopeOperation;
  if (typeof operation !== 'string' || !operation) throw new TypeError('Missing prepared scope operation.');
  if (operation === 'all') return testCase.input.candidates;
  return testCase.input.candidates.filter(candidate => candidate.operation === operation || candidate.operation === 'inspect');
}

export function inputFor(testCase, profile) {
  if (!PROFILE_SET.has(profile)) throw new TypeError(`Unknown profile: ${profile}`);
  const input = clone(testCase.input);
  if (profile === 'scoped') input.candidates = clone(scopedCandidates(testCase));
  return input;
}

/** Build the exact production request; expected labels live only in fixtures/manifests. */
export function requestFor(testCase, profile) {
  return buildWindowsChoiceRequest(inputFor(testCase, profile));
}

/** The evaluator pins the wire model while leaving the production builder untouched. */
export function wireRequestFor(testCase, profile) {
  const request = clone(requestFor(testCase, profile));
  request.model = MODEL;
  return request;
}

function candidateManifest(candidates) {
  return candidates.map(candidate => ({ id: candidate.id, label: candidate.label, operation: candidate.operation }));
}

export function caseManifest(testCase) {
  return {
    id: testCase.id,
    synthetic: testCase.synthetic === true,
    scopeSource: testCase.scopeSource,
    expected: testCase.expected,
    scopeOperation: testCase.scopeOperation,
    tags: [...(testCase.tags ?? [])],
    input: clone(testCase.input),
    fullCandidates: candidateManifest(testCase.input.candidates),
    scopedCandidates: candidateManifest(scopedCandidates(testCase)),
  };
}

function orderFor(repeat, caseIndex) {
  return (repeat + caseIndex) % 2 === 0 ? ['full', 'scoped'] : ['scoped', 'full'];
}

export function buildPlan() {
  const plannedRequests = JEV_GROUNDING_CASES.length * PROFILES.length * REPEATS;
  const wireExample = wireRequestFor(JEV_GROUNDING_CASES[0], 'full');
  return {
    synthetic: true,
    scopeNote: SYNTHETIC_SCOPE_NOTE,
    scopePolicy: SCOPE_POLICY,
    model: MODEL,
    productionRequestModel: 'jev-latest',
    wireModel: MODEL,
    wireExample,
    gates: GATES,
    profiles: [...PROFILES],
    repeats: REPEATS,
    maxRequests: MAX_REQUESTS,
    plannedRequests,
    counterbalanced: true,
    sequential: true,
    retries: 0,
    cases: JEV_GROUNDING_CASES.map(caseManifest),
  };
}

function assertPlan() {
  const plan = buildPlan();
  assert.ok(JEV_GROUNDING_CASES.length >= 12 && JEV_GROUNDING_CASES.length <= 16);
  assert.ok(plan.plannedRequests <= MAX_REQUESTS);
  for (const [caseIndex, testCase] of JEV_GROUNDING_CASES.entries()) {
    assert.equal(testCase.synthetic, true);
    assert.equal(testCase.scopeSource, 'externally/prepared supplied current subtask');
    assert.ok(testCase.input.command && testCase.input.observation?.summary);
    assert.ok(testCase.input.candidates.some(candidate => candidate.operation === 'inspect'));
    const scopedIds = new Set(scopedCandidates(testCase).map(candidate => candidate.id));
    for (const candidate of scopedCandidates(testCase)) {
      assert.ok(testCase.scopeOperation === 'all' || candidate.operation === testCase.scopeOperation || candidate.operation === 'inspect');
    }
    for (const candidate of testCase.input.candidates.filter(candidate => candidate.operation === 'inspect')) {
      assert.ok(scopedIds.has(candidate.id));
    }
    const fullRequest = requestFor(testCase, 'full');
    const scopedRequest = requestFor(testCase, 'scoped');
    assert.equal(fullRequest.state.command, scopedRequest.state.command);
    assert.deepEqual(fullRequest.state.observation, scopedRequest.state.observation);
    assert.deepEqual(fullRequest.state.completed, scopedRequest.state.completed);
    assert.equal(fullRequest.state.phase, scopedRequest.state.phase);
    if (!STOP_SET.has(testCase.expected)) {
      assert.ok(testCase.input.candidates.some(candidate => candidate.id === testCase.expected));
      assert.ok(scopedIds.has(testCase.expected), `${testCase.id}: expected action was filtered by prepared scope`);
    }
    const firstOrder = orderFor(0, caseIndex);
    const secondOrder = orderFor(1, caseIndex);
    assert.deepEqual([...firstOrder].sort(), ['full', 'scoped']);
    assert.deepEqual([...secondOrder].sort(), ['full', 'scoped']);
    assert.notDeepEqual(firstOrder, secondOrder);
  }
  return plan;
}

const finite = value => typeof value === 'number' && Number.isFinite(value);

function gatePassed(probability, confidence) {
  return finite(probability) && finite(confidence) && probability >= MIN_PROBABILITY && confidence >= MIN_CONFIDENCE;
}

/**
 * Classify one normalized chooseWindowsAction result. actionId is the value
 * that actually passed the production gate; choice alone is never counted as
 * an accepted action.
 */
export function classifyRecord(row) {
  if (!row?.result) return { outcome: 'failures', falseRejection: false };
  const result = row.result;
  const expectedAction = !STOP_SET.has(row.expected);
  const accepted = typeof result.actionId === 'string' && result.actionId.length > 0;
  if (accepted) {
    if (expectedAction && result.actionId === row.expected) return { outcome: 'correctAccepted', falseRejection: false };
    return { outcome: 'wrongAccepted', falseRejection: false };
  }
  const doneStop = row.expected === 'done'
    && result.choice === 'done'
    && result.goalStatus === 'achieved'
    && gatePassed(result.probability, result.confidence)
    && gatePassed(result.goalProbability, result.goalConfidence);
  const correctStop = !expectedAction && result.choice === row.expected && (row.expected !== 'done' || doneStop);
  if (correctStop) return { outcome: 'correctStops', falseRejection: false };
  return {
    outcome: 'wrongStops',
    falseRejection: expectedAction && result.choice === row.expected,
  };
}

function rounded(value, digits = 3) {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values, p) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return rounded(sorted[low] + (sorted[high] - sorted[low]) * (index - low));
}

function stats(values) {
  const usable = values.filter(finite);
  if (!usable.length) return { count: 0, mean: null, median: null, p95: null, min: null, max: null };
  return {
    count: usable.length,
    mean: rounded(usable.reduce((sum, value) => sum + value, 0) / usable.length),
    median: percentile(usable, 0.5),
    p95: percentile(usable, 0.95),
    min: rounded(Math.min(...usable)),
    max: rounded(Math.max(...usable)),
  };
}

function counts(values) {
  const result = Object.create(null);
  for (const value of values) {
    const key = value ?? '[null]';
    result[key] = (result[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function compactRow(row, classification = classifyRecord(row)) {
  const result = row.result;
  return {
    caseId: row.caseId,
    profile: row.profile,
    repeat: row.repeat,
    expected: row.expected,
    outcome: classification.outcome,
    falseRejection: classification.falseRejection,
    status: row.status ?? (row.result ? 'ok' : 'error'),
    errorCode: row.errorCode ?? null,
    harnessError: row.harnessError ?? null,
    httpStatus: Number.isInteger(row.httpStatus) ? row.httpStatus : null,
    candidateCount: row.candidateCount,
    candidateIds: [...row.candidateIds],
    choice: result?.choice ?? null,
    actionId: result?.actionId ?? null,
    probability: result?.probability ?? null,
    confidence: result?.confidence ?? null,
    goalStatus: result?.goalStatus ?? null,
    goalProbability: result?.goalProbability ?? null,
    goalConfidence: result?.goalConfidence ?? null,
    model: result?.model ?? null,
    usage: result?.usage ?? null,
    latencyMs: finite(row.latencyMs) ? row.latencyMs : null,
  };
}

function profileReport(profile, rows) {
  const classifications = rows.map(row => ({ row, classification: classifyRecord(row) }));
  const outcome = { total: rows.length, failures: 0, correctAccepted: 0, wrongAccepted: 0, correctStops: 0, wrongStops: 0, falseRejection: 0 };
  for (const { classification } of classifications) {
    outcome[classification.outcome] += 1;
    if (classification.falseRejection) outcome.falseRejection += 1;
  }
  const total = outcome.total;
  const successful = rows.filter(row => isRecord(row.result));
  const accepted = successful.filter(row => typeof row.result.actionId === 'string' && row.result.actionId.length > 0);
  const usages = successful.map(row => row.result.usage).filter(isRecord);
  const inputTokens = usages.reduce((sum, usage) => sum + (Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : 0), 0);
  const outputTokens = usages.reduce((sum, usage) => sum + (Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : 0), 0);
  const latencyValues = rows.map(row => row.latencyMs).filter(finite);
  const successfulLatency = successful.map(row => row.latencyMs).filter(finite);
  const counterexamples = classifications
    .filter(({ classification }) => classification.outcome !== 'correctAccepted' && classification.outcome !== 'correctStops')
    .map(({ row, classification }) => compactRow(row, classification));
  const actionConfidences = successful.map(row => row.result.confidence).filter(finite);
  const goalConfidences = successful.map(row => row.result.goalConfidence).filter(finite);
  const actionProbabilities = successful.map(row => row.result.probability).filter(finite);
  const goalProbabilities = successful.map(row => row.result.goalProbability).filter(finite);
  return {
    profile,
    denominator: total,
    outcome,
    rates: {
      correctAccepted: total ? rounded(outcome.correctAccepted / total) : null,
      wrongAccepted: total ? rounded(outcome.wrongAccepted / total) : null,
      correctStops: total ? rounded(outcome.correctStops / total) : null,
      wrongStops: total ? rounded(outcome.wrongStops / total) : null,
      falseRejection: total ? rounded(outcome.falseRejection / total) : null,
      serviceOrSchemaFailure: total ? rounded(outcome.failures / total) : null,
      correctOverall: total ? rounded((outcome.correctAccepted + outcome.correctStops) / total) : null,
    },
    distributions: {
      choice: counts(successful.map(row => row.result.choice).concat(rows.filter(row => !row.result).map(() => '[error]'))),
      actionId: counts(successful.map(row => row.result.actionId ?? '[stop-or-rejected]').concat(rows.filter(row => !row.result).map(() => '[error]'))),
      goalStatus: counts(successful.map(row => row.result.goalStatus).concat(rows.filter(row => !row.result).map(() => '[error]'))),
      model: counts(successful.map(row => row.result.model)),
      errorCode: counts(rows.filter(row => row.errorCode).map(row => row.errorCode)),
      harnessError: counts(rows.filter(row => row.harnessError).map(row => row.harnessError)),
    },
    confidence: {
      action: stats(actionConfidences),
      actionProbability: stats(actionProbabilities),
      goal: stats(goalConfidences),
      goalProbability: stats(goalProbabilities),
      acceptedAction: stats(accepted.map(row => row.result.confidence)),
      acceptedActionProbability: stats(accepted.map(row => row.result.probability)),
    },
    tokens: {
      rowsWithUsage: usages.length,
      input: inputTokens,
      output: outputTokens,
      total: inputTokens + outputTokens,
      meanPerAttempt: total ? rounded((inputTokens + outputTokens) / total) : null,
      note: 'Token total is the cost proxy; no dollar price is inferred here.',
    },
    latency: {
      allAttemptsMs: stats(latencyValues),
      successfulMs: stats(successfulLatency),
    },
    counterexamples,
    attempts: rows.map(row => compactRow(row)),
  };
}

export function buildReport(records, plan = buildPlan()) {
  const byProfile = Object.fromEntries(PROFILES.map(profile => [profile, profileReport(profile, records.filter(row => row.profile === profile))]));
  const pairs = [];
  for (const testCase of JEV_GROUNDING_CASES) {
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const pair = records.filter(row => row.caseId === testCase.id && row.repeat === repeat);
      pairs.push({
        caseId: testCase.id,
        expected: testCase.expected,
        repeat,
        full: compactRow(pair.find(row => row.profile === 'full') ?? { caseId: testCase.id, profile: 'full', repeat, expected: testCase.expected, candidateCount: 0, candidateIds: [], errorCode: 'MISSING_ROW' }),
        scoped: compactRow(pair.find(row => row.profile === 'scoped') ?? { caseId: testCase.id, profile: 'scoped', repeat, expected: testCase.expected, candidateCount: 0, candidateIds: [], errorCode: 'MISSING_ROW' }),
      });
    }
  }
  return {
    model: plan.model,
    gates: plan.gates,
    denominator: records.length,
    profiles: byProfile,
    paired: pairs,
  };
}

function safeErrorCode(error) {
  const code = error?.code;
  if (typeof code === 'string' && /^(?:WINDOWS_CHOICE|HARNESS|EVAL)_[A-Z0-9_]+$/u.test(code)) return code;
  return 'EVAL_FAILURE';
}

function harnessFailure(code, onHarnessError) {
  onHarnessError?.(code);
  return Object.assign(new Error('Evaluator transport validation failed.'), { code });
}

/**
 * Adapter used by the live evaluator and by the offline integration test.
 * chooseWindowsAction builds the production request with jev-latest; the
 * evaluator pins only the model field immediately before its exact wire check
 * and send. All other request fields must remain byte-for-byte equivalent.
 */
export function createEvaluatorFetchAdapter({ testCase, profile, state, onHarnessError, fetchImpl = fetch } = {}) {
  if (!testCase || !PROFILE_SET.has(profile) || !state || !Number.isInteger(state.fetchCalls)) throw new TypeError('Invalid evaluator fetch adapter.');
  const expectedWire = wireRequestFor(testCase, profile);
  return async (url, options) => {
    if (state.fetchCalls >= MAX_REQUESTS) throw harnessFailure('HARNESS_REQUEST_CAP', onHarnessError);
    let body;
    try { body = JSON.parse(options?.body); } catch { throw harnessFailure('HARNESS_WIRE_BODY_INVALID', onHarnessError); }
    // The production builder intentionally remains on jev-latest. Pin the
    // actual outgoing body before comparing and sending it to the fixed model.
    body.model = MODEL;
    if (JSON.stringify(body) !== JSON.stringify(expectedWire)) throw harnessFailure('HARNESS_WIRE_BODY_MISMATCH', onHarnessError);
    state.fetchCalls += 1;
    return fetchImpl(url, { ...options, body: JSON.stringify(body) });
  };
}

function rowFor(testCase, profile, repeat, sequence) {
  const input = inputFor(testCase, profile);
  const request = requestFor(testCase, profile);
  const wireRequest = wireRequestFor(testCase, profile);
  return {
    caseId: testCase.id,
    profile,
    repeat,
    sequence,
    expected: testCase.expected,
    scopeOperation: testCase.scopeOperation,
    candidateCount: input.candidates.length,
    candidateIds: input.candidates.map(candidate => candidate.id),
    candidateOperations: input.candidates.map(candidate => candidate.operation),
    requestBytes: Buffer.byteLength(JSON.stringify(request), 'utf8'),
    wireRequestBytes: Buffer.byteLength(JSON.stringify(wireRequest), 'utf8'),
    result: null,
    status: 'pending',
    errorCode: null,
    harnessError: null,
    httpStatus: null,
    latencyMs: null,
  };
}

async function writeResults(directory, manifest, records, plan, attempts, fetchCalls) {
  await writeFile(path.join(directory, 'results.json'), JSON.stringify({
    manifest,
    progress: { attempts, fetchCalls },
    report: buildReport(records, plan),
    records,
  }, null, 2), 'utf8');
}

/**
 * Run without --run to build and validate the plan only. --run is the sole
 * path that reads the DPAPI key or performs a network request.
 */
export async function run(argv = process.argv.slice(2)) {
  const plan = assertPlan();
  if (!argv.includes('--run')) {
    const dryRun = {
      mode: 'dry-run',
      ...plan,
      credentialsRead: false,
      networkCalls: 0,
      desktopEffects: false,
    };
    console.log(JSON.stringify(dryRun));
    return dryRun;
  }

  const key = await readProtected(path.join(ROOT, 'data', 'secrets', 'typesafe.dpapi'));
  if (!key) throw new Error('MISSING_PROTECTED_KEY');
  const directory = path.join(ROOT, 'work', `jev-grounding-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
  await mkdir(directory, { recursive: false });
  const manifest = {
    ...plan,
    startedAt: new Date().toISOString(),
    noDesktopEffects: true,
    credentialsStoredOutsideOutput: true,
    cases: plan.cases,
  };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const records = [];
  let attempts = 0;
  const transportState = { fetchCalls: 0 };
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    for (const [caseIndex, testCase] of JEV_GROUNDING_CASES.entries()) {
      for (const profile of orderFor(repeat, caseIndex)) {
        if (attempts >= MAX_REQUESTS) throw new Error('REQUEST_CAP');
        const row = rowFor(testCase, profile, repeat, attempts);
        const started = performance.now();
        attempts += 1;
        try {
          row.result = await chooseWindowsAction(inputFor(testCase, profile), {
            apiKey: key,
            fetchImpl: createEvaluatorFetchAdapter({
              testCase,
              profile,
              state: transportState,
              onHarnessError: code => { row.harnessError = code; },
              fetchImpl: async (url, options) => {
                const response = await fetch(url, options);
                row.httpStatus = response.status;
                return response;
              },
            }),
          });
          row.status = 'ok';
        } catch (error) {
          row.status = 'error';
          row.errorCode = safeErrorCode(error);
        }
        row.latencyMs = Math.round(performance.now() - started);
        records.push(row);
        await writeResults(directory, manifest, records, plan, attempts, transportState.fetchCalls);
      }
    }
  }
  const report = buildReport(records, plan);
  await writeResults(directory, manifest, records, plan, attempts, transportState.fetchCalls);
  const result = { mode: 'run', output: directory, attempts, fetchCalls: transportState.fetchCalls, report };
  console.log(JSON.stringify({ mode: result.mode, output: result.output, attempts, fetchCalls: transportState.fetchCalls, denominator: report.denominator }));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(() => {
    console.error('Evaluation stopped. No provider body or credential is logged.');
    process.exitCode = 1;
  });
}
