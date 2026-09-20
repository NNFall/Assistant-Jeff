'use strict';

import { VoiceClient } from './voice-client.mjs';

const $ = (id) => document.getElementById(id);
const presets = {
  custom: { command: '' },
  chrome: { command: 'Сверни Google Chrome.' },
  music: { command: 'Разверни Яндекс Музыку на весь экран.' },
  steam: { command: 'Открой Steam.' },
  taskmgr: { command: 'Открой диспетчер задач.' },
  tabs: { command: 'Найди первую вкладку ВКонтакте в Яндекс Браузере.' },
  note: { command: 'Заметка: купить хлеб.' },
  reminder: { command: 'Напомни через 10 минут проверить чай.' },
  question: { command: 'Объясни, что такое оперативная память.' },
};
const messages = {
  TARGET_MINIMIZED: 'Нужное окно свёрнуто; его элементы сейчас могут быть недоступны.',
  TARGET_WINDOW_MINIMIZED: 'Нужное окно свёрнуто; его элементы сейчас могут быть недоступны.',
  TARGET_SURFACE_MISSING: 'Windows не предоставила элементы нужного приложения. Обновите список окон.',
  TARGET_NOT_RUNNING: 'Нужное приложение сейчас не запущено.',
  WINDOW_NOT_FOUND: 'Нужное окно не найдено. Проверьте, что приложение открыто, и обновите окна.',
  TARGET_WINDOW_MISSING: 'Нужное окно больше не доступно. Обновите окна и повторите задачу.',
  WINDOW_CLOSED: 'Окно закрылось во время выполнения.',
  ACCESS_DENIED: 'Windows не разрешила доступ к этому приложению. Оно может работать с повышенными правами.',
  APP_ELEVATION_REQUIRED: 'Приложению нужны права администратора. Запустите его вручную; Jeff не подтверждает повышение прав.',
  UIA_UNAVAILABLE: 'Приложение не предоставило доступ к нужным элементам через Windows UI Automation.',
  ELEMENT_NOT_FOUND: 'Нужный элемент больше не доступен. Состояние приложения могло измениться.',
  STALE_SNAPSHOT: 'Состояние окна изменилось после наблюдения. Действие по старым данным не выполнено.',
  STALE_TARGET: 'Выбранный элемент изменился или исчез. Нужно новое наблюдение.',
  WINDOWS_HELPER_MISSING: 'Компонент управления Windows не найден. Требуется восстановить его сборку.',
  WINDOWS_TIMEOUT: 'Windows не ответила вовремя. Проверьте, что нужное приложение не зависло.',
  TYPESAFE_KEY_MISSING: 'API-ключ TypeSafe не настроен. Без него Jeff не может получить решение модели.',
  WINDOWS_CHOICE_KEY: 'API-ключ TypeSafe отсутствует или записан некорректно.',
  WINDOWS_CHOICE_INPUT: 'Не удалось подготовить запрос модели по текущему состоянию Windows. Подробности сохранены в журнале.',
  WINDOWS_CHOICE_RESPONSE: 'Jev вернул ответ, который не прошёл проверку формата. Следующее действие не выполнено; подробности — в журнале.',
  WINDOWS_CHOICE_HTTP: 'API TypeSafe отклонил запрос. Проверьте доступность сервиса и настройки API-ключа.',
  WINDOWS_CHOICE_NETWORK: 'Не удалось подключиться к API TypeSafe. Проверьте интернет и повторите задачу.',
  WINDOWS_CHOICE_TIMEOUT: 'Jev не ответил за 12 секунд. Выполнение остановлено; можно повторить задачу.',
  WINDOWS_CHOICE_ABORTED: 'Ожидание решения Jev отменено.',
  no_action: 'Модель не выбрала действие с достаточной уверенностью.',
  low_confidence: 'Уверенность модели ниже порога 0,80. Попробуйте уточнить задачу.',
  no_candidates: 'Для этой задачи не найдено доступных действий. Проверьте список окон и элементов.',
  goal_verified: 'Jev считает цель достигнутой; результаты действий подтверждены состоянием Windows.',
  goal_observed: 'Jev считает задачу выполненной по состоянию интерфейса.',
  goal_not_verified: 'Завершение задачи не подтверждено состоянием приложения.',
  not_verified: 'Действие отправлено, но его результат не удалось подтвердить.',
  execution_uncertain: 'Не удалось определить, выполнилось ли действие. Проверьте приложение перед повтором.',
  stopped_during_action: 'Остановка во время действия: результат неизвестен. Проверьте окно перед повтором.',
  no_state_change: 'После действия наблюдаемое состояние приложения не изменилось.',
  aborted: 'Выполнение остановлено',
  action_low_confidence: 'Jev выбрал действие с уверенностью ниже порога 0,80.',
  goal_low_confidence: 'Jev недостаточно уверен в смысле команды. Попробуйте сформулировать её проще.',
  no_request: 'Это объяснение, цитата или запрет; выполнять действие не требуется.',
  unsupported: 'Для этой задачи пока нет подходящего инструмента или доступного элемента управления.',
  interrupted: 'Запуск был прерван закрытием приложения. Записанные шаги сохранены.',
  time_limit: 'Достигнут лимит времени задачи.',
  step_limit: 'Достигнут лимит шагов. Посмотрите журнал перед повторным запуском.',
  LOG_WRITE_FAILED: 'Не удалось сохранить журнал. Выполнение остановлено.',
  local_completed: 'Локальная операция выполнена.',
  local_rejected: 'Локальная операция не выполнена.',
  chat_answer: 'Получен ответ Gemini.',
  chat_failed: 'Не удалось получить ответ Gemini.',
};
let pending = false;
let opening = false;
let refreshing = false;
let refreshPromise = null;
let stopping = false;
let remoteRunning = false;
let progressCount = 0;
let progressEvents = [];
let reportReceived = false;
let currentRunId = null;
let lastFinishedRunId = null;
let historyLoading = false;
let voice = null;
let voiceState = { state: 'off', enabled: false, busy: false, ready: false, settings: { activationBeep: true, denisReply: true, voiceAutoExecute: true } };
let taskSource = null;
const voiceLabels = { off: 'Микрофон: выкл', idle: 'Микрофон: выкл', stopped: 'Микрофон: выкл', loading: 'Подключение микрофона', waiting: 'Ожидаю Jarvis', recording: 'Слушаю команду', transcribing: 'Распознаю речь', ready: 'Готовлю команду', processing: 'Выполняю задачу', speaking: 'Отвечает Денис', error: 'Ошибка микрофона' };

function value(input) {
  if (input === undefined || input === null) return '—';
  return typeof input === 'object' ? JSON.stringify(input) : String(input);
}
function pretty(input) { return JSON.stringify(input ?? null, null, 2); }
function friendly(input, fallback = 'Не удалось выполнить операцию.') {
  const raw = String(input?.code ?? input?.message ?? input ?? '');
  const code = Object.keys(messages).find(key => new RegExp(`(?:^|\\W)${key}(?:$|\\W)`).test(raw));
  return code ? messages[code] : raw || fallback;
}
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function checked(result) {
  if (result?.error) {
    const failure = new Error(friendly(result.error));
    failure.result = result;
    throw failure;
  }
  return result;
}
function sync() {
  const busy = pending || opening || remoteRunning || voiceState.busy;
  $('run').disabled = busy || !$('command').value.trim() || $('command').value.length > 1024;
  $('start').disabled = busy || refreshing;
  $('scenario').disabled = busy;
  $('command').disabled = busy;
  $('refresh').disabled = opening || refreshing;
  $('stop').disabled = !(pending || remoteRunning || voiceState.busy) || stopping;
  $('stop').textContent = stopping ? 'Останавливаем…' : 'Стоп';
  $('status').textContent = stopping ? 'Остановка' : pending || remoteRunning ? 'Выполняется' : voiceState.busy ? (voiceLabels[voiceState.state] || 'Голосовой ввод') : opening || refreshing ? 'Обновление окон' : 'Готов к задаче';
  $('voice-wake').disabled = !voice || voiceState.ready === false || (!voiceState.enabled && (pending || remoteRunning || opening || voiceState.busy));
  $('voice-wake').textContent = voiceState.enabled ? 'Выключить микрофон' : 'Ожидать Jarvis';
  $('voice-manual').disabled = !voice || voiceState.ready === false || pending || remoteRunning || opening || voiceState.busy;
  $('voice-finish').disabled = !voice || voiceState.state !== 'recording';
  for (const id of ['voice-beep', 'voice-reply', 'voice-auto']) $(id).disabled = !voice || voiceState.ready === false || voiceState.busy || pending;
}
function resetScenario() {
  const preset = presets[$('scenario').value];
  $('command').value = preset.command;
  $('goal').textContent = 'Jeff выбирает следующий шаг по актуальному состоянию компьютера и проверяет изменения после действия.';
  updateCounter();
}
function updateCounter() { $('counter').textContent = `${$('command').value.length} / 1024`; sync(); }

function renderState(state) {
  remoteRunning = state?.running === true;
  if (state?.error) error(friendly(state.error));
  // A failed observation may contain a cached snapshot; never present it as fresh.
  const snapshot = state?.error ? null : state?.snapshot;
  if (snapshot) {
    const version = value(snapshot.version);
    $('snapshot-version').textContent = `Снимок ${version.slice(0, 10)}`;
    $('snapshot-version').title = version;
    $('windows').replaceChildren();
    const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
    $('summary').textContent = `Доступно окон: ${windows.length}. ${snapshot.metadata?.truncated ? 'Некоторые элементы приложения пока не прочитаны.' : 'Состояние получено из Windows.'}`;
    for (const win of windows) {
      const row = document.createElement('li');
      const title = document.createElement('div'); title.className = 'element-title';
      title.textContent = value(win.title ?? win.name ?? win.app ?? win.id);
      const detail = document.createElement('div'); detail.className = 'element-detail';
      detail.textContent = [win.processName, win.minimized ? 'Свёрнуто' : win.maximized ? 'Развёрнуто' : 'Обычный размер', win.active ? 'На переднем плане' : null].filter(Boolean).join(' · ');
      row.append(title, detail); $('windows').append(row);
    }
    if (!windows.length) { const row = document.createElement('li'); row.textContent = 'Список доступных окон пуст.'; $('windows').append(row); }
    $('elements').replaceChildren();
    const elements = (Array.isArray(snapshot.elements) ? snapshot.elements : []).filter(element => element.role !== 'Window');
    for (const element of elements) {
      const row = document.createElement('li');
      const title = document.createElement('div'); title.className = 'element-title';
      title.textContent = value(element.name ?? element.label ?? element.title ?? element.id ?? element);
      const detail = document.createElement('div'); detail.className = 'element-detail';
      detail.textContent = [element.role, element.selected === true ? 'Выбран' : null, element.order ? `Позиция ${element.order}${element.orderIsPartial ? ' среди прочитанных вкладок' : ''}` : null, element.toggleState, element.expandState].filter(Boolean).join(' · ');
      row.append(title, detail); $('elements').append(row);
    }
    if (!elements.length) { const row = document.createElement('li'); row.textContent = 'Наблюдаемых элементов нет.'; $('elements').append(row); }
    $('facts').textContent = pretty({ windows: snapshot.windows, elements: snapshot.elements, facts: snapshot.facts, metadata: snapshot.metadata });
  } else {
    $('snapshot-version').textContent = 'Нет снимка';
    $('snapshot-version').title = '';
    $('summary').textContent = state?.error ? friendly(state.error) : 'Свежего наблюдения нет. Нажмите «Обновить окна».';
    $('windows').replaceChildren(); $('elements').replaceChildren(); $('facts').textContent = 'Нет данных';
  }
  sync();
}
function metric(number) { return typeof number === 'number' && Number.isFinite(number) ? number.toFixed(3) : '—'; }
function addDecision(event) {
  if (progressCount === 0) $('decisions').replaceChildren();
  progressCount++;
  progressEvents.push(event);
  const row = document.createElement('div'); row.className = 'decision';
  const text = document.createElement('p');
  text.textContent = [event?.sequence !== undefined ? `#${event.sequence}` : null, event?.time, event?.phase, event?.message ? friendly(event.message) : null].filter(Boolean).map(value).join(' · ') || 'Обновление выполнения';
  const meta = document.createElement('small');
  const metrics = [];
  if (event?.choice !== undefined) metrics.push(`Решение: ${value(event.choice)}`);
  if (Number.isFinite(event?.probability)) metrics.push(`P: ${metric(event.probability)}`);
  if (Number.isFinite(event?.confidence)) metrics.push(`confidence: ${metric(event.confidence)}`);
  if (Number.isFinite(event?.latencyMs)) metrics.push(`время: ${event.latencyMs} мс`);
  meta.textContent = metrics.join(' · ');
  row.append(text); if (metrics.length) row.append(meta);
  const details = document.createElement('details');
  const heading = document.createElement('summary'); heading.textContent = 'Данные события';
  const data = document.createElement('pre'); data.textContent = pretty(event);
  details.append(heading, data); row.append(details);
  $('decisions').append(row); $('decisions').scrollTop = $('decisions').scrollHeight;
  if (event?.plan !== undefined) $('plan').textContent = pretty(event.plan);
  if (event?.goal !== undefined) $('goal-status').textContent = `Цель: ${value(event.goal)}`;
  if (event?.runId || event?.logPath) $('run-meta').textContent = [event.runId ? `Сессия: ${event.runId}` : '', event.logPath ? `Журнал: ${event.logPath}` : ''].filter(Boolean).join(' · ');
  if (pending && !reportReceived) $('trace').textContent = pretty({ status: 'running', runId: currentRunId, events: progressEvents });
}
async function refresh() {
  if (refreshPromise) { await refreshPromise; return refresh(); }
  refreshing = true; sync();
  refreshPromise = (async () => {
    try { renderState(await window.lab.state()); }
    catch (err) {
      renderState({ running: remoteRunning, error: err?.message || err?.code || 'Не удалось получить наблюдение.' });
    }
    finally { refreshing = false; sync(); }
  })();
  try { await refreshPromise; } finally { refreshPromise = null; }
}
function beginReport(command, source) {
  taskSource = source; pending = true; stopping = false; error(); progressCount = 0; progressEvents = []; $('decisions').replaceChildren();
  reportReceived = false; currentRunId = null;
  $('plan').textContent = command; $('goal-status').textContent = 'Проверяем задачу по текущему состоянию Windows…'; $('run-meta').textContent = '';
  $('verification').textContent = 'Проверка выполняется…'; $('verification').className = 'verification';
  $('trace').textContent = 'Ожидаем отчёт'; $('result-meta').textContent = ''; $('activity').textContent = 'Получаем наблюдение и решение модели…'; sync();
}
function renderReport(report, command = '') {
  reportReceived = true;
  lastFinishedRunId = report?.runId ?? currentRunId ?? lastFinishedRunId;
  if (report?.error && !report?.reason) checked(report);
  if (report?.error) error(friendly(report.error));
  const uncertain = report?.executionUncertain === true;
  const verified = !uncertain && report?.ok === true && report?.reason === 'goal_verified';
  const observed = !uncertain && report?.ok === true && report?.reason === 'goal_observed';
  const local = report?.mode === 'LOCAL_ASSISTANT';
  const chat = report?.mode === 'GEMINI_CHAT';
  const localCompleted = !uncertain && local && report?.ok === true && report?.reason === 'local_completed';
  const chatAnswered = !uncertain && chat && report?.ok === true && report?.reason === 'chat_answer';
  const reply = typeof report?.message === 'string' ? report.message : '';
  const completedCount = Array.isArray(report?.completed) ? report.completed.length : 0;
  const verifiedMessage = completedCount ? messages.goal_verified : 'Jev считает цель достигнутой по текущему состоянию Windows; действий не потребовалось.';
  $('verification').className = `verification ${verified || localCompleted ? 'success' : observed ? 'observed' : chatAnswered ? 'answer' : 'failed'}`;
  const reason = friendly(report?.reason);
  $('verification').textContent = uncertain ? messages.stopped_during_action : local || chat ? [chatAnswered ? 'Ответ Gemini' : localCompleted ? 'Локальная операция выполнена' : reason, reply].filter(Boolean).join(chat ? '\n' : ': ') : verified ? verifiedMessage : observed ? messages.goal_observed : `Результат не подтверждён${report?.reason ? ': ' + reason : '.'}`;
  const callsCount = Array.isArray(report?.calls) ? report.calls.length : 0;
  $('result-meta').textContent = `${chat ? 'Текстовый ответ' : local ? `Локальных операций: ${completedCount}` : `Выполнено действий: ${completedCount}`} · общее время: ${value(report?.elapsedMs)} мс · вызовов модели: ${callsCount}`;
  $('plan').textContent = report?.plan ? pretty(report.plan) : value(report?.goal ?? report?.command ?? command);
  $('goal-status').textContent = uncertain ? 'Результат последнего действия неизвестен.' : chat ? 'Текстовый запрос к Gemini; действия Windows не выполнялись.' : local ? reason : verified ? verifiedMessage : observed ? messages.goal_observed : 'Завершение задачи не подтверждено.';
  $('run-meta').textContent = `Сессия: ${value(report?.runId)} · Журнал: ${value(report?.logPath)}`;
  if (!progressCount && Array.isArray(report?.events ?? report?.trace)) (report.events ?? report.trace).forEach(addDecision);
  $('trace').textContent = pretty(report);
  $('activity').textContent = uncertain ? messages.stopped_during_action : stopping ? 'Запрос завершён после команды остановки. См. фактический результат проверки.' : 'Выполнение завершено. Результат и журнал — ниже.';
}
$('scenario').addEventListener('change', resetScenario);
$('command').addEventListener('input', () => { $('scenario').value = 'custom'; updateCounter(); });
$('refresh').addEventListener('click', () => { error(); void refresh(); });
$('start').addEventListener('click', async () => {
  if (pending || opening || remoteRunning || voiceState.busy) return;
  opening = true; error(); $('activity').textContent = 'Получаем окна и доступные элементы Windows…'; sync();
  try {
    const state = await window.lab.start(); renderState(state);
    $('activity').textContent = state?.error ? 'Не удалось обновить окна.' : state?.snapshot ? 'Состояние Windows обновлено. Можно выполнить задачу.' : 'Windows пока не вернула данные. Попробуйте обновить окна.';
  } catch (err) { renderState({ running: remoteRunning, error: err?.message || 'Не удалось получить окна Windows.' }); }
  finally { opening = false; sync(); }
});
$('run').addEventListener('click', async () => {
  if (pending || opening || remoteRunning || voiceState.busy) return;
  const command = $('command').value.trim();
  if (!command || command.length > 1024) return error('Введите команду до 1024 символов.');
  beginReport(command, 'manual');
  try {
    const report = await window.lab.run({ command });
    // IPC progress can arrive after invoke resolves while the final UIA refresh is pending.
    renderReport(report, command);
  } catch (err) {
    reportReceived = true;
    lastFinishedRunId = currentRunId ?? lastFinishedRunId;
    $('trace').textContent = pretty(err?.result ?? { status: 'failed', runId: currentRunId, error: friendly(err), events: progressEvents });
    error(friendly(err, 'Ошибка выполнения.'));
    $('verification').textContent = 'Результат не подтверждён: отчёт не получен.';
    $('verification').className = 'verification failed'; $('activity').textContent = 'Выполнение завершилось без отчёта.';
  } finally {
    // Stop acknowledgement alone never unlocks a still-pending run.
    remoteRunning = false; // The run promise settled, even if a fresh UIA read now fails.
    await refresh(); pending = false; stopping = false; sync();
    if (!$('history-panel').hidden) void loadHistory();
  }
});
$('stop').addEventListener('click', async () => {
  if (stopping || !(pending || remoteRunning || voiceState.busy)) return;
  stopping = true; sync(); $('activity').textContent = 'Остановка запрошена. Ждём завершения текущей операции…';
  try {
    if (voiceState.enabled || voiceState.busy) await voice?.stop();
    const result = checked(await window.lab.stop());
    if (result?.stopped !== true && result?.ok !== true) error('Подтверждение остановки не получено.');
    if (!pending) { stopping = false; await refresh(); }
  } catch (err) { stopping = false; error(friendly(err, 'Не удалось запросить остановку.')); }
  finally { sync(); }
});
async function loadHistory() {
  if (historyLoading) return;
  historyLoading = true; $('history').disabled = true;
  $('history-status').textContent = 'Читаем журнал…';
  try {
    const result = checked(await window.lab.history());
    const runs = (Array.isArray(result) ? result : result?.runs ?? []).slice(0, 20);
    $('history-list').replaceChildren();
    for (const run of runs) {
      const item = document.createElement('li'); const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${value(run.createdAt)} · ${value(run.command)} · ${friendly(run.reason, 'Без результата')} · ${value(run.elapsedMs)} мс`;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const report = checked(await window.lab.readRun({ runId: run.runId }));
          $('history-json').textContent = pretty(report); $('history-report').open = true;
          $('history-status').textContent = `Сессия: ${value(report?.runId ?? run.runId)} · Журнал: ${value(report?.logPath)}`;
        } catch (err) { $('history-status').textContent = friendly(err, 'Не удалось прочитать сессию.'); }
        finally { button.disabled = false; }
      });
      item.append(button); $('history-list').append(item);
    }
    $('history-status').textContent = runs.length ? `Показано сессий: ${runs.length}. Выберите запись для полного отчёта.` : 'Сохранённых сессий пока нет.';
  } catch (err) { $('history-status').textContent = friendly(err, 'Не удалось загрузить журнал.'); }
  finally { historyLoading = false; $('history').disabled = false; }
}
$('history').addEventListener('click', () => { $('history-panel').hidden = false; void loadHistory(); });
$('open-logs').addEventListener('click', async () => {
  try { checked(await window.lab.openLogs()); }
  catch (err) { $('history-status').textContent = friendly(err, 'Не удалось открыть папку журналов.'); }
});
function voiceError(problem) {
  const mediaErrors = { NotAllowedError: 'Доступ к микрофону не разрешён. Разрешите его в настройках Windows и приложения.', NotFoundError: 'Микрофон не найден. Подключите устройство и повторите.', NotReadableError: 'Микрофон недоступен или занят другим приложением.' };
  $('voice-error').textContent = mediaErrors[problem?.name] || friendly(problem, 'Ошибка голосового ввода.');
  $('voice-error').hidden = false;
  if (taskSource === 'voice' && pending && !reportReceived) {
    $('activity').textContent = 'Голосовой ввод остановлен. Проверьте результат задачи и журнал.';
    pending = false; stopping = false; sync(); void refresh();
  }
}
function renderVoiceState(state) {
  voiceState = state;
  $('voice-state').textContent = voiceLabels[state.state] || state.state;
  $('voice-state').dataset.active = String(state.enabled);
  const fallback = state.state === 'waiting' ? 'Скажите Jarvis, затем команду.' : state.state === 'recording' ? 'Говорите. Завершите фразу паузой или кнопкой «Закончить».' : state.state === 'off' || state.state === 'idle' ? 'Микрофон выключен. Включите ожидание Jarvis или запишите одну команду.' : voiceLabels[state.state] || 'Голосовой ввод';
  $('voice-status').textContent = state.message || fallback;
  $('voice-beep').checked = state.settings.activationBeep;
  $('voice-reply').checked = state.settings.denisReply;
  $('voice-auto').checked = state.settings.voiceAutoExecute;
  $('voice-silence').textContent = `${(state.silenceMs / 1000).toLocaleString('ru-RU')} с`;
  if (state.state === 'processing' && !pending && !remoteRunning) beginReport($('command').value, 'voice');
  sync();
}
async function handleVoiceEvent(event) {
  if (event.type === 'speech_warning') {
    $('voice-warning').textContent = typeof event.message === 'string' ? event.message : 'Голосовой ответ недоступен. Результат показан текстом.';
    $('voice-warning').hidden = false;
  } else if (event.type === 'transcription_metrics') {
    const latency = Number.isFinite(event.latencyMs) ? `${event.latencyMs.toLocaleString('ru-RU')} мс` : 'время не указано';
    $('voice-metrics').textContent = `Распознавание: ${latency}${typeof event.model === 'string' ? ` · ${event.model}` : ''}`;
    $('voice-metrics').hidden = false;
  } else if (event.type === 'reminder') {
    if (typeof event.text !== 'string' || !event.text.trim()) return;
    $('voice-reminder').textContent = `Напоминание: ${event.text}`;
    $('voice-reminder').hidden = false;
  } else if (event.type === 'wake') {
    $('voice-transcript').textContent = 'Слушаю команду…';
    $('voice-warning').hidden = true; $('voice-metrics').hidden = true;
  } else if (event.type === 'transcript') {
    $('voice-transcript').textContent = typeof event.text === 'string' && event.text.trim() ? event.text : 'Речь не распознана.';
    if (event.final === true && typeof event.text === 'string') {
      $('scenario').value = 'custom'; $('command').value = event.text; updateCounter();
      if (!voiceState.settings.voiceAutoExecute) $('activity').textContent = 'Команда распознана. Проверьте текст и нажмите «Выполнить».';
    }
  } else if (event.type === 'result') {
    const report = event.report;
    if (taskSource !== 'voice' || !report || (report.runId && report.runId === lastFinishedRunId) || (currentRunId && report.runId && report.runId !== currentRunId)) return;
    try { renderReport(report, $('command').value); }
    catch (error) { voiceError(error); $('trace').textContent = pretty(report); }
    finally {
      remoteRunning = false; await refresh(); pending = false; stopping = false; sync();
      if (!$('history-panel').hidden) void loadHistory();
    }
  }
}
$('voice-wake').addEventListener('click', async () => {
  if (!voice) return;
  $('voice-error').hidden = true;
  if (voiceState.enabled || voiceState.busy) await voice.stop();
  else if (!pending && !remoteRunning && !opening) await voice.start('wake');
});
$('voice-manual').addEventListener('click', async () => {
  if (!voice || pending || remoteRunning || opening || voiceState.busy) return;
  $('voice-error').hidden = true; $('voice-warning').hidden = true; $('voice-metrics').hidden = true; $('voice-transcript').textContent = 'Готовим микрофон…';
  if (voiceState.enabled) await voice.activate(); else await voice.start('manual');
});
$('voice-finish').addEventListener('click', () => { void voice?.finish(); });
for (const [id, key] of [['voice-beep', 'activationBeep'], ['voice-reply', 'denisReply'], ['voice-auto', 'voiceAutoExecute']]) {
  $(id).addEventListener('change', () => { if (voice) void voice.setSettings({ [key]: $(id).checked }); });
}
resetScenario();
if (window.lab) {
  if (typeof window.lab.onVoiceEvent === 'function') {
    voice = new VoiceClient(window.lab, { onState: renderVoiceState, onEvent: event => { void handleVoiceEvent(event).catch(voiceError); }, onError: voiceError });
    void voice.initialize();
    window.addEventListener('beforeunload', () => { void voice?.dispose(); }, { once: true });
  } else {
    $('voice-status').textContent = 'Голосовой ввод недоступен в этой версии. Перезапустите обновлённое приложение.';
  }
  sync();
  const unsubscribe = window.lab.onProgress((event) => {
    if (!pending || reportReceived) return;
    const eventRunId = typeof event?.runId === 'string' ? event.runId : null;
    if (eventRunId && (eventRunId === lastFinishedRunId || (currentRunId && eventRunId !== currentRunId))) return;
    if (eventRunId) currentRunId = eventRunId;
    addDecision(event);
    if (!stopping && event?.message) $('activity').textContent = friendly(event.message);
  });
  window.addEventListener('beforeunload', unsubscribe, { once: true });
  void refresh();
} else {
  error('Связь с управлением Windows недоступна. Откройте Jeff через ярлык приложения.');
  for (const id of ['start', 'run', 'stop', 'refresh', 'history', 'open-logs']) $(id).disabled = true;
}
