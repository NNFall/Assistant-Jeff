import { MIN_PROBABILITY, MIN_CONFIDENCE } from './decision-policy.mjs';

/** Fixture prototype, not a production Windows runtime. No OS, network or file APIs.
 * Adapters own observation freshness and independent goal/verification semantics.
 * Every adapter method must honor options.signal and settle promptly on cancellation.
 * execute must revalidate expectedVersion immediately before an effect. A timeout
 * cannot undo an effect already sent; this runner never retries uncertain execution.
 */
const OPERATIONS = ['activate', 'select', 'click'];
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value);
const stopError = reason => Object.assign(new Error(reason), { reason });

function projectSnapshot(snapshot) {
  if (!snapshot || !validText(snapshot.version, 128) || !validText(snapshot.app, 100) || !validText(snapshot.summary, 4000) || !Array.isArray(snapshot.elements) || snapshot.elements.length > 32) throw stopError('invalid_snapshot');
  const ids = new Set();
  const elements = snapshot.elements.map(element => {
    if (!element || typeof element.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,47}$/u.test(element.id) || ids.has(element.id) || !validText(element.label, 500) || !Array.isArray(element.capabilities) || new Set(element.capabilities).size !== element.capabilities.length || !element.capabilities.every(operation => OPERATIONS.includes(operation))) throw stopError('invalid_snapshot');
    ids.add(element.id);
    return { id: element.id, label: element.label.trim(), capabilities: OPERATIONS.filter(operation => element.capabilities.includes(operation)) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (elements.reduce((count, element) => count + element.capabilities.length, 0) > 32) throw stopError('invalid_snapshot');
  return { version: snapshot.version, app: snapshot.app.trim(), summary: snapshot.summary.trim(), elements };
}

export function buildObservedCandidates(snapshot) {
  return projectSnapshot(snapshot).elements.flatMap(element => element.capabilities.map(operation => ({
    id: `a_${element.id}_${operation}`, targetId: element.id, label: element.label, operation,
  })));
}

export async function runObservedTask({ command, adapter, choose, signal, onEvent = () => {}, maxSteps = 8, maxDurationMs = 30000 } = {}) {
  const started = performance.now();
  const trace = [];
  const completed = [];
  const record = async event => { trace.push(event); await onEvent(event); };
  // Stable element/action IDs are scoped to observed generations for model history.
  // Returning to a target in a new generation is valid; replay in the same is not.
  const generations = new Map();
  const result = (ok, reason) => ({ ok, reason, trace, completed, elapsedMs: Math.round(performance.now() - started) });
  if (!validText(command, 4096) || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 64 || !Number.isInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 300000 || typeof choose !== 'function' || !['observe', 'execute', 'verify', 'isGoalSatisfied'].every(name => typeof adapter?.[name] === 'function')) return result(false, 'invalid_input');
  const controller = new AbortController();
  let abortReason;
  const abort = reason => { if (!controller.signal.aborted) { abortReason = reason; controller.abort(); } };
  const onAbort = () => abort('aborted');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => abort('time_limit'), maxDurationMs);
  const gate = () => { if (signal?.aborted) onAbort(); if (performance.now() - started >= maxDurationMs) abort('time_limit'); if (controller.signal.aborted) throw stopError(abortReason); };
  const call = async fn => {
    gate();
    let rejectAbort;
    const cancelled = new Promise((_, reject) => { rejectAbort = () => reject(stopError(abortReason)); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
    try { const value = await Promise.race([Promise.resolve().then(() => { gate(); return fn(); }), cancelled]); gate(); return value; }
    finally { controller.signal.removeEventListener('abort', rejectAbort); }
  };
  const options = { signal: controller.signal };
  const goal = async (snapshot, step) => {
    const satisfied = await call(() => adapter.isGoalSatisfied(snapshot, command, options));
    if (typeof satisfied !== 'boolean') throw stopError('invalid_goal_check');
    await record({ step, phase: 'goal', version: snapshot.version, satisfied });
    return satisfied;
  };
  let phase = 'observe';
  try {
    for (let step = 1; step <= maxSteps; step++) {
      phase = 'observe';
      const before = projectSnapshot(await call(() => adapter.observe(options)));
      await record({ step, phase, snapshot: before });
      if (await goal(before, step)) return result(true, 'goal_verified');
      if (!generations.has(before.version)) generations.set(before.version, `g${generations.size + 1}`);
      const generation = generations.get(before.version);
      const candidates = buildObservedCandidates(before)
        .map(candidate => ({ ...candidate, id: `${generation}_${candidate.id}` }))
        .filter(candidate => !completed.some(item => item.id === candidate.id));
      if (!candidates.length) return result(false, 'no_candidates');
      const modelInput = {
        command: command.trim(), observation: { app: before.app, summary: before.summary },
        candidates: candidates.map(({ id, label, operation }) => ({ id, label, operation })),
        completed: completed.map(item => ({ ...item })),
      };
      phase = 'choose';
      const decision = await call(() => choose(modelInput, options));
      await record({ step, phase: 'decision', choice: decision?.choice, actionId: decision?.actionId, probability: decision?.probability, confidence: decision?.confidence });
      if (decision?.choice === 'done') return result(false, 'goal_not_verified');
      if (decision?.choice === 'unsupported') return result(false, 'unsupported');
      if (decision?.actionId == null) return result(false, 'no_action');
      const candidate = candidates.find(item => item.id === decision.actionId);
      if (!candidate || decision.choice !== candidate.id) return result(false, 'unknown_action');
      if (!Number.isFinite(decision.probability) || decision.probability < MIN_PROBABILITY || decision.probability > 1 || !Number.isFinite(decision.confidence) || decision.confidence < MIN_CONFIDENCE || decision.confidence > 1) return result(false, 'low_confidence');
      phase = 'observe';
      const fresh = projectSnapshot(await call(() => adapter.observe(options)));
      if (before.version !== fresh.version || JSON.stringify(before) !== JSON.stringify(fresh)) {
        await record({ step, phase: 'stale', expectedVersion: before.version, observedVersion: fresh.version });
        continue;
      }
      gate();
      phase = 'execute';
      await record({ step, phase, candidate: { ...candidate }, expectedVersion: fresh.version });
      const receipt = await call(() => adapter.execute({ ...candidate }, { expectedVersion: fresh.version, signal: controller.signal }));
      if (receipt == null) return result(false, 'execution_uncertain');
      phase = 'observe_after';
      const after = projectSnapshot(await call(() => adapter.observe(options)));
      phase = 'verify';
      const verification = await call(() => adapter.verify({ before: fresh, after, candidate: { ...candidate }, receipt }, options));
      const verified = verification?.outcome === 'verified' && validText(verification.evidence, 1500);
      await record({ step, phase, outcome: verified ? 'verified' : 'not_verified', evidence: validText(verification?.evidence, 1500) ? verification.evidence : 'No independent verification.', after });
      if (!verified) return result(false, 'not_verified');
      completed.push({ id: candidate.id, label: candidate.label, outcome: 'verified' });
      if (await goal(after, step)) return result(true, 'goal_verified');
    }
    return result(false, 'step_limit');
  } catch (error) {
    const reason = controller.signal.aborted ? abortReason : error?.reason === 'invalid_snapshot' || error?.reason === 'invalid_goal_check' ? error.reason : phase === 'execute' || phase === 'observe_after' || phase === 'verify' ? 'execution_uncertain' : 'dependency_error';
    await record({ phase: 'stop', during: phase, reason, ...(typeof error?.code === 'string' && /^[A-Z_]{1,60}$/.test(error.code) ? {code:error.code} : {}) });
    return result(false, reason);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
