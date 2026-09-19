'use strict';

const $ = (id) => document.getElementById(id);
const presets = {
  tabs: { command: 'Открой первую вкладку ВКонтакте в тестовом окне.', goal: 'Первая вкладка ВК среди четырёх вкладок тестового окна должна стать активной.' },
  music: { command: 'Включи воспроизведение музыки в тестовом окне.', goal: 'Воспроизведение в тестовом окне включено; звук не проигрывается.' },
};
let pending = false;
let opening = false;
let refreshing = false;
let refreshPromise = null;
let stopping = false;
let remoteRunning = false;
let progressCount = 0;

function value(input) {
  if (input === undefined || input === null) return '—';
  return typeof input === 'object' ? JSON.stringify(input) : String(input);
}
function pretty(input) { return JSON.stringify(input ?? null, null, 2); }
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
  $('goal').textContent = preset.goal;
  updateCounter();
}
function updateCounter() { $('counter').textContent = `${$('command').value.length} / 1024`; sync(); }

function renderState(state) {
  remoteRunning = state?.running === true;
  if (state?.error && !isNotStarted(state.error)) error(value(state.error));
  else if (isNotStarted(state?.error)) error();
  const snapshot = state?.snapshot;
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
    $('summary').textContent = 'Свежего наблюдения нет. Откройте тестовое окно или обновите наблюдение.';
    $('elements').replaceChildren(); $('facts').textContent = 'Нет данных';
  }
  sync();
}
function metric(number) { return typeof number === 'number' && Number.isFinite(number) ? number.toFixed(3) : '—'; }
function addDecision(event) {
  if (progressCount === 0) $('decisions').replaceChildren();
  progressCount++;
  const row = document.createElement('div'); row.className = 'decision';
  const text = document.createElement('p');
  text.textContent = [event?.phase, event?.message].filter(Boolean).map(value).join(' · ') || 'Обновление выполнения';
  const meta = document.createElement('small');
  const metrics = [];
  if (event?.choice !== undefined) metrics.push(`Решение: ${value(event.choice)}`);
  if (Number.isFinite(event?.probability)) metrics.push(`P: ${metric(event.probability)}`);
  if (Number.isFinite(event?.confidence)) metrics.push(`confidence: ${metric(event.confidence)}`);
  if (Number.isFinite(event?.latencyMs)) metrics.push(`время: ${event.latencyMs} мс`);
  meta.textContent = metrics.join(' · ');
  row.append(text); if (metrics.length) row.append(meta);
  $('decisions').append(row); row.scrollIntoView({ block: 'nearest' });
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
        $('activity').textContent = 'Откройте тестовое окно, затем выполните одну из двух проверяемых команд.';
      } else error(err?.message || 'Не удалось получить наблюдение.');
    }
    finally { refreshing = false; sync(); }
  })();
  try { await refreshPromise; } finally { refreshPromise = null; }
}
$('scenario').addEventListener('change', resetScenario);
$('command').addEventListener('input', updateCounter);
$('refresh').addEventListener('click', () => { error(); void refresh(); });
$('start').addEventListener('click', async () => {
  if (pending || opening || remoteRunning) return;
  opening = true; error(); $('activity').textContent = 'Открываем отдельное тестовое окно…'; sync();
  try {
    const state = await window.lab.start(); renderState(state);
    $('activity').textContent = state?.error ? 'Открытие не подтверждено.' : state?.snapshot ? 'Наблюдение тестового окна получено.' : 'Запуск запрошен. Обновите наблюдение для проверки.';
  } catch (err) { error(err?.message || 'Не удалось открыть тестовое окно.'); }
  finally { opening = false; sync(); }
});
$('run').addEventListener('click', async () => {
  if (pending || opening || remoteRunning) return;
  const command = $('command').value.trim();
  if (!command || command.length > 1024) return error('Введите команду до 1024 символов.');
  pending = true; stopping = false; error(); progressCount = 0; $('decisions').replaceChildren();
  $('verification').textContent = 'Проверка выполняется…'; $('verification').className = 'verification';
  $('trace').textContent = 'Ожидаем отчёт'; $('result-meta').textContent = ''; $('activity').textContent = 'Получаем наблюдение и решение модели…'; sync();
  try {
    const report = await window.lab.run({ scenario: $('scenario').value, command });
    const verified = report?.ok === true && report?.reason === 'goal_verified';
    $('verification').className = `verification ${verified ? 'success' : 'failed'}`;
    const reasons = { no_action: 'Недостаточная уверенность модели', goal_verified: 'Условие сценария подтверждено' };
    const reason = reasons[report?.reason] ?? value(report?.reason);
    $('verification').textContent = `${verified ? 'Результат подтверждён' : 'Результат не подтверждён'}${report?.reason ? ': ' + reason : '.'}`;
    const completedCount = Array.isArray(report?.completed) ? report.completed.length : 0;
    const callsCount = Array.isArray(report?.calls) ? report.calls.length : 0;
    $('result-meta').textContent = `Выполнено действий: ${completedCount} · общее время: ${value(report?.elapsedMs)} мс · вызовов модели: ${callsCount}`;
    $('trace').textContent = pretty(report);
    if (!progressCount && Array.isArray(report?.trace)) report.trace.forEach(addDecision);
    $('activity').textContent = stopping ? 'Запрос завершён после команды остановки. См. фактический результат проверки.' : 'Выполнение завершено. Результат указан выше.';
  } catch (err) {
    error(err?.message || 'Ошибка выполнения.');
    $('verification').textContent = 'Результат не подтверждён: отчёт не получен.';
    $('verification').className = 'verification failed'; $('activity').textContent = 'Выполнение завершилось без отчёта.';
  } finally {
    // Stop acknowledgement alone never unlocks a still-pending run.
    await refresh(); pending = false; stopping = false; sync();
  }
});
$('stop').addEventListener('click', async () => {
  if (stopping || !(pending || remoteRunning)) return;
  stopping = true; sync(); $('activity').textContent = 'Остановка запрошена. Ждём завершения текущей операции…';
  try {
    const result = await window.lab.stop();
    if (result?.stopped !== true) error('Подтверждение остановки не получено.');
    if (!pending) { stopping = false; await refresh(); }
  } catch (err) { stopping = false; error(err?.message || 'Не удалось запросить остановку.'); }
  finally { sync(); }
});
resetScenario();
if (window.lab) {
  const unsubscribe = window.lab.onProgress((event) => {
    addDecision(event);
    if (!stopping && event?.message) $('activity').textContent = value(event.message);
  });
  window.addEventListener('beforeunload', unsubscribe, { once: true });
  void refresh();
} else {
  error('IPC стенда недоступен. Откройте Jeff Windows Lab через отдельный Electron entrypoint.');
  for (const id of ['start', 'run', 'stop', 'refresh']) $(id).disabled = true;
}
