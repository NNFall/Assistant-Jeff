import { randomUUID } from 'node:crypto';
import { LocalToolRegistry, normalizeToolResult, stableArguments } from './registry.mjs';
import { LOG_DIRECTORY, RunJournal } from '../../scripts/desktop-lab/journal.mjs';

const MAX_COMMAND_CHARS = 4_096;
const MAX_ASSISTANT_TEXT = 2_000;
const MAX_HISTORY_TURNS = 8;
const MAX_HISTORY_BYTES = 24 * 1024;
const HISTORY_TTL_MS = 30 * 60 * 1_000;
const MAX_RESPONSE_PARTS = 64;
const MAX_RESPONSE_TEXT = 128 * 1024;
const MAX_TOOL_ID = 1_024;
const MAX_ERROR_TEXT = 1_000;
const MAX_FINAL_PROTOCOL_CORRECTIONS = 2;
const PROVIDER = 'gemini';

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, maximum = 256 * 1024) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maximum) return undefined;
    return JSON.parse(serialized);
  } catch {
    return undefined;
  }
}

function bounded(value, maximum = MAX_ASSISTANT_TEXT, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text.length <= maximum ? text : `${text.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

function numberNow(now) {
  try {
    const value = typeof now === 'function' ? now() : Date.now();
    return value instanceof Date ? value.getTime() : (Number.isFinite(value) ? value : Date.now());
  } catch {
    return Date.now();
  }
}

function isoAt(now) {
  try { return new Date(numberNow(now)).toISOString(); } catch { return new Date().toISOString(); }
}

function safeTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function abortError(message = 'Выполнение остановлено.') {
  try { return new DOMException(message, 'AbortError'); } catch {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }
}

function isAbort(signal) { return !!signal?.aborted; }

function notify(observer, event) {
  if (typeof observer !== 'function') return;
  try {
    const result = observer(event);
    if (result && typeof result.then === 'function') result.catch(() => {});
  } catch {
    // UI observers are best effort.  A broken renderer must never alter the
    // tool ordering or make an already requested effect unsafe.
  }
}

function validReturnedId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOOL_ID && /^[^\u0000-\u001f\u007f]+$/u.test(value);
}

function publicCall(call) {
  const args = cloneJson(call.args, 64 * 1024);
  return {
    id: bounded(call.id, 160, ''),
    name: bounded(call.name, 160, 'unknown'),
    arguments: args === undefined ? {} : args,
  };
}

function publicText(parts) {
  return parts
    .filter(part => part && typeof part.text === 'string' && part.thought !== true)
    .map(part => part.text)
    .join('')
    .trim()
    .slice(0, MAX_RESPONSE_TEXT);
}

function publicUsage(usage) {
  if (!object(usage)) return undefined;
  const result = {};
  for (const [key, value] of Object.entries(usage)) {
    if (/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key) && (Number.isSafeInteger(value) || typeof value === 'string')) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function publicTool(descriptor) {
  return {
    name: descriptor.name,
    description: descriptor.description,
    parameters: cloneJson(descriptor.parameters) ?? { type: 'object', properties: {}, required: [] },
  };
}

function stripHistory(value, key = '') {
  if (/^(?:snapshot|snapshots|snapshotVersion|snapshot_version|stateVersion|state_version|windows|elements|controls|actionId|action_id|actions|selector|fieldId|field_id|windowId|window_id|nativeWindowId|native_window_id|evidenceId|evidence_id|observation|request|response|trace|traces|candidate|candidates|thought|thoughtSignature|thought_signature|contents|raw)$/iu.test(key)) return undefined;
  if (Array.isArray(value)) return value.slice(0, 32).map(item => stripHistory(item));
  // Keep numeric entity ids in grounded history.  Opaque string ids are
  // execution-local action identifiers and are deliberately not carried over.
  if (key === 'id' && typeof value === 'string') return undefined;
  if (!object(value)) return typeof value === 'string' ? bounded(value, 500) : value;
  // Window snapshots and generated action IDs are valid within the current
  // execution only.  Entity IDs are intentionally retained as references;
  // the current run must reread them before acting.
  const result = {};
  for (const [childKey, child] of Object.entries(value)) {
    const projected = stripHistory(child, childKey);
    if (projected !== undefined) result[childKey] = projected;
  }
  return result;
}

function historyBytes(history) {
  try { return Buffer.byteLength(JSON.stringify(history), 'utf8'); } catch { return Number.MAX_SAFE_INTEGER; }
}

function responseToolDescriptor() {
  return {
    name: 'assistant_respond',
    title: 'Ответ пользователю',
    description: 'Передать пользователю проверенный ответ, уточнение или сообщение о незавершённой задаче. Этот инструмент должен быть единственным вызовом в финальном ответе модели.',
    effect: false,
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['answer', 'completed', 'clarification', 'incomplete'] },
        text: { type: 'string', minLength: 1, maxLength: MAX_ASSISTANT_TEXT },
        evidenceIds: {
          type: 'array',
          description: 'Для completed скопируй точные response.evidenceId из проверенных результатов инструментов. Не используй data.id, идентификатор сущности или текстовую улику.',
          items: { type: 'string', minLength: 1, maxLength: 200 },
          maxItems: 32,
        },
      },
      required: ['status', 'text', 'evidenceIds'],
      additionalProperties: false,
    },
    execute: async args => ({
      ok: true,
      verified: true,
      effectAttempted: false,
      evidence: [],
      message: args.text,
      data: { status: args.status, text: args.text, evidenceIds: args.evidenceIds },
    }),
  };
}

function normalizeResponse(value) {
  if (!object(value) || !object(value.content) || value.content.role !== 'model' || !Array.isArray(value.content.parts) || !value.content.parts.length || value.content.parts.length > MAX_RESPONSE_PARTS) throw new Error('Некорректный ответ агента.');
  const parts = value.content.parts.map(part => {
    if (!object(part)) throw new Error('Некорректная часть ответа агента.');
    const hasText = Object.prototype.hasOwnProperty.call(part, 'text');
    const hasCall = Object.prototype.hasOwnProperty.call(part, 'functionCall');
    if ((hasText ? 1 : 0) + (hasCall ? 1 : 0) !== 1) throw new Error('Некорректная часть ответа агента.');
    const result = {};
    if ('thoughtSignature' in part) {
      if (typeof part.thoughtSignature !== 'string' || part.thoughtSignature.length > 16 * 1024) throw new Error('Некорректная подпись агента.');
      result.thoughtSignature = part.thoughtSignature;
    }
    if (hasText) {
      if (typeof part.text !== 'string' || part.text.length > MAX_RESPONSE_TEXT) throw new Error('Некорректный текст ответа агента.');
      result.text = part.text;
      // Keep this marker only in memory if a provider sends it.  It is never
      // logged and publicText ignores it.
      if (part.thought === true) result.thought = true;
      return result;
    }
    if (!object(part.functionCall) || typeof part.functionCall.name !== 'string' || part.functionCall.name.length < 1 || part.functionCall.name.length > 128) throw new Error('Некорректный вызов агента.');
    const call = { name: part.functionCall.name };
    if ('args' in part.functionCall) call.args = cloneJson(part.functionCall.args, 64 * 1024) ?? part.functionCall.args;
    else call.args = {};
    if ('id' in part.functionCall) {
      if (typeof part.functionCall.id !== 'string' || part.functionCall.id.length > MAX_TOOL_ID) throw new Error('Некорректный идентификатор инструмента.');
      call.id = part.functionCall.id;
    }
    if ('thoughtSignature' in part.functionCall) {
      if (typeof part.functionCall.thoughtSignature !== 'string' || part.functionCall.thoughtSignature.length > 16 * 1024) throw new Error('Некорректная подпись агента.');
      call.thoughtSignature = part.functionCall.thoughtSignature;
    }
    result.functionCall = call;
    return result;
  });
  return {
    content: { role: 'model', parts },
    model: typeof value.model === 'string' ? bounded(value.model, 128, 'unknown') : 'unknown',
    latencyMs: Number.isSafeInteger(value.latencyMs) && value.latencyMs >= 0 ? value.latencyMs : 0,
    usage: publicUsage(value.usage),
  };
}

function responseCallParts(parts) {
  return parts.filter(part => part?.functionCall).map(part => ({
    id: bounded(part.functionCall.id, 160, ''),
    name: bounded(part.functionCall.name, 160, 'unknown'),
    arguments: cloneJson(part.functionCall.args, 64 * 1024) ?? {},
  }));
}

function resultForModel(receipt) {
  const result = {
    ok: receipt.ok === true,
    verified: receipt.verified === true,
    effectAttempted: receipt.effectAttempted === true,
    evidence: Array.isArray(receipt.evidence) ? receipt.evidence.slice(0, 32) : (typeof receipt.evidence === 'string' ? receipt.evidence : []),
    message: bounded(receipt.message, MAX_ERROR_TEXT, 'Инструмент не выполнил действие.'),
  };
  if (typeof receipt.status === 'string' && receipt.status.trim()) result.status = bounded(receipt.status, 120);
  if (typeof receipt.error === 'string' && receipt.error.trim()) result.error = bounded(receipt.error, 160);
  if (receipt.effectConfirmed === true) result.effectConfirmed = true;
  if (receipt.needsObservation === true) result.needsObservation = true;
  if (typeof receipt.evidenceId === 'string' && receipt.evidenceId.trim()) result.evidenceId = bounded(receipt.evidenceId, 200);
  if (receipt.data !== undefined) {
    const data = cloneJson(receipt.data, 64 * 1024);
    if (data !== undefined) result.data = data;
  }
  return result;
}

function responsePart(call, receipt) {
  const functionResponse = {
    name: call.name,
    response: resultForModel(receipt),
  };
  // The provider id belongs to the model turn.  A locally generated journal
  // id is deliberately omitted when the provider did not return an id.
  if (call.providerId) functionResponse.id = call.providerId;
  return { functionResponse };
}

function finalResponseArgs(value) {
  if (!object(value)) return null;
  return {
    status: value.status,
    text: bounded(value.text, MAX_ASSISTANT_TEXT),
    evidenceIds: Array.isArray(value.evidenceIds) ? value.evidenceIds.filter(id => typeof id === 'string').slice(0, 32) : [],
  };
}

function reasonForAbort(state) {
  if (state.executionUncertain) return 'execution_uncertain';
  if (state.timedOut) return 'timeout';
  if (state.stopRequested || isAbort(state.signal)) return 'aborted';
  return null;
}

function responseStatusMessage(status) {
  if (status === 'clarification') return 'Нужно уточнение для продолжения.';
  if (status === 'incomplete') return 'Задача не завершена.';
  return 'Не удалось подтвердить результат.';
}

function finalProtocolCorrection(afterEffect) {
  const actionRule = afterEffect
    ? 'После уже выполненного действия нельзя завершать ход обычным текстом или объявлять успех без этого вызова.'
    : 'Текст выше сохранён как контекст; не повторяй действие только из-за этой подсказки.';
  return `Для завершения хода вызови только assistant_respond с полями status (answer, clarification, incomplete или completed), text и evidenceIds. ${actionRule} Для completed укажи точные response.evidenceId из проверенных результатов инструментов; не подставляй data.id.`;
}

function safeErrorCode(error) {
  const value = typeof error?.code === 'string' ? error.code.trim().toUpperCase() : '';
  if (value === 'ABORTED' || value === 'TIMEOUT' || value === 'PROVIDER_ERROR' || value === 'NETWORK_ERROR' || value === 'INVALID_RESPONSE' || value === 'UNKNOWN' || /^HTTP_[45]\d{2}$/u.test(value) || /^E[A-Z0-9_]{1,63}$/u.test(value) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(value)) return value;
  if (Number.isSafeInteger(error?.status) && error.status >= 400 && error.status <= 599) return `HTTP_${error.status}`;
  return 'provider_error';
}

export class AgentCommands {
  constructor({
    createTools,
    modelStep,
    progress = () => {},
    directory = LOG_DIRECTORY,
    now = Date.now,
    maxSteps = 16,
    maxToolCalls = 32,
    timeoutMs = 120_000,
  } = {}) {
    if (typeof createTools !== 'function') throw new TypeError('createTools must be a function');
    if (typeof modelStep !== 'function') throw new TypeError('modelStep must be a function');
    for (const [name, value] of [['maxSteps', maxSteps], ['maxToolCalls', maxToolCalls], ['timeoutMs', timeoutMs]]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
    }
    this.createTools = createTools;
    this.modelStep = modelStep;
    this.progress = progress;
    this.directory = directory;
    this.now = now;
    this.maxSteps = maxSteps;
    this.maxToolCalls = maxToolCalls;
    this.timeoutMs = timeoutMs;
    this._run = null;
    this._history = [];
    this._lastCapabilities = [];
  }

  get running() { return !!this._run; }
  get activeRunId() { return this._run?.state?.runId ?? null; }

  capabilities() {
    if (this._run?.state?.registry) return this._run.state.registry.capabilities().filter(item => item.name !== 'assistant_respond');
    try {
      const registry = new LocalToolRegistry([...(this.createTools() || []), responseToolDescriptor()], { allowReserved: true });
      const result = registry.capabilities().filter(item => item.name !== 'assistant_respond');
      this._lastCapabilities = result;
      return result;
    } catch {
      return this._lastCapabilities.slice();
    }
  }

  clearContext() {
    if (this.running) return false;
    this._history = [];
    return true;
  }

  stop() {
    if (!this._run) {
      this._history = [];
      return false;
    }
    this._run.state.stopRequested = true;
    this._run.state.historyCleared = true;
    this._history = [];
    try { this._run.controller.abort(abortError()); } catch { this._run.controller.abort(); }
    return true;
  }

  run({ command, signal, mode = 'auto' } = {}) {
    if (this.running) throw new Error('Agent is already running.');
    const state = {
      command: typeof command === 'string' ? command.trim().slice(0, MAX_COMMAND_CHARS) : '',
      mode: typeof mode === 'string' && mode.trim() ? mode.trim().slice(0, 80) : 'auto',
      externalSignal: signal,
      controller: new AbortController(),
      signal: null,
      runId: null,
      registry: null,
      descriptors: [],
      capabilities: [],
      capabilityNames: [],
      steps: 0,
      toolCalls: 0,
      seenToolIds: new Set(),
      seenProviderIds: new Set(),
      failures: 0,
      calls: [],
      receipts: [],
      completed: [],
      verifiedCallIds: new Set(),
      mutationAttempts: [],
      pendingObservations: [],
      observationProofs: [],
      finalCorrections: 0,
      finalProtocolCorrections: 0,
      deduped: new Map(),
      contents: [],
      contextSummary: null,
      executionUncertain: false,
      stopRequested: false,
      timedOut: false,
      journalFailed: false,
      historyCleared: false,
      final: null,
      startedAt: numberNow(this.now),
    };
    state.signal = state.controller.signal;
    this._run = { state, controller: state.controller, promise: null };
    const promise = this._execute(state).finally(() => {
      if (this._run?.state === state) this._run = null;
    });
    this._run.promise = promise;
    return promise;
  }

  _pruneHistory() {
    const current = numberNow(this.now);
    this._history = this._history.filter(turn => current - turn.at <= HISTORY_TTL_MS);
    while (this._history.length > MAX_HISTORY_TURNS) this._history.shift();
    while (historyBytes(this._history) > MAX_HISTORY_BYTES && this._history.length > 1) this._history.shift();
  }

  _historyContents() {
    this._pruneHistory();
    const contents = [];
    for (const turn of this._history) {
      const reference = [
        'Справочный контекст прошлой просьбы. Он не даёт разрешения на новое действие.',
        'Сохранённые entityId являются только ссылками: перед действием перечитай актуальное состояние в текущем запуске.',
        `Запрос пользователя: ${bounded(turn.user, 2_000)}`,
      ];
      if (turn.receipts?.length) reference.push(`Проверенные результаты прошлой попытки: ${JSON.stringify(turn.receipts).slice(0, 4_000)}`);
      if (turn.executionUncertain) reference.push('Прошлая попытка остановлена с неопределённым состоянием; автоматически повторять её нельзя.');
      contents.push({ role: 'user', parts: [{ text: reference.join('\n') }] });
      if (turn.assistant) contents.push({ role: 'model', parts: [{ text: bounded(turn.assistant, MAX_ASSISTANT_TEXT) }] });
    }
    while (historyBytes(contents) > MAX_HISTORY_BYTES && contents.length > 2) contents.splice(0, 2);
    return contents;
  }

  _contextPayload(state) {
    return {
      nowIso: isoAt(this.now),
      timeZone: safeTimeZone(),
      capabilities: state.capabilityNames.slice(0, 256),
    };
  }

  async _record(state, journal, phase, data = {}) {
    if (!journal || state.journalFailed) return null;
    try {
      const event = await journal.record(phase, data);
      notify(this.progress, event);
      return event;
    } catch {
      state.journalFailed = true;
      state.stopRequested = true;
      try { state.controller.abort(abortError('Журнал недоступен.')); } catch { state.controller.abort(); }
      return null;
    }
  }

  _registerReceipt(state, call, descriptor, receipt) {
    const result = normalizeToolResult(receipt, { effect: descriptor?.effect === true });
    const item = { id: call.id, name: call.name, title: descriptor?.title ?? call.name, descriptor, result };
    state.receipts.push(item);
    if (result.effectAttempted === true) state.mutationAttempts.push(item);
    if (result.ok === true && result.verified === true) {
      if (call.name !== 'assistant_respond') {
        result.evidenceId = call.id;
        state.verifiedCallIds.add(call.id);
      }
      if (descriptor?.effect === true && result.effectAttempted === true) {
        const evidence = [call.id];
        state.completed.push({ operation: call.name, id: call.id, label: descriptor.title, outcome: 'verified', evidence: evidence.length ? evidence : [call.id] });
        if (!descriptor.repeatable) state.deduped.set(`${call.name}:${stableArguments(call.args)}`, result);
      }
    }
    if (result.effectAttempted === true && result.verified !== true && result.effectConfirmed !== true) state.executionUncertain = true;
    if (descriptor?.effect === true && result.effectAttempted === true && result.effectConfirmed === true && result.needsObservation === true && result.verified !== true) {
      const evidence = [call.id];
      state.pendingObservations.push(item);
      const completedEntry = { operation: call.name, id: call.id, label: descriptor.title, outcome: 'observed_change', evidence: evidence.length ? evidence : [call.id] };
      item.completedEntry = completedEntry;
      state.completed.push(completedEntry);
      if (!descriptor.repeatable) state.deduped.set(`${call.name}:${stableArguments(call.args)}`, result);
    }
    // A successful read made after a mechanically confirmed effect is the
    // goal evidence that closes the pending observation gate.  The read
    // itself remains the only eligible evidence id for final completion.
    if (descriptor?.observation === true && result.ok === true && result.verified === true && state.pendingObservations.length) {
      result.evidenceId = call.id;
      state.verifiedCallIds.add(call.id);
      for (const pending of state.pendingObservations) {
        pending.verifiedBy = call.id;
        if (pending.completedEntry) pending.completedEntry.verifiedBy = call.id;
      }
      state.observationProofs.push(call.id);
      state.pendingObservations = [];
    }
    if (result.ok === true) state.failures = 0;
    else state.failures += 1;
    return result;
  }

  _baseReport(state, journal) {
    return {
      mode: 'AGENT_ASSISTANT',
      runId: state.runId,
      command: state.command,
      goal: state.command,
      createdAt: journal?.initial?.createdAt ?? isoAt(this.now),
      ok: false,
      reason: 'agent_incomplete',
      needsClarification: false,
      message: '',
      calls: state.calls.slice(),
      trace: journal?.events ? cloneJson(journal.events) ?? [] : [],
      completed: state.completed.slice(),
      evidenceIds: state.final?.evidenceIds?.slice?.() ?? [],
      executionUncertain: state.executionUncertain === true,
      capabilities: state.capabilities.slice(),
      context: state.contextSummary ? { ...state.contextSummary } : null,
      elapsedMs: Math.max(0, numberNow(this.now) - state.startedAt),
    };
  }

  async _finish(state, journal, { reason = 'agent_incomplete', message = '', ok = false, needsClarification = false, final = null, errorCode = '' } = {}) {
    if (state.executionUncertain) reason = 'execution_uncertain';
    const aborted = reasonForAbort(state);
    if (aborted && !['agent_completed', 'agent_answer', 'clarification_required'].includes(reason) && !state.executionUncertain) reason = aborted;
    if (!message) {
      if (reason === 'aborted') message = 'Выполнение остановлено.';
      else if (reason === 'timeout') message = 'Время выполнения истекло.';
      else if (reason === 'execution_uncertain') message = 'Действие остановлено: результат нельзя надёжно подтвердить.';
      else if (reason === 'provider_error') message = 'Не удалось получить корректный ответ сервиса агента.';
      else message = 'Задача не завершена.';
    }
    message = bounded(message, MAX_ASSISTANT_TEXT, 'Задача не завершена.');
    state.final = final ?? state.final;
    const report = this._baseReport(state, journal);
    report.ok = ok === true && !state.executionUncertain;
    report.reason = reason;
    report.needsClarification = needsClarification === true;
    report.message = message;
    if (errorCode) report.error = bounded(errorCode, 80, 'provider_error');
    report.evidenceIds = state.final?.evidenceIds?.slice?.() ?? [];
    report.executionUncertain = state.executionUncertain === true;
    report.elapsedMs = Math.max(0, numberNow(this.now) - state.startedAt);

    await this._record(state, journal, 'agent_finished', {
      ok: report.ok,
      reason: report.reason,
      needsClarification: report.needsClarification,
      message: report.message,
      executionUncertain: report.executionUncertain,
      completed: report.completed,
      evidenceIds: report.evidenceIds,
      ...(report.error ? { error: report.error } : {}),
      elapsedMs: report.elapsedMs,
    });
    report.trace = journal?.events ? cloneJson(journal.events) ?? [] : [];
    if (journal) {
      try { await journal.finish(report); }
      catch {
        state.journalFailed = true;
        report.ok = false;
        report.reason = state.executionUncertain ? 'execution_uncertain' : 'LOG_WRITE_FAILED';
        report.message = state.executionUncertain ? report.message : 'Не удалось сохранить журнал.';
      }
    }
    if (!state.historyCleared) {
      const receipts = state.receipts.slice(-16).map(item => ({
        name: item.name,
        id: item.id,
        result: stripHistory(resultForModel(item.result)),
      }));
      this._history.push({ at: numberNow(this.now), user: state.command, assistant: report.message, receipts, executionUncertain: report.executionUncertain });
      this._pruneHistory();
    }
    return report;
  }

  async _execute(state) {
    let journal = null;
    let timer = null;
    let removeExternalAbort = null;
    try {
      if (state.externalSignal) {
        const onAbort = () => {
          state.stopRequested = true;
          try { state.controller.abort(state.externalSignal.reason ?? abortError()); } catch { state.controller.abort(); }
        };
        removeExternalAbort = () => state.externalSignal.removeEventListener('abort', onAbort);
        if (state.externalSignal.aborted) onAbort();
        else state.externalSignal.addEventListener('abort', onAbort, { once: true });
      }
      timer = setTimeout(() => {
        state.timedOut = true;
        try { state.controller.abort(new Error('timeout')); } catch { state.controller.abort(); }
      }, this.timeoutMs);

      try {
        const rawDescriptors = await this.createTools();
        state.descriptors = Array.isArray(rawDescriptors) ? rawDescriptors : [];
        state.registry = new LocalToolRegistry([...state.descriptors, responseToolDescriptor()], { allowReserved: true });
        state.capabilities = state.registry.capabilities().filter(item => item.name !== 'assistant_respond');
        state.capabilityNames = state.capabilities.map(item => item.name);
        this._lastCapabilities = state.capabilities.slice();
      } catch {
        return this._finish(state, null, { reason: 'provider_error', message: 'Не удалось подготовить инструменты агента.' });
      }

      try {
        journal = await RunJournal.create(state.command, { directory: this.directory });
        state.runId = journal.runId;
        if (this._run?.state === state) this._run.state.runId = state.runId;
      } catch {
        state.journalFailed = true;
        return this._finish(state, null, { reason: 'LOG_WRITE_FAILED', message: 'Не удалось открыть журнал выполнения.' });
      }

      this._pruneHistory();
      const historicalContents = this._historyContents();
      state.contents = [...historicalContents, { role: 'user', parts: [{ text: state.command }] }];
      state.contextSummary = {
        historyTurns: historicalContents.filter(content => content.role === 'user').length,
        commandIncluded: true,
        currentTimeIncluded: true,
        timeZone: safeTimeZone(),
      };
      if (!state.command) return this._finish(state, journal, { reason: 'agent_incomplete', message: 'Введите команду для помощника.' });

      const tools = state.descriptors.filter(descriptor => descriptor.available !== false).map(publicTool).concat(publicTool(responseToolDescriptor()));
      state.contextSummary.toolCount = tools.length;
      agentLoop: while (state.steps < this.maxSteps) {
        const aborted = reasonForAbort(state);
        if (aborted) return this._finish(state, journal, { reason: aborted });
        if (state.journalFailed) return this._finish(state, journal, { reason: 'LOG_WRITE_FAILED', message: 'Выполнение остановлено: журнал недоступен.' });

        state.steps += 1;
        const requestText = state.steps === 1 ? state.command : '';
        const payload = {
          contents: cloneJson(state.contents, 512 * 1024) ?? state.contents,
          tools: cloneJson(tools, 128 * 1024) ?? tools,
          context: this._contextPayload(state),
        };
        await this._record(state, journal, 'agent_request', {
          sourceProvider: PROVIDER,
          provider: PROVIDER,
          text: requestText,
          tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
          context: { ...state.contextSummary },
        });
        if (state.journalFailed) return this._finish(state, journal, { reason: 'LOG_WRITE_FAILED', message: 'Выполнение остановлено: журнал недоступен.' });

        let rawResponse;
        try {
          rawResponse = await this.modelStep(payload, { signal: state.signal });
        } catch (error) {
          if (reasonForAbort(state)) return this._finish(state, journal, { reason: reasonForAbort(state) });
          const errorCode = safeErrorCode(error);
          await this._record(state, journal, 'agent_error', { sourceProvider: PROVIDER, provider: PROVIDER, code: errorCode });
          return this._finish(state, journal, { reason: 'provider_error', errorCode });
        }
        let response;
        try { response = normalizeResponse(rawResponse); }
        catch { return this._finish(state, journal, { reason: 'provider_error' }); }
        const calls = responseCallParts(response.content.parts);
        const text = publicText(response.content.parts);
        state.calls.push({
          request: { text: requestText, tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) },
          response: { text, responseCalls: calls, model: response.model, latencyMs: response.latencyMs, ...(response.usage ? { usage: response.usage } : {}) },
        });
        await this._record(state, journal, 'agent_response', {
          sourceProvider: PROVIDER,
          provider: PROVIDER,
          model: response.model,
          latencyMs: response.latencyMs,
          text,
          responseCalls: calls,
          ...(response.usage ? { usage: response.usage } : {}),
        });
        if (state.journalFailed) return this._finish(state, journal, { reason: 'LOG_WRITE_FAILED', message: 'Выполнение остановлено: журнал недоступен.' });

        // The raw model parts are intentionally kept only in the in-memory
        // provider transcript.  They are needed for opaque signatures on the
        // next request, but no report/event ever receives them.
        state.contents.push(cloneJson(response.content, 256 * 1024));
        const functionParts = response.content.parts.filter(part => part.functionCall);
        const responseToolCalls = functionParts.filter(part => part.functionCall.name === 'assistant_respond');
        if (responseToolCalls.length && functionParts.length !== 1) {
          return this._finish(state, journal, { reason: 'agent_incomplete', message: 'Финальный ответ должен быть единственным вызовом assistant_respond.' });
        }

        if (!functionParts.length) {
          state.finalProtocolCorrections += 1;
          if (state.finalProtocolCorrections > MAX_FINAL_PROTOCOL_CORRECTIONS) {
            return this._finish(state, journal, { reason: 'agent_incomplete', message: text || 'Модель не передала assistant_respond.' });
          }
          // Keep the model's text part in the transcript, then add a bounded
          // protocol correction.  A text-only answer never closes a turn:
          // the caller can expose only the validated assistant_respond result.
          state.contents.push({ role: 'user', parts: [{ text: finalProtocolCorrection(state.mutationAttempts.length > 0) }] });
          continue agentLoop;
        }

        const responseProviderIds = new Set();
        const duplicateProviderIds = new Set();
        for (const part of functionParts) {
          if (part.functionCall.name === 'assistant_respond') continue;
          const providerId = validReturnedId(part.functionCall.id) ? part.functionCall.id : null;
          if (!providerId) continue;
          if (responseProviderIds.has(providerId) || state.seenProviderIds.has(providerId)) duplicateProviderIds.add(providerId);
          responseProviderIds.add(providerId);
        }
        if (duplicateProviderIds.size) {
          // Never emit two functionResponse parts with the same provider id.
          // The whole model turn is rejected before any of its effects run;
          // the caller can retry with fresh ids in a new turn.
          return this._finish(state, journal, { reason: 'agent_incomplete', message: 'Модель вернула повторяющийся идентификатор вызова.' });
        }

        const responseParts = [];
        for (const part of functionParts) {
          if (state.toolCalls >= this.maxToolCalls) return this._finish(state, journal, { reason: 'agent_incomplete', message: 'Достигнут предел вызовов инструментов.' });
          state.toolCalls += 1;
          const rawCall = part.functionCall;
          const providerId = validReturnedId(rawCall.id) ? rawCall.id : undefined;
          const call = {
            name: rawCall.name,
            args: rawCall.args,
            id: `${state.runId || 'run'}-tool-${state.toolCalls}`,
            ...(providerId ? { providerId } : {}),
          };
          state.seenToolIds.add(call.id);
          if (providerId && call.name !== 'assistant_respond') state.seenProviderIds.add(providerId);
          const descriptor = state.registry.get(call.name);
          await this._record(state, journal, 'agent_tool_call', {
            toolCall: publicCall(call),
            effect: descriptor?.effect === true,
            title: descriptor?.title ?? call.name,
          });
          if (state.journalFailed) return this._finish(state, journal, { reason: 'LOG_WRITE_FAILED', message: 'Выполнение остановлено: журнал недоступен.' });

          let receipt;
          if (reasonForAbort(state)) {
            receipt = { ok: false, verified: false, effectAttempted: false, evidence: [], message: 'Вызов остановлен до выполнения.', data: { code: 'aborted' } };
          } else if (call.name !== 'assistant_respond' && providerId && duplicateProviderIds.has(providerId)) {
            receipt = { ok: false, verified: false, effectAttempted: false, evidence: [], message: 'Идентификатор вызова уже использован. Повтори вызов с новым идентификатором.', status: 'duplicate_tool_id', data: { code: 'duplicate_tool_id' } };
          } else if (state.pendingObservations.length && (descriptor?.effect === true || call.name === 'assistant_respond')) {
            // A confirmed UI dispatch is not goal evidence.  Until a fresh
            // read closes the gate, no second mutation or final success call
            // may reach an executor.
            receipt = { ok: false, verified: false, effectAttempted: false, evidence: [], message: 'Сначала перечитайте актуальное состояние после подтверждённого действия.', status: 'needs_observation', data: { code: 'needs_observation' } };
          } else if (descriptor?.effect === true && !descriptor.repeatable) {
            const previous = state.deduped.get(`${call.name}:${stableArguments(call.args)}`);
            if (previous) receipt = { ok: false, verified: false, effectAttempted: false, evidence: previous.evidence ?? [], message: 'Это действие уже было выполнено в текущем запуске.', status: 'duplicate_effect', data: { code: 'duplicate_effect', deduplicated: true } };
            else receipt = await state.registry.dispatch(call.name, call.args, { signal: state.signal, context: { command: state.command, runId: state.runId, mode: state.mode, now: numberNow(this.now), timeZone: safeTimeZone(), capabilities: state.capabilityNames.slice() } });
          } else {
            receipt = await state.registry.dispatch(call.name, call.args, { signal: state.signal, context: { command: state.command, runId: state.runId, mode: state.mode, now: numberNow(this.now), timeZone: safeTimeZone(), capabilities: state.capabilityNames.slice() } });
          }
          const normalizedReceipt = this._registerReceipt(state, call, descriptor, receipt);
          const final = call.name === 'assistant_respond' && normalizedReceipt.ok === true ? finalResponseArgs(rawCall.args) : null;
          let finalCorrection = null;
          let finalCorrectionTerminal = false;
          if (call.name === 'assistant_respond' && normalizedReceipt.ok === true) {
            if (!final || !final.text || !['answer', 'completed', 'clarification', 'incomplete'].includes(final.status)) {
              finalCorrection = { ok: false, verified: false, effectAttempted: false, evidence: [], message: 'Финальный ответ модели имеет неверный формат.', status: 'invalid_final', data: { code: 'invalid_final', validEvidenceIds: [...state.verifiedCallIds] } };
              finalCorrectionTerminal = true;
            } else if (final.status === 'completed') {
              const validEvidence = final.evidenceIds.length > 0 && final.evidenceIds.every(id => state.verifiedCallIds.has(id));
              const attemptedVerified = state.mutationAttempts.every(item => item.result.verified === true || (item.result.effectConfirmed === true && item.verifiedBy && final.evidenceIds.includes(item.verifiedBy))) && state.pendingObservations.length === 0;
              if (!validEvidence || !attemptedVerified || state.executionUncertain) {
                finalCorrection = { ok: false, verified: false, effectAttempted: false, evidence: [], message: 'Сошлись только на идентификаторах вызовов с проверенным результатом. Повтори assistant_respond с evidenceIds из списка.', status: 'invalid_evidence', data: { code: 'invalid_evidence', validEvidenceIds: [...state.verifiedCallIds] } };
                finalCorrectionTerminal = state.finalCorrections >= 2;
              }
            } else if (final.status === 'answer' && state.mutationAttempts.length) {
              finalCorrection = { ok: false, verified: false, effectAttempted: false, evidence: [], message: 'После изменения состояния нужен completed с проверенным evidenceIds или пояснение о незавершённости.', status: 'invalid_final', data: { code: 'answer_after_mutation', validEvidenceIds: [...state.verifiedCallIds] } };
              finalCorrectionTerminal = state.finalCorrections >= 2;
            }
            if (finalCorrection && !finalCorrectionTerminal) state.finalCorrections += 1;
          }
          await this._record(state, journal, 'agent_tool_result', {
            toolCallId: call.id,
            name: call.name,
            title: descriptor?.title ?? call.name,
            result: resultForModel(finalCorrection ?? normalizedReceipt),
          });
          responseParts.push(responsePart(call, finalCorrection ?? normalizedReceipt));

          // This check deliberately happens after the result event.  A receipt
          // from an effect that completed immediately before cancellation must
          // remain visible in the durable report.
          if (state.journalFailed) {
            if (normalizedReceipt.effectAttempted === true) state.executionUncertain = true;
            return this._finish(state, journal, { reason: 'LOG_WRITE_FAILED', message: 'Выполнение остановлено: журнал недоступен.' });
          }
          if (state.executionUncertain) return this._finish(state, journal, { reason: 'execution_uncertain' });
          if (reasonForAbort(state)) return this._finish(state, journal, { reason: reasonForAbort(state) });
          if (state.failures >= 3) return this._finish(state, journal, { reason: 'agent_incomplete', message: 'Инструменты несколько раз отклонили запрос.' });

          if (call.name === 'assistant_respond' && normalizedReceipt.ok === true) {
            if (finalCorrection) {
              // Only the correction is appended to the provider transcript;
              // duplicate function responses with the same call id would make
              // Gemini associate a stale receipt with the next turn.
              state.contents.push({ role: 'user', parts: responseParts });
              if (finalCorrectionTerminal) return this._finish(state, journal, { reason: 'agent_incomplete', message: finalCorrection.message, final });
              continue agentLoop;
            }
            // Keep the final function response in the in-memory transcript as
            // well.  It is not sent again because assistant_respond closes a
            // turn, but a completed run still has a complete per-run history.
            state.contents.push({ role: 'user', parts: responseParts });
            state.final = final;
            if (final.status === 'completed') {
              return this._finish(state, journal, { reason: 'agent_completed', ok: true, message: final.text, final });
            }
            if (final.status === 'answer') {
              return this._finish(state, journal, { reason: 'agent_answer', ok: true, message: final.text, final });
            }
            if (final.status === 'clarification') return this._finish(state, journal, { reason: 'clarification_required', needsClarification: true, message: final.text || responseStatusMessage(final.status), final });
            return this._finish(state, journal, { reason: 'agent_incomplete', message: final.text || responseStatusMessage(final.status), final });
          }
        }
        state.contents.push({ role: 'user', parts: responseParts });
      }
      return this._finish(state, journal, { reason: 'agent_incomplete', message: 'Достигнут предел шагов агента.' });
    } catch (error) {
      if (state.executionUncertain) return this._finish(state, journal, { reason: 'execution_uncertain' });
      if (reasonForAbort(state)) return this._finish(state, journal, { reason: reasonForAbort(state) });
      const errorCode = safeErrorCode(error);
      await this._record(state, journal, 'agent_error', { sourceProvider: PROVIDER, provider: PROVIDER, code: errorCode });
      return this._finish(state, journal, { reason: 'provider_error', errorCode });
    } finally {
      if (timer) clearTimeout(timer);
      removeExternalAbort?.();
    }
  }
}

export const AgentAssistant = AgentCommands;
export { responseToolDescriptor };
