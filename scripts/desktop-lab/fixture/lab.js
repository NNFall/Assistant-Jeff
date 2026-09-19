'use strict';

const $ = (id) => document.getElementById(id);
const presets = {
  custom: { command: '' },
  tabs: { command: 'Открой первую вкладку ВКонтакте в тестовом окне.' },
  music_on: { command: 'Включи воспроизведение музыки в тестовом окне.' },
  music_off: { command: 'Выключи воспроизведение музыки в тестовом окне.' },
  language: { command: 'Переключи тестовый язык на английский.' },
};
const messages = {
  TARGET_MINIMIZED: 'Песочница свёрнута. Нажмите «Открыть тестовое окно» или «Выполнить», чтобы восстановить её.',
  TARGET_WINDOW_MINIMIZED: 'Песочница свёрнута. Нажмите «Открыть тестовое окно» или «Выполнить», чтобы восстановить её.',
  TARGET_SURFACE_MISSING: 'Контролы песочницы сейчас недоступны. Откройте тестовое окно заново кнопкой выше.',
  TARGET_NOT_RUNNING: 'Песочница закрыта. Кнопка «Выполнить» автоматически откроет её.',
  START_TEST_WINDOW_FIRST: 'Песочница ещё не открыта. Введите команду и нажмите «Выполнить».',
  no_action: 'Недостаточная уверенность модели', goal_verified: 'Цель подтверждена наблюдением Windows',
  aborted: 'Выполнение остановлено',
  action_low_confidence: 'Jev выбрал действие с уверенностью ниже порога 0,80.',
  goal_low_confidence: 'Jev недостаточно уверен в смысле команды. Попробуйте сформулировать её проще.',
  no_request: 'Это объяснение, цитата или запрет; выполнять действие не требуется.',
  unsupported: 'Команда выходит за возможности тестового окна или содержит неподдерживаемые шаги.',
  interrupted: 'Запуск был прерван закрытием приложения. Записанные шаги сохранены.',
  time_limit: 'Достигнут лимит времени задачи.',
  LOG_WRITE_FAILED: 'Не удалось сохранить журнал. Выполнение остановлено.',
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
function isNotStarted(input) {
  return input?.code === 'START_TEST_WINDOW_FIRST'
    || /(?:^|\W)START_TEST_WINDOW_FIRST(?:$|\W)/.test(String(input?.message ?? input ?? ''));
}
function sync() {
  const busy = pending || opening || remoteRunning;
  $('run').disabled = busy || !$('command').value.trim();
  $('start').disabled = busy;
  $('scenario').disabled = busy;
  $('command').disabled = busy;
  $('refresh').disabled = opening || refreshing;
  $('stop').disabled = !(pending || remoteRunning) || stopping;
  $('stop').textContent = stopping ? 'Останавливаем…' : 'Стоп';
  $('status').textContent = stopping ? 'Остановка' : pending || remoteRunning ? 'Выполняется' : opening ? 'Открытие окна' : 'Готов к проверке';
}
function resetScenario() {
  const preset = presets[$('scenario').value];
  $('command').value = preset.command;
  $('goal').textContent = 'План и проверяемая цель будут определены по вашей команде. Неподдерживаемый запрос завершится без действия.';
  updateCounter();
}
function updateCounter() { $('counter').textContent = `${$('command').value.length} / 1024`; sync(); }

function renderState(state) {
  remoteRunning = state?.running === true;
  if (state?.error && !isNotStarted(state.error)) error(friendly(state.error));
  else if (isNotStarted(state?.error)) error();
  // A failed observation may contain a cached snapshot; never present it as fresh.
  const snapshot = state?.error ? null : state?.snapshot;
  if (snapshot) {
    const version = value(snapshot.version);
    $('snapshot-version').textContent = `Снимок ${version.slice(0, 10)}`;
    $('snapshot-version').title = version;
    $('summary').textContent = [snapshot.app, snapshot.summary].filter(Boolean).map(value).join(' · ') || 'Наблюдение получено';
    $('elements').replaceChildren();
    const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
    for (const element of elements) {
      const row = document.createElement('li');
      const title = document.createElement('div'); title.className = 'element-title';
      title.textContent = value(element.name ?? element.label ?? element.title ?? element.id ?? element);
      const detail = document.createElement('div'); detail.className = 'element-detail';
      detail.textContent = Object.entries(element && typeof element === 'object' ? element : {})
        .filter(([key]) => !['name', 'label', 'title'].includes(key))
        .map(([key, val]) => `${key}: ${value(val)}`).join(' · ');
      row.append(title, detail); $('elements').append(row);
    }
    if (!elements.length) { const row = document.createElement('li'); row.textContent = 'Наблюдаемых элементов нет.'; $('elements').append(row); }
    $('facts').textContent = pretty({ facts: snapshot.facts, metadata: snapshot.metadata });
  } else {
    $('snapshot-version').textContent = 'Нет снимка';
    $('snapshot-version').title = '';
    $('summary').textContent = state?.error ? friendly(state.error) : 'Свежего наблюдения нет. Песочница откроется при выполнении команды.';
    $('elements').replaceChildren(); $('facts').textContent = 'Нет данных';
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
  $('decisions').append(row); row.scrollIntoView({ block: 'nearest' });
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
      if (isNotStarted(err)) {
        error();
        renderState({ running: false });
        $('activity').textContent = messages.START_TEST_WINDOW_FIRST;
      } else {
        renderState({ running: remoteRunning, error: err?.message || err?.code || 'Не удалось получить наблюдение.' });
      }
    }
    finally { refreshing = false; sync(); }
  })();
  try { await refreshPromise; } finally { refreshPromise = null; }
}
$('scenario').addEventListener('change', resetScenario);
$('command').addEventListener('input', () => { $('scenario').value = 'custom'; updateCounter(); });
$('refresh').addEventListener('click', () => { error(); void refresh(); });
$('start').addEventListener('click', async () => {
  if (pending || opening || remoteRunning) return;
  opening = true; error(); $('activity').textContent = 'Открываем отдельное тестовое окно…'; sync();
  try {
    const state = await window.lab.start(); renderState(state);
    $('activity').textContent = state?.error ? 'Открытие не подтверждено.' : state?.snapshot ? 'Наблюдение тестового окна получено.' : 'Запуск запрошен. Обновите наблюдение для проверки.';
  } catch (err) { renderState({ running: remoteRunning, error: err?.message || 'Не удалось открыть тестовое окно.' }); }
  finally { opening = false; sync(); }
});
$('run').addEventListener('click', async () => {
  if (pending || opening || remoteRunning) return;
  const command = $('command').value.trim();
  if (!command || command.length > 1024) return error('Введите команду до 1024 символов.');
  pending = true; stopping = false; error(); progressCount = 0; progressEvents = []; $('decisions').replaceChildren();
  reportReceived = false; currentRunId = null;
  $('plan').textContent = 'Ожидаем план'; $('goal-status').textContent = 'Определяем проверяемую цель…'; $('run-meta').textContent = '';
  $('verification').textContent = 'Проверка выполняется…'; $('verification').className = 'verification';
  $('trace').textContent = 'Ожидаем отчёт'; $('result-meta').textContent = ''; $('activity').textContent = 'Получаем наблюдение и решение модели…'; sync();
  try {
    const report = await window.lab.run({ command });
    // IPC progress can arrive after invoke resolves while the final UIA refresh is pending.
    reportReceived = true;
    lastFinishedRunId = report?.runId ?? currentRunId ?? lastFinishedRunId;
    const verified = report?.ok === true && report?.reason === 'goal_verified';
    $('verification').className = `verification ${verified ? 'success' : 'failed'}`;
    const reason = friendly(report?.reason);
    $('verification').textContent = `${verified ? 'Результат подтверждён' : 'Результат не подтверждён'}${report?.reason ? ': ' + reason : '.'}`;
    const completedCount = Array.isArray(report?.completed) ? report.completed.length : 0;
    const callsCount = Array.isArray(report?.calls) ? report.calls.length : 0;
    $('result-meta').textContent = `Выполнено действий: ${completedCount} · общее время: ${value(report?.elapsedMs)} мс · вызовов модели: ${callsCount}`;
    $('plan').textContent = report?.plan ? pretty(report.plan) : 'План не получен.';
    $('goal-status').textContent = `Цель: ${value(report?.goal)} · ${verified ? 'подтверждена' : 'не подтверждена'}`;
    $('run-meta').textContent = `Сессия: ${value(report?.runId)} · Журнал: ${value(report?.logPath)}`;
    $('trace').textContent = pretty(report);
    if (!progressCount && Array.isArray(report?.events ?? report?.trace)) (report.events ?? report.trace).forEach(addDecision);
    $('trace').textContent = pretty(report);
    $('activity').textContent = stopping ? 'Запрос завершён после команды остановки. См. фактический результат проверки.' : 'Выполнение завершено. Результат и журнал — ниже.';
  } catch (err) {
    reportReceived = true;
    lastFinishedRunId = currentRunId ?? lastFinishedRunId;
    $('trace').textContent = pretty({ status: 'failed', runId: currentRunId, error: friendly(err), events: progressEvents });
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
  if (stopping || !(pending || remoteRunning)) return;
  stopping = true; sync(); $('activity').textContent = 'Остановка запрошена. Ждём завершения текущей операции…';
  try {
    const result = await window.lab.stop();
    if (result?.stopped !== true) error('Подтверждение остановки не получено.');
    if (!pending) { stopping = false; await refresh(); }
  } catch (err) { stopping = false; error(friendly(err, 'Не удалось запросить остановку.')); }
  finally { sync(); }
});
async function loadHistory() {
  if (historyLoading) return;
  historyLoading = true; $('history').disabled = true;
  $('history-status').textContent = 'Читаем журнал…';
  try {
    const result = await window.lab.history();
    const runs = (Array.isArray(result) ? result : result?.runs ?? []).slice(0, 20);
    $('history-list').replaceChildren();
    for (const run of runs) {
      const item = document.createElement('li'); const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${value(run.createdAt)} · ${value(run.command)} · ${friendly(run.reason, 'Без результата')} · ${value(run.elapsedMs)} мс`;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const report = await window.lab.readRun({ runId: run.runId });
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
  try { const result = await window.lab.openLogs(); if (result?.error) throw new Error(result.error); }
  catch (err) { $('history-status').textContent = friendly(err, 'Не удалось открыть папку журналов.'); }
});
resetScenario();
if (window.lab) {
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
  error('IPC стенда недоступен. Откройте Jeff Windows Lab через отдельный Electron entrypoint.');
  for (const id of ['start', 'run', 'stop', 'refresh', 'history', 'open-logs']) $(id).disabled = true;
}
