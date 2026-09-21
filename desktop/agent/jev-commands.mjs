import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJevStepRequest, chooseJevStep } from '../providers/jev-step.mjs';
import { MIN_CONFIDENCE, MIN_PROBABILITY } from '../automation/decision-policy.mjs';
import { readProtected } from '../secrets.mjs';
import { LOG_DIRECTORY, RunJournal, redact } from '../../scripts/desktop-lab/journal.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const MAX_RECENT_STEPS = 8;
const MAX_STALE_REOBSERVATIONS = 2;
const MAX_GOAL_CORRECTIONS = 2;
const MAX_REPEATED_ACTION = 2;
const MAX_LOW_CONFIDENCE_READS = 3;
const MIN_READ_EXPLORATION = 0.2;
const staleCodes = new Set(['STALE_SNAPSHOT', 'TARGET_IDENTITY_CHANGED', 'ELEMENT_IDENTITY_CHANGED', 'FOCUSED_EDIT_CHANGED', 'APP_TARGET_CHANGED', 'STALE_ACTION', 'WINDOWS_STALE_ACTION']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, maximum = 400) => typeof value === 'string' ? value.slice(0, maximum) : '';
const failure = code => Object.assign(new Error(code), { code });
const safeCode = value => /^[A-Z][A-Z0-9_]{0,79}$/u.test(value ?? '') ? value : 'JEV_RUNTIME_ERROR';
const strong = value => Number.isFinite(value.probability) && value.probability >= MIN_PROBABILITY && value.probability <= 1
  && Number.isFinite(value.confidence) && value.confidence >= MIN_CONFIDENCE && value.confidence <= 1;

function json(value, maximum = 256 * 1024) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded) > maximum) throw failure('INVALID_SESSION_DATA');
    return JSON.parse(encoded);
  } catch { throw failure('INVALID_SESSION_DATA'); }
}

function gate(signal) { if (signal.aborted) throw failure('ABORTED'); }

// Observers/providers must honour signal themselves, but a stalled read or
// provider must not keep the public run alive past cancellation or its deadline.
function abortable(work, signal) {
  gate(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(failure('ABORTED')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { gate(signal); return work(); }).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

function compactEvidence(value) {
  const items = Array.isArray(value) ? value : [value];
  return items.slice(0, 4).map(item => {
    if (typeof item === 'string') return bounded(item, 240);
    if (plain(item)) return bounded(item.message || item.summary || item.code || item.scope, 240);
    return '';
  }).filter(Boolean);
}

function recentOutcome(step, candidate, result) {
  return {
    step, label: bounded(candidate.label, 240), operation: bounded(candidate.operation, 80),
    status: bounded(result.status, 80), ok: result.ok === true, verified: result.verified === true,
    effectAttempted: result.effectAttempted === true, effectConfirmed: result.effectConfirmed === true,
    ...(candidate.effect === true && result.ok === true && result.verified === true && result.effectAttempted === false ? { alreadySatisfied: true } : {}),
    message: bounded(result.message), evidence: compactEvidence(result.evidence),
    ...(result.error ? { error: safeCode(typeof result.error === 'string' ? result.error : result.error.code) } : {}),
  };
}

function actionKey(candidate) {
  if (typeof candidate.stableKey === 'string' && candidate.stableKey) return candidate.stableKey;
  // Ephemeral action ids change after observation. Never use them for deduping.
  return JSON.stringify([candidate.operation, candidate.targetId ?? null, candidate.label, candidate.args ?? null]);
}

function observation(value) {
  if (!plain(value) || !Array.isArray(value.candidates) || !Object.hasOwn(value, 'observation')) throw failure('INVALID_OBSERVATION');
  const candidates = json(value.candidates);
  const ids = new Set();
  for (const candidate of candidates) {
    if (!plain(candidate) || typeof candidate.id !== 'string' || !candidate.id || ['done', 'unavailable'].includes(candidate.id)
      || ids.has(candidate.id) || typeof candidate.label !== 'string' || !candidate.label.trim()
      || typeof candidate.operation !== 'string' || !candidate.operation || typeof candidate.effect !== 'boolean') throw failure('INVALID_CANDIDATES');
    ids.add(candidate.id);
  }
  // A full native snapshot may be offered for local verification. Only the
  // session's compact observation is sent to Jev and carried into the next step.
  return { observation: json(value.observation), candidates };
}

function decision(value) {
  if (!plain(value)) throw failure('INVALID_DECISION');
  return {
    choice: value.choice, actionId: value.actionId ?? null, probability: value.probability, confidence: value.confidence,
    ...(value.probabilities ? { probabilities: json(value.probabilities, 64 * 1024) } : {}),
    model: bounded(value.model, 120), latencyMs: Number.isFinite(value.latencyMs) ? value.latencyMs : null,
    ...(value.usage ? { usage: json(value.usage, 4096) } : {}),
  };
}

function receipt(value, candidate) {
  if (!plain(value) || typeof value.ok !== 'boolean' || typeof value.verified !== 'boolean'
    || typeof value.effectAttempted !== 'boolean' || typeof value.status !== 'string'
    || (value.effectConfirmed !== undefined && typeof value.effectConfirmed !== 'boolean')
    || (value.operation !== undefined && value.operation !== candidate.operation)
    || (value.targetId !== undefined && candidate.targetId !== undefined && value.targetId !== candidate.targetId)) throw failure('INVALID_EXECUTION_RESULT');
  return json(value);
}

function effectSummary(completed) {
  if (!completed.length) return 'none';
  if (completed.some(item => item.outcome === 'dispatched')) return 'dispatched';
  if (completed.some(item => item.outcome === 'observed_change')) return 'observed_change';
  return 'native_postconditions';
}

function messageFor(reason) {
  const messages = {
    goal_verified: 'Результат задачи подтверждён проверкой текущего состояния.',
    goal_model_assessed: 'По оценке Jev, задача выполнена. Подтверждения отдельных действий записаны в журнале.',
    goal_not_verified: 'Достижение цели не подтверждено.',
    low_confidence: 'Jev недостаточно уверен в следующем действии.',
    unknown_action: 'Jev выбрал действие, которого нет в текущем наблюдении.',
    repeated_action: 'Выполнение остановлено, чтобы не повторять уже переданное действие.',
    stale_limit: 'Интерфейс несколько раз изменился перед действием.',
    unavailable: 'В текущем интерфейсе нет подходящего доступного действия.',
    step_limit: 'Достигнут предел шагов; задача не завершена.',
    time_limit: 'Время выполнения истекло.',
    aborted: 'Выполнение остановлено.',
    execution_uncertain: 'Действие могло выполниться, но его результат неизвестен. Проверьте приложение перед повтором.',
    execution_failed: 'Исполнитель отклонил действие; задача не завершена.',
    LOG_WRITE_FAILED: 'Выполнение остановлено: журнал недоступен.',
    provider_error: 'Не удалось получить корректное решение Jev.',
  };
  return messages[reason] ?? 'Задача не завершена.';
}

export class JevCommands {
  constructor({
    progress = () => {}, directory = LOG_DIRECTORY,
    apiKeyResolver = async () => process.env.TYPESAFE_API_KEY || await readProtected(path.join(root, 'data', 'secrets', 'typesafe.dpapi')),
    createSession, choose = chooseJevStep, journalFactory = RunJournal.create,
    maxSteps = 24, maxDurationMs = 120_000,
  } = {}) {
    for (const [name, value] of Object.entries({ createSession, choose, apiKeyResolver, journalFactory })) {
      if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
    }
    for (const [name, value] of Object.entries({ maxSteps, maxDurationMs })) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new TypeError(`${name} must be a positive bounded integer`);
    }
    Object.assign(this, { progress, directory, apiKeyResolver, createSession, choose, journalFactory, maxSteps, maxDurationMs });
    this._run = null;
  }

  get running() { return this._run !== null; }
  get activeRunId() { return this._run?.report.runId ?? null; }
  capabilities() {
    return [
      { name: 'jev_desktop_observe', title: 'Чтение интерфейса Windows', effect: false },
      { name: 'jev_desktop_execute', title: 'Jev выбирает доступные действия Windows', effect: true },
    ];
  }
  clearContext() { return !this.running; }
  stop() {
    if (!this._run) return false;
    this._run.controller.abort('user_stop');
    return true;
  }

  run({ command, signal } = {}) {
    if (this.running) throw failure('TASK_ALREADY_RUNNING');
    if (typeof command !== 'string' || !command.trim() || command.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(command)) throw failure('INVALID_COMMAND');
    const state = {
      controller: new AbortController(), started: performance.now(), finalizing: false, returned: false,
      pendingEffect: false, inFlightEffect: false, journalFailed: false, phase: 'setup',
      recentSteps: [], repeats: new Map(), noRepeat: new Set(), staleRetries: 0, goalCorrections: 0,
      report: {
        mode: 'JEV_DESKTOP', provider: 'jev', command: command.trim(), goal: command.trim(), createdAt: new Date().toISOString(),
        ok: false, reason: 'step_limit', message: '', calls: [], trace: [], events: [], completed: [], satisfiedPostconditions: [],
        executionUncertain: false, goalVerification: 'not_verified', effectVerification: 'none', lowConfidenceReads: 0,
      },
    };
    this._run = state;
    return this._execute(state, signal).finally(() => {
      state.returned = true;
      // A native adapter ignoring abort may still be performing an effect.
      // Keep the single-flight lock until its underlying promise settles.
      if (!state.pendingEffect && this._run === state) this._run = null;
    });
  }

  async _execute(state, externalSignal) {
    const { report, controller } = state;
    const signal = controller.signal;
    const cancel = () => controller.abort(externalSignal?.reason === 'time_limit' ? 'time_limit' : 'user_stop');
    externalSignal?.addEventListener('abort', cancel, { once: true });
    if (externalSignal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort('time_limit'), this.maxDurationMs);
    let journal;
    const record = async (phase, data = {}) => {
      if (state.finalizing && phase !== 'result') return;
      let item;
      try { item = await journal.record(phase, data); }
      catch { state.journalFailed = true; throw failure('LOG_WRITE_FAILED'); }
      report.trace.push(item);
      try { Promise.resolve(this.progress(item)).catch(() => {}); } catch { /* Renderer is best effort. */ }
      return item;
    };
    const remember = outcome => { state.recentSteps.push(outcome); state.recentSteps = state.recentSteps.slice(-MAX_RECENT_STEPS); };
    try {
      try { journal = await this.journalFactory(report.command, { directory: this.directory }); }
      catch { throw failure('LOG_WRITE_FAILED'); }
      report.runId = journal.runId;
      report.logPath = journal.jsonPath;
      gate(signal);
      const session = await abortable(() => this.createSession({ command: report.command, signal }), signal);
      if (!session || typeof session.observe !== 'function' || typeof session.execute !== 'function') throw failure('INVALID_SESSION');
      const apiKey = await abortable(() => this.apiKeyResolver(), signal);
      if (typeof apiKey !== 'string' || !apiKey.trim()) throw failure('TYPESAFE_KEY_MISSING');
      for (let step = 1; step <= this.maxSteps; step++) {
        state.phase = 'observe';
        const current = observation(await abortable(() => session.observe({ signal }), signal));
        await record('observe', { step, observation: current.observation, candidates: current.candidates, message: 'Прочитан текущий интерфейс и доступные действия.' });
        const input = {
          command: report.command, observation: current.observation,
          candidates: current.candidates.map(({ id, label, operation, effect, target }) => ({ id, label, operation, effect, ...(target === undefined ? {} : { target }) })),
          recentSteps: json(state.recentSteps),
        };
        const call = { kind: 'jev_step', step, request: buildJevStepRequest(input) };
        report.calls.push(call);
        await record('model_request', { step, request: call.request, message: 'Jev выбирает следующий шаг по текущему интерфейсу.' });
        state.phase = 'choose';
        const pendingWrites = [];
        let chosen;
        try {
          chosen = decision(await abortable(() => this.choose(input, {
            apiKey, signal,
            onResponse: response => {
              if (state.finalizing || signal.aborted) return;
              call.response = json(response);
              const write = record('model_response', { step, response: call.response });
              write.catch(() => {});
              pendingWrites.push(write);
            },
          }), signal));
        } catch (error) {
          call.error = safeCode(error?.code);
          if (!signal.aborted) await record('model_error', { step, code: call.error, message: 'Не удалось получить допустимое решение Jev.' });
          throw error;
        }
        await Promise.all(pendingWrites);
        gate(signal);
        call.decision = chosen;
        const candidate = current.candidates.find(item => item.id === chosen.choice);
        const label = candidate?.label ?? (chosen.choice === 'done' ? 'Завершить задачу' : chosen.choice === 'unavailable' ? 'Нет доступного действия' : 'Неизвестное действие');
        await record('model_decision', { step, ...chosen, label, message: `Выбор Jev: ${label}` });
        // A bounded inspect can reveal the controls needed for a strong effect
        // choice. It grants no permission to mutate or to claim completion.
        const lowConfidenceExploration = !strong(chosen) && candidate?.effect === false && candidate.operation === 'inspect'
          && (chosen.actionId === null || chosen.actionId === chosen.choice)
          && Number.isFinite(chosen.probability) && chosen.probability >= MIN_READ_EXPLORATION && chosen.probability <= 1
          && Number.isFinite(chosen.confidence) && chosen.confidence >= MIN_READ_EXPLORATION && chosen.confidence <= 1
          && report.lowConfidenceReads < MAX_LOW_CONFIDENCE_READS;
        if (!strong(chosen) && !lowConfidenceExploration) { report.reason = 'low_confidence'; break; }
        if (['done', 'unavailable'].includes(chosen.choice)) {
          if (chosen.actionId !== null) { report.reason = 'unknown_action'; break; }
          if (chosen.choice === 'unavailable') { report.reason = 'unavailable'; break; }
          if (typeof session.verifyGoal === 'function') {
            state.phase = 'verify';
            const proof = json(await abortable(() => session.verifyGoal(report.command, { signal }), signal));
            await record('goal_verify', { step, result: proof, message: proof?.verified === true ? 'Проверено фактическое состояние цели.' : 'Проверка конечной цели.' });
            report.goalEvidence = proof;
            if (proof?.applicable !== false) {
              if (proof?.verified === true) {
                report.ok = true; report.reason = 'goal_verified'; report.goalVerification = 'native_verified';
                report.alreadySatisfied = report.completed.length === 0;
                break;
              }
              remember(recentOutcome(step, { label: 'Проверка конечной цели', operation: 'verify_goal' }, {
                ok: false, verified: false, effectAttempted: false, status: 'goal_not_verified', evidence: proof?.evidence,
                message: 'Измеренная конечная цель пока не достигнута. Нужно другое действие или отказ.',
              }));
              if (++state.goalCorrections <= MAX_GOAL_CORRECTIONS) continue;
              report.reason = 'goal_not_verified'; break;
            }
          }
          if (!report.completed.length && !report.satisfiedPostconditions.length) { report.reason = 'goal_not_verified'; break; }
          report.ok = true; report.reason = 'goal_model_assessed'; report.goalVerification = 'model_assessed';
          report.alreadySatisfied = report.completed.length === 0;
          break;
        }
        if (!candidate || (!lowConfidenceExploration && chosen.actionId !== candidate.id)) { report.reason = 'unknown_action'; break; }
        const key = actionKey(candidate);
        if (state.noRepeat.has(key) || (state.repeats.get(key) ?? 0) >= MAX_REPEATED_ACTION) { report.reason = 'repeated_action'; break; }
        if (lowConfidenceExploration) {
          report.lowConfidenceReads++;
          await record('low_confidence_exploration', { step, actionId: candidate.id, label: candidate.label, probability: chosen.probability,
            confidence: chosen.confidence, effect: false, count: report.lowConfidenceReads, limit: MAX_LOW_CONFIDENCE_READS,
            message: 'Ограниченное чтение интерфейса для поиска доступных действий; порог для эффектов остаётся 0,8.' });
        }
        state.phase = 'execute';
        await record('execute_request', { step, actionId: candidate.id, label: candidate.label, operation: candidate.operation, effect: candidate.effect, lowConfidenceExploration, candidate, message: candidate.label });
        try { await journal.flush(); } catch { throw failure('LOG_WRITE_FAILED'); }
        gate(signal);
        let result;
        try {
          result = await abortable(() => {
            const executing = Promise.resolve().then(() => {
              gate(signal);
              state.inFlightEffect = candidate.effect;
              return session.execute(candidate.id, { signal });
            });
            if (candidate.effect) {
              state.pendingEffect = true;
              const settled = () => {
                state.pendingEffect = false;
                if (state.returned && this._run === state) this._run = null;
              };
              executing.then(settled, settled);
            }
            return executing;
          }, signal);
          result = receipt(result, candidate);
        } catch (error) {
          if (error?.details?.effectAttempted === false) {
            state.inFlightEffect = false;
            result = { ok: false, verified: false, effectAttempted: false, status: staleCodes.has(error.code) ? 'stale' : 'failed', error: safeCode(error.code), message: 'Действие отклонено до выполнения.' };
          } else throw error;
        }
        if (result.effectAttempted === false) state.inFlightEffect = false;
        const stale = result.effectAttempted === false && (result.status === 'stale' || staleCodes.has(typeof result.error === 'string' ? result.error : result.error?.code));
        const confirmed = result.ok && result.effectAttempted && (result.verified || result.effectConfirmed);
        const dispatched = result.ok && result.effectAttempted && ['dispatched', 'state_changed'].includes(result.status);
        const successfulEffect = candidate.effect && (confirmed || dispatched);
        if (result.effectAttempted && !successfulEffect) report.executionUncertain = true;
        const satisfiedWithoutEffect = candidate.effect && result.ok && result.verified && !result.effectAttempted;
        if (satisfiedWithoutEffect) {
          // An idempotent effect can prove its postcondition already holds.
          // Keep this separate from performed mutations and from inspect reads.
          report.satisfiedPostconditions.push({ step, id: candidate.id, label: candidate.label, operation: candidate.operation,
            ...(candidate.targetId ? { targetId: candidate.targetId } : {}), evidence: compactEvidence(result.evidence) });
        }
        if (successfulEffect) {
          const outcome = result.verified ? 'verified' : result.effectConfirmed || result.status === 'state_changed' ? 'observed_change' : 'dispatched';
          report.completed.push({ step, id: candidate.id, label: candidate.label, operation: candidate.operation, ...(candidate.targetId ? { targetId: candidate.targetId } : {}), outcome, evidence: compactEvidence(result.evidence) });
          // An acknowledged dispatch without its native postcondition can be
          // followed only by a fresh observation and a DIFFERENT action.
          if (!result.verified) state.noRepeat.add(key);
        }
        state.inFlightEffect = false;
        remember(recentOutcome(step, candidate, result));
        await record('execute_result', { step, actionId: candidate.id, label: candidate.label, operation: candidate.operation, result, ...(plain(result.data?.receipt) ? { receipt: result.data.receipt } : {}), message: bounded(result.message) });
        await record('verify', { step, actionId: candidate.id, label: candidate.label, outcome: satisfiedWithoutEffect ? 'already_satisfied' : stale ? 'stale' : result.verified ? 'verified' : successfulEffect ? result.effectConfirmed || result.status === 'state_changed' ? 'observed_change' : 'dispatched' : 'not_verified', verified: result.verified, effectConfirmed: result.effectConfirmed === true, evidence: result.evidence, message: satisfiedWithoutEffect ? 'Проверенное условие уже выполнено; нового действия не потребовалось.' : result.effectAttempted ? 'Проверен результат отдельного действия; цель оценивается отдельно.' : 'Действие не изменяло интерфейс.' });
        gate(signal);
        if (report.executionUncertain) { report.reason = 'execution_uncertain'; break; }
        if (stale) {
          if (++state.staleRetries > MAX_STALE_REOBSERVATIONS) { report.reason = 'stale_limit'; break; }
          await record('stale', { step, message: 'Исполнитель отклонил устаревшее действие до эффекта; читаем интерфейс заново.' });
          continue;
        }
        state.staleRetries = 0;
        state.repeats.set(key, (state.repeats.get(key) ?? 0) + 1);
        if (!result.ok) { report.reason = 'execution_failed'; break; }
      }
    } catch (error) {
      report.ok = false;
      report.executionUncertain ||= state.inFlightEffect;
      report.error = safeCode(error?.code);
      report.reason = report.executionUncertain ? 'execution_uncertain'
        : signal.aborted ? signal.reason === 'time_limit' ? 'time_limit' : 'aborted'
          : state.journalFailed || error?.code === 'LOG_WRITE_FAILED' ? 'LOG_WRITE_FAILED'
            : state.phase === 'choose' ? 'provider_error' : safeCode(error?.code);
    } finally {
      state.finalizing = true;
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', cancel);
      report.elapsedMs = Math.round(performance.now() - state.started);
      report.effectVerification = effectSummary(report.completed);
      report.message = messageFor(report.reason);
      if (journal) {
        try {
          await record('result', { ok: report.ok, reason: report.reason, message: report.message, executionUncertain: report.executionUncertain,
            goalVerification: report.goalVerification, effectVerification: report.effectVerification, elapsedMs: report.elapsedMs });
          report.events = journal.events;
          await journal.finish(report);
        } catch {
          report.ok = false;
          report.reason = 'LOG_WRITE_FAILED';
          report.message = messageFor(report.reason);
          report.events = journal.events ?? report.trace;
        }
      }
    }
    return redact(report);
  }
}
