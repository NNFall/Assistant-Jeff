/**
 * Pure, bounded projections for the human-readable run details view.
 *
 * This module deliberately knows nothing about Electron, Windows, the DOM or
 * provider credentials.  The renderer can use the returned strings with
 * textContent.  Internal ids remain available only as non-primary metadata so
 * a log with hashed candidate ids still reads like a useful explanation.
 */

const MAX_CALLS = 24;
const MAX_STEPS = 24;
const MAX_ALTERNATIVES = 16;
const MAX_WINDOWS = 32;
const MAX_CONTROLS = 96;
const MAX_CAPABILITIES = 64;
const MAX_RESPONSES = 16;
const MAX_TREE_NODES = 96;
const MAX_TREE_DEPTH = 5;
const MAX_TEXT = 1800;

const QUESTION_TITLES = Object.freeze({
  next_action: 'Следующее действие',
  request_kind: 'Тип запроса',
  requested_fields: 'Запрошенные поля',
  desired_tab: 'Целевая вкладка',
  desired_playing: 'Воспроизведение',
  desired_language: 'Язык интерфейса',
  goal_status: 'Состояние цели',
  route: 'Маршрут команды',
  app: 'Приложение',
});

const CHOICE_LABELS = Object.freeze({
  achieved: 'Цель достигнута',
  not_achieved: 'Цель ещё не достигнута',
  unknown: 'Состояние неизвестно',
  execute: 'Выполнить',
  reset: 'Сбросить',
  no_action: 'Не выполнять действие',
  unsupported: 'Действие недоступно',
  done: 'Завершить: цель достигнута по наблюдению',
  no_request: 'Нет подтверждённого запроса на действие',
  keep: 'Оставить как есть',
  on: 'Включить',
  off: 'Выключить',
  note: 'Сохранить заметку',
  reminder: 'Поставить напоминание',
  open_app: 'Открыть приложение',
  chat: 'Ответить текстом',
  desktop: 'Управление окном или элементом',
  system_volume: 'Изменить громкость',
  self_minimize: 'Свернуть Jeff',
});

const OPERATION_LABELS = Object.freeze({
  activate: 'Показать окно',
  click: 'Нажать элемент',
  close: 'Закрыть окно',
  collapse: 'Свернуть список',
  expand: 'Раскрыть список',
  inspect: 'Проверить окно',
  invoke: 'Нажать кнопку',
  launch: 'Открыть приложение',
  maximize: 'Развернуть окно',
  minimize: 'Свернуть окно',
  press_key: 'Нажать клавишу',
  replace_text: 'Заменить текст',
  restore: 'Восстановить окно',
  select: 'Выбрать элемент',
  set_keyboard_language: 'Сменить раскладку',
  toggle: 'Переключить настройку',
  note: 'Сохранить заметку',
  reminder: 'Создать напоминание',
  chat: 'Подготовить текстовый ответ',
});

const TOOL_LABELS = Object.freeze({
  notes_search: 'Ищу заметки',
  note_get: 'Открываю заметку',
  note_create: 'Сохраняю заметку',
  note_update: 'Обновляю заметку',
  note_delete: 'Удаляю заметку',
  reminders_search: 'Ищу напоминания',
  reminder_get: 'Открываю напоминание',
  reminder_create: 'Создаю напоминание',
  reminder_update: 'Обновляю напоминание',
  reminder_delete: 'Удаляю напоминание',
  reminder_complete: 'Завершаю напоминание',
  clock_now: 'Уточняю текущее время',
  time_resolve: 'Рассчитываю срок',
  system_volume_set: 'Меняю громкость',
  system_volume_get: 'Проверяю громкость',
  assistant_minimize: 'Сворачиваю Jeff',
  assistant_respond: 'Ответ пользователю',
  windows_observe: 'Проверяю окна Windows',
  windows_execute: 'Выполняю действие в окне',
  winapp_observe: 'Проверяю окна Windows',
  winapp_execute: 'Выполняю действие в окне',
  windows_text_fields: 'Ищу текстовые поля',
  windows_text_replace: 'Заменяю текст в поле',
  windows_apps_search: 'Ищу установленное приложение',
  windows_app_launch: 'Открываю приложение',
  winapp_search: 'Ищу установленное приложение',
  winapp_launch: 'Открываю приложение',
  windows_choose: 'Выбираю действие по наблюдению',
});

const STATUS_LABELS = Object.freeze({
  verified: 'Подтверждено',
  executed: 'Выполнено',
  failed: 'Не выполнено',
  pending_verification: 'Действие отправлено, проверяю результат',
  pending: 'Результат не указан',
});

const STATUS_VALUE_LABELS = Object.freeze({
  answer: 'ответ',
  completed: 'завершено',
  clarification: 'уточнение',
  incomplete: 'не завершено',
});

const ARGUMENT_LABELS = Object.freeze({
  app: 'приложение',
  appName: 'приложение',
  query: 'поиск',
  limit: 'лимит',
  offset: 'смещение',
  text: 'текст',
  expectedText: 'исходный текст для проверки',
  expectedDueAt: 'исходный срок для проверки',
  dueAt: 'срок',
  percent: 'громкость',
  goal: 'цель',
  operation: 'действие',
  language: 'язык',
  page: 'страница',
  status: 'тип ответа',
});

const CAPABILITY_TITLES = Object.freeze({
  notes_search: 'Поиск заметок',
  note_get: 'Прочитать заметку',
  note_create: 'Создать заметку',
  note_update: 'Изменить заметку',
  note_delete: 'Удалить заметку',
  reminders_search: 'Поиск напоминаний',
  reminder_get: 'Прочитать напоминание',
  reminder_create: 'Создать напоминание',
  reminder_update: 'Изменить напоминание',
  reminder_delete: 'Удалить напоминание',
  reminder_complete: 'Завершить напоминание',
  clock_now: 'Текущее время',
  time_resolve: 'Рассчитать срок',
  windows_observe: 'Посмотреть окна',
  windows_execute: 'Выполнить действие в окне',
  windows_choose: 'Выбрать действие по наблюдению',
  winapp_observe: 'Посмотреть окна',
  winapp_execute: 'Выполнить действие в окне',
  windows_apps_search: 'Найти установленное приложение',
  winapp_search: 'Найти установленное приложение',
  windows_app_launch: 'Запустить приложение',
  winapp_launch: 'Запустить приложение',
  windows_text_fields: 'Найти текстовые поля',
  windows_text_replace: 'Заменить текст в поле',
  system_volume_get: 'Узнать громкость',
  system_volume_set: 'Установить громкость',
  assistant_minimize: 'Свернуть Jeff',
  assistant_respond: 'Ответ пользователю',
});

const CAPABILITY_DESCRIPTIONS = Object.freeze({
  notes_search: 'Ищет заметки по фрагменту текста.',
  note_get: 'Читает выбранную заметку перед изменением.',
  note_create: 'Создаёт заметку и проверяет её повторным чтением.',
  note_update: 'Изменяет заметку после чтения и проверки исходного текста.',
  note_delete: 'Удаляет заметку после чтения и проверки её содержимого.',
  reminders_search: 'Ищет напоминания по тексту и состоянию.',
  reminder_get: 'Читает выбранное напоминание перед изменением.',
  reminder_create: 'Создаёт напоминание с указанным сроком и проверяет запись.',
  reminder_update: 'Изменяет напоминание после чтения и проверки исходных данных.',
  reminder_delete: 'Удаляет напоминание после чтения и проверки исходных данных.',
  reminder_complete: 'Отмечает напоминание выполненным после проверки записи.',
  clock_now: 'Показывает текущее местное и универсальное время.',
  time_resolve: 'Рассчитывает срок только из явно указанных компонентов.',
  windows_observe: 'Показывает доступные окна, элементы и разрешённые действия.',
  windows_execute: 'Выполняет выбранное действие в свежем наблюдении окна.',
  windows_choose: 'Помогает выбрать одно действие по текущему наблюдению.',
  winapp_observe: 'Показывает доступные окна, элементы и разрешённые действия.',
  winapp_execute: 'Выполняет выбранное действие в свежем наблюдении окна.',
  windows_apps_search: 'Ищет приложения в локальном каталоге.',
  winapp_search: 'Ищет приложения в локальном каталоге.',
  windows_app_launch: 'Запускает выбранное приложение и проверяет его окно.',
  winapp_launch: 'Запускает выбранное приложение и проверяет его окно.',
  windows_text_fields: 'Показывает доступные текстовые поля текущего окна.',
  windows_text_replace: 'Заменяет текст в уже выбранном доступном поле.',
  system_volume_get: 'Показывает громкость и состояние выключения звука.',
  system_volume_set: 'Устанавливает громкость и проверяет новое значение.',
  assistant_minimize: 'Сворачивает окно Assistant Jeff по просьбе пользователя.',
  assistant_respond: 'Передаёт пользователю проверенный ответ или уточнение.',
});

const EVIDENCE_LABELS = Object.freeze({
  target_not_read: 'Сначала прочитайте запись в текущем разговоре.',
  note_read: 'Запись прочитана перед изменением.',
  note_updated: 'Запись изменена и проверена.',
  note_created: 'Запись создана и проверена.',
  note_deleted: 'Запись удалена и проверена.',
  reminder_read: 'Напоминание прочитано перед изменением.',
  reminder_created: 'Напоминание создано и проверено.',
  reminder_updated: 'Напоминание изменено и проверено.',
  reminder_deleted: 'Напоминание удалено и проверено.',
  reminder_completed: 'Напоминание отмечено выполненным и проверено.',
  text_set_unverified: 'Текст передан приложению, но новое значение ещё не подтверждено.',
  window_started: 'Окно появилось после запуска.',
  process_started: 'Приложение запущено; окно ещё проверяется.',
  window_minimized: 'Окно наблюдается свёрнутым.',
  state_changed: 'Изменение наблюдалось после действия.',
  foreground_not_granted: 'Окно не удалось вывести на передний план.',
  window_missing: 'Нужное окно не найдено.',
  stale_snapshot: 'Наблюдение устарело; требуется новое чтение.',
});

/** Static labels only. Availability must come from a report or api.capabilities(). */
export const SUPPORTED_FAMILIES = Object.freeze([
  Object.freeze({ name: 'windows', title: 'Окна и элементы Windows', description: 'Наблюдение доступных окон и разрешённых элементов интерфейса.' }),
  Object.freeze({ name: 'local', title: 'Заметки и напоминания', description: 'Локальные заметки и напоминания Assistant Jeff.' }),
  Object.freeze({ name: 'chat', title: 'Текстовые ответы', description: 'Ответы на вопросы без изменения состояния компьютера.' }),
]);

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function array(value) { return Array.isArray(value) ? value : []; }
function string(value, maximum = MAX_TEXT) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const clean = value.trim();
  return clean.length <= maximum ? clean : `${clean.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function unit(value) { const n = number(value); return n !== null && n >= 0 && n <= 1 ? n : null; }
function boundedArray(value, maximum) { return array(value).slice(0, maximum); }
function hasCyrillic(value) { return typeof value === 'string' && /[А-Яа-яЁё]/u.test(value); }
function titleCaseChoice(choice) {
  if (typeof choice !== 'string' || !choice.trim()) return 'Вариант из запроса';
  return CHOICE_LABELS[choice] ?? 'Вариант из запроса';
}
function operationLabel(operation) { return OPERATION_LABELS[operation] ?? 'Выполнить действие'; }
function toolLabel(name, title) {
  return TOOL_LABELS[name] || (hasCyrillic(title) ? string(title, 220) : '') || 'Выполнить операцию';
}
function capabilityTitle(name, title) {
  return CAPABILITY_TITLES[name] || (hasCyrillic(title) ? string(title, 220) : '') || 'Возможность Assistant Jeff';
}
function capabilityDescription(name, description) {
  if (CAPABILITY_DESCRIPTIONS[name]) return CAPABILITY_DESCRIPTIONS[name];
  const value = string(description, 700);
  if (!value) return 'Операция доступна в Assistant Jeff.';
  if (!hasCyrillic(value)) return 'Операция доступна в Assistant Jeff.';
  return value
    .replaceAll(/\b(?:expectedText|expectedDueAt|windowId|actionId|snapshotVersion|appId|evidenceIds)\b/giu, 'технические данные')
    .replaceAll(/\b(?:Read|Execute|Launch|Optional|Only|Never|There|The|This)\b/gu, '');
}
function stripOperationPrefix(value) {
  const source = string(value);
  return source.replace(/^(?:activate|click|close|collapse|expand|inspect|invoke|launch|maximize|minimize|press_key|replace_text|restore|select|set_keyboard_language|toggle)\s*:\s*/iu, '').trim();
}
function candidateMaps(report) {
  const byId = new Map();
  for (const call of boundedArray(report?.calls, MAX_CALLS)) {
    for (const candidate of boundedArray(call?.request?.state?.candidates, MAX_CONTROLS)) {
      if (!candidate || typeof candidate.id !== 'string' || byId.has(candidate.id)) continue;
      const label = string(candidate.label);
      if (label) byId.set(candidate.id, { id: candidate.id, label, operation: candidate.operation });
    }
  }
  for (const event of boundedArray(report?.trace ?? report?.events, MAX_STEPS * 8)) {
    const candidate = object(event?.candidate);
    if (typeof candidate.id !== 'string' || byId.has(candidate.id)) continue;
    const label = string(candidate.label);
    if (label) byId.set(candidate.id, { id: candidate.id, label, operation: candidate.operation });
  }
  return byId;
}

function criteriaFor(request, questionKey) {
  const question = object(request?.questions?.[questionKey]);
  return object(question.criteria);
}

/** Resolve a model option to a readable label without making the id primary. */
export function humanChoice(choice, { request, questionKey = 'next_action', candidates } = {}) {
  const id = typeof choice === 'string' ? choice : '';
  const candidate = candidates?.get?.(id) ?? boundedArray(request?.state?.candidates, MAX_CONTROLS).find(item => item?.id === id);
  if (candidate?.label) return string(candidate.label);
  const criterion = criteriaFor(request, questionKey)[id];
  if (criterion) return stripOperationPrefix(criterion);
  return titleCaseChoice(id);
}

function answerForCall(call, questionKey) {
  const direct = object(call?.decision?.decisions?.[questionKey]);
  if (Object.keys(direct).length) return direct;
  if (questionKey === 'next_action' && call?.decision && (call.decision.choice !== undefined || call.decision.actionId !== undefined)) return call.decision;
  const response = object(call?.response?.answers?.[questionKey]);
  if (Object.keys(response).length) return response;
  return {};
}

function callQuestionEntries(call) {
  const requestQuestions = object(call?.request?.questions);
  const keys = Object.keys(requestQuestions);
  if (!keys.length && call?.decision && (call.decision.choice !== undefined || call.decision.actionId !== undefined)) return ['next_action'];
  return keys;
}

function alternatives(answer, request, questionKey, candidates) {
  const probabilities = object(answer?.probabilities);
  return Object.entries(probabilities)
    .map(([choice, value]) => ({
      choice,
      label: humanChoice(choice, { request, questionKey, candidates }),
      probability: unit(value),
    }))
    .filter(item => item.probability !== null)
    .sort((a, b) => (b.probability - a.probability) || a.label.localeCompare(b.label, 'ru'))
    .slice(0, MAX_ALTERNATIVES);
}

function requestData(request) {
  const state = object(request?.state);
  const fields = [];
  if (string(state.command, 1024)) fields.push({ label: 'Текст команды', value: string(state.command, 1024) });
  if (state.observation && typeof state.observation === 'object') {
    const observation = object(state.observation);
    const value = [string(observation.app, 120), string(observation.summary, 900)].filter(Boolean).join('. ');
    fields.push({ label: 'Наблюдение интерфейса', value: value || 'Описание наблюдения передано без подробностей.' });
  }
  if (Array.isArray(state.candidates)) fields.push({ label: 'Доступные варианты', value: `${state.candidates.length} наблюдаемых вариантов действия.` });
  if (Array.isArray(state.completed)) fields.push({ label: 'Предыдущие шаги', value: state.completed.length ? `${state.completed.length} ранее записанных шагов.` : 'Ранее выполненных шагов нет.' });
  if (state.currentFacts && typeof state.currentFacts === 'object') fields.push({ label: 'Текущие факты', value: 'Текущие факты тестового окна.' });
  if (state.supportedWorld && typeof state.supportedWorld === 'object') fields.push({ label: 'Допустимый сценарий', value: 'Описание разрешённого мира задачи.' });
  if (!fields.length) fields.push({ label: 'Данные запроса', value: 'В отчёте нет перечисления отправленных полей.' });
  return fields.slice(0, 12);
}

function stepTitle(call, questionKey) {
  if (questionKey === 'next_action') return 'Выбор следующего действия';
  if (call?.kind === 'goal' || questionKey.startsWith('desired_') || questionKey === 'request_kind') return QUESTION_TITLES[questionKey] ?? `Проверка: ${questionKey}`;
  return QUESTION_TITLES[questionKey] ?? `Решение: ${questionKey.replaceAll('_', ' ')}`;
}

/** Human-readable model decisions, including distinct probability/confidence fields. */
export function formatDecisionLog(report = {}) {
  const candidates = candidateMaps(report);
  const steps = [];
  for (const [callIndex, call] of boundedArray(report?.calls, MAX_CALLS).entries()) {
    const request = object(call?.request);
    for (const questionKey of callQuestionEntries(call)) {
      const answer = answerForCall(call, questionKey);
      const choice = answer.choice ?? answer.actionId ?? '';
      const selectedAction = humanChoice(choice, { request, questionKey, candidates });
      const criterion = string(criteriaFor(request, questionKey)[choice], 1600);
      const probability = unit(answer.probability ?? object(answer.probabilities)[choice]);
      const confidence = unit(answer.confidence);
      steps.push({
        index: steps.length + 1,
        callIndex,
        kind: call?.kind === 'goal' ? 'goal' : 'action',
        title: stepTitle(call, questionKey),
        question: questionKey,
        selectedAction,
        criterion,
        probability,
        confidence,
        alternatives: alternatives(answer, request, questionKey, candidates),
        dataSent: requestData(request),
        // Internal id is deliberately secondary metadata for diagnostics only.
        internalChoice: typeof choice === 'string' && choice ? choice : null,
      });
      if (steps.length >= MAX_STEPS) return steps;
    }
  }
  return steps;
}

function eventList(report) {
  const source = array(report?.trace).length ? report.trace : report?.events;
  return boundedArray(source, MAX_STEPS * 10).filter(item => item && typeof item === 'object');
}
function executionStatus({ ok, verified, outcome, stateChanged, failed, effectConfirmed, needsObservation }) {
  if (failed || ok === false || outcome === 'failed' || outcome === 'not_verified') return 'failed';
  if (verified === true || outcome === 'verified') return 'verified';
  if (effectConfirmed === true && needsObservation === true) return 'pending_verification';
  if (ok === true || stateChanged === true || outcome === 'observed_change' || outcome === 'executed' || outcome === 'local_saved' || outcome === 'success') return 'executed';
  return 'pending';
}
function executionLabel(candidate, id, operation, fallbackLabel = '') {
  if (candidate?.label) return string(candidate.label);
  if (TOOL_LABELS[operation]) return TOOL_LABELS[operation];
  if (OPERATION_LABELS[operation]) return OPERATION_LABELS[operation];
  if (hasCyrillic(fallbackLabel)) return string(fallbackLabel);
  if (operation) return operationLabel(operation);
  return id ? 'Инструмент выполнил шаг' : 'Шаг выполнения';
}
function identifierKey(key) {
  return /^(?:id|.*(?:_id|_ids|Id|Ids)|hash|digest|runId|toolCallId|snapshot(?:_?version)?|state(?:_?version)?)$/iu.test(key);
}
function sensitiveKey(key) {
  return /token|secret|password|authorization|api[_-]?key/iu.test(key);
}
function argumentLabel(key) {
  if (key === 'evidenceIds') return 'подтверждения';
  if (ARGUMENT_LABELS[key]) return ARGUMENT_LABELS[key];
  if (identifierKey(key)) return key.toLowerCase().includes('version') ? 'снимок' : 'объект';
  const readable = String(key).replaceAll(/([a-z])([A-Z])/gu, '$1 $2').replaceAll('_', ' ').trim();
  return readable ? 'данные: ' + readable : 'данные';
}
function argumentValue(key, value) {
  if (sensitiveKey(key)) return '[скрыто]';
  if (key === 'evidenceIds') return Array.isArray(value) ? String(value.length) + ' шт.' : 'есть';
  if (identifierKey(key)) return 'идентификатор скрыт';
  if (key === 'status' && typeof value === 'string') return STATUS_VALUE_LABELS[value] ?? 'сообщение';
  if (typeof value === 'string') return string(value, 180);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return String(value.length) + ' знач.';
  if (value && typeof value === 'object') return 'подробности скрыты в техническом JSON';
  return 'не указано';
}
function toolCallData(toolCall) {
  const args = object(toolCall?.arguments);
  const keys = Object.keys(args).slice(0, 12);
  const values = keys.map(key => argumentLabel(key) + ': ' + argumentValue(key, args[key]));
  const label = toolLabel(toolCall?.name, toolCall?.title);
  return values.length ? label + '. Переданные данные: ' + values.join('; ') + '.' : label + '. Дополнительные данные не указаны.';
}
function humanMessage(value) {
  const clean = string(value, 900);
  if (!clean || /^[a-z][a-z0-9_.-]*$/iu.test(clean)) return '';
  return clean;
}

/** Short, human-only live progress label for agent events. */
export function formatAgentProgress(event = {}) {
  const phase = event?.phase;
  if (phase === 'agent_request') return 'Продумываю следующий шаг';
  if (phase === 'agent_tool_call') {
    const call = object(event.toolCall);
    return toolLabel(call.name, event.title ?? call.title);
  }
  if (phase === 'agent_tool_result') {
    const result = object(event.result);
    const label = toolLabel(event.name, event.title);
    if (result.effectConfirmed === true && result.needsObservation === true) return 'Действие отправлено, проверяю результат';
    if (result.verified === true) return 'Подтверждено: ' + label;
    if (result.ok === false) return 'Исправляю следующий шаг: ' + label;
    if (result.ok === true) return 'Результат получен: ' + label;
    return 'Проверяю результат: ' + label;
  }
  if (phase === 'agent_error') return 'Не удалось получить ответ агента';
  if (phase === 'agent_finished') {
    if (event.reason === 'agent_completed' || event.reason === 'agent_answer') return 'Ответ готов';
    if (event.reason === 'clarification_required') return 'Нужно уточнение';
    return 'Завершаю проверку результата';
  }
  return '';
}

function humanEvidence(value) {
  if (Array.isArray(value)) return value.slice(0, 8).map(humanEvidence).filter(Boolean).join(' ');
  const direct = string(value, 900);
  if (!direct) return '';
  if (EVIDENCE_LABELS[direct]) return EVIDENCE_LABELS[direct];
  if (hasCyrillic(direct) && !/^[a-z][a-z0-9_-]*$/iu.test(direct)) return direct;
  if (/not[_-]?read/iu.test(direct)) return 'Сначала прочитайте запись в текущем разговоре.';
  if (/not[_-]?verified|unverified/iu.test(direct)) return 'Результат действия ещё не подтверждён.';
  if (/stale/iu.test(direct)) return 'Наблюдение устарело; требуется новое чтение.';
  if (/missing|not[_-]?found/iu.test(direct)) return 'Нужный объект не найден.';
  return 'Проверка результата зафиксирована.';
}
function evidenceText(value, evidenceIds) {
  const direct = humanEvidence(value);
  if (direct) return direct;
  const count = array(evidenceIds).length;
  return count ? 'Зафиксировано подтверждений: ' + count + '.' : '';
}

const DATA_KEY_LABELS = Object.freeze({
  snapshot: 'Снимок интерфейса',
  tree: 'Структура интерфейса',
  windows: 'Окна',
  elements: 'Элементы интерфейса',
  controls: 'Элементы интерфейса',
  textFields: 'Текстовые поля',
  fields: 'Поля',
  actions: 'Доступные действия',
  candidates: 'Доступные варианты',
  facts: 'Текущие факты',
  metadata: 'Сведения о наблюдении',
  data: 'Данные результата',
  errors: 'Пояснения',
  error: 'Причина',
  code: 'Суть результата',
  path: 'Поле',
  expected: 'Ожидалось',
  allowed: 'Допустимые варианты',
  effectAttempted: 'Действие отправлялось',
  effectConfirmed: 'Отправка подтверждена',
  needsObservation: 'Нужно новое чтение',
  deduplicated: 'Повторный вызов',
  text: 'Текст',
  title: 'Название',
  name: 'Название',
  label: 'Название',
  role: 'Тип элемента',
  app: 'Приложение',
  appName: 'Приложение',
  processName: 'Приложение',
  summary: 'Описание',
  message: 'Сообщение',
  value: 'Значение',
  status: 'Состояние',
  operation: 'Действие',
  active: 'На переднем плане',
  minimized: 'Свёрнуто',
  maximized: 'Развёрнуто',
  selected: 'Выбрано',
  enabled: 'Доступно',
  available: 'Доступно',
  createdAt: 'Создано',
  created_at: 'Создано',
});

function dataKeyHidden(key) {
  return identifierKey(key) || /^evidenceIds$/iu.test(key) || sensitiveKey(key);
}
function dataKeyLabel(key) {
  if (DATA_KEY_LABELS[key]) return DATA_KEY_LABELS[key];
  const readable = String(key).replaceAll(/([a-z])([A-Z])/gu, '$1 $2').replaceAll('_', ' ').trim();
  return readable ? 'Свойство: ' + readable : 'Свойство';
}
const CODE_LABELS = Object.freeze({
  invalid_arguments: 'Аргументы нужно исправить.',
  unknown_tool: 'Такая операция недоступна.',
  unavailable_tool: 'Операция сейчас недоступна.',
  execution_error: 'Во время операции произошла ошибка.',
  target_not_read: 'Сначала прочитайте запись в текущем разговоре.',
  needs_observation: 'После действия нужно новое чтение.',
  duplicate_effect: 'Повторное изменение в этом запуске не выполнялось.',
  stale_snapshot: 'Наблюдение устарело; требуется новое чтение.',
  aborted: 'Операция остановлена до выполнения.',
});
function dataScalar(key, value) {
  if (key === 'code' && typeof value === 'string') return CODE_LABELS[value] ?? 'Служебный результат операции.';
  if (key === 'evidenceIds') return Array.isArray(value) ? String(value.length) + ' шт.' : 'есть';
  if (key === 'status' && typeof value === 'string') return STATUS_VALUE_LABELS[value] ?? humanEvidence(value);
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return string(value, 360) || 'не указано';
}
function dataTreeNode(key, value, depth, state) {
  if (state.nodes >= MAX_TREE_NODES || depth > MAX_TREE_DEPTH || dataKeyHidden(key)) return null;
  state.nodes += 1;
  const label = dataKeyLabel(key);
  if (Array.isArray(value)) {
    const children = [];
    for (const [index, child] of value.slice(0, MAX_TREE_NODES).entries()) {
      const node = dataTreeNode('item_' + (index + 1), child, depth + 1, state);
      if (node) children.push(node);
      if (state.nodes >= MAX_TREE_NODES) break;
    }
    return { label, children, ...(children.length ? {} : { value: 'Нет данных' }) };
  }
  if (value && typeof value === 'object') {
    const children = [];
    for (const [childKey, child] of Object.entries(value).slice(0, MAX_TREE_NODES)) {
      const node = dataTreeNode(childKey, child, depth + 1, state);
      if (node) children.push(node);
      if (state.nodes >= MAX_TREE_NODES) break;
    }
    return children.length ? { label, children } : null;
  }
  return { label, value: dataScalar(key, value) };
}
/** Bounded, identifier-free projection for tool result snapshots and trees. */
export function formatDataTree(value, { label = 'Данные результата' } = {}) {
  if (!value || typeof value !== 'object') return [];
  const state = { nodes: 0 };
  const root = dataTreeNode('__root__', value, 0, state);
  if (!root) return [];
  root.label = label;
  return [root];
}
/** Execution evidence distinguishes a sent/executed action from independent verification. */
export function formatExecutionLog(report = {}) {
  const candidates = candidateMaps(report);
  const records = [];
  const byId = new Map();
  const byStep = new Map();
  const add = ({ id, label, operation, callId, toolCall, message, evidence, ok, verified, outcome, stateChanged, failed, data, effectConfirmed, needsObservation }) => {
    const key = id || callId || 'step-' + (records.length + 1);
    let record = byId.get(key);
    if (!record) {
      record = { index: records.length + 1, id: key, label: executionLabel(candidates.get(key), label ? key : null, operation, label), operation: operation ?? '', status: 'pending', message: '', evidence: '', tool: '', dataSent: '', dataTree: [] };
      if (label && (!record.label || record.label === 'Инструмент выполнил шаг' || record.label === 'Шаг выполнения')) record.label = string(label);
      records.push(record); byId.set(key, record);
    }
    if (toolCall) { record.tool = toolLabel(toolCall.name, toolCall.title); record.dataSent = toolCallData(toolCall); }
    if (message) record.message = humanMessage(message);
    if (evidence) record.evidence = evidenceText(evidence);
    if (data && typeof data === 'object') {
      const tree = formatDataTree(data);
      if (tree.length) record.dataTree = tree;
    }
    const next = executionStatus({ ok, verified, outcome, stateChanged, failed, effectConfirmed, needsObservation });
    if (next !== 'pending' || record.status === 'pending') record.status = next;
    return record;
  };
  for (const event of eventList(report)) {
    const phase = event.phase;
    if (phase === 'agent_tool_call') {
      const call = object(event.toolCall);
      const record = add({ id: string(call.id, 160) || null, callId: string(call.id, 160) || null, label: toolLabel(call.name, call.title ?? event.title), operation: call.name, toolCall: { ...call, title: event.title }, message: event.message ?? event.title });
      byId.set(string(call.id, 160), record);
      continue;
    }
    if (phase === 'agent_tool_result') {
      const result = object(event.result);
      add({ id: string(event.toolCallId, 160) || null, callId: string(event.toolCallId, 160) || null, label: toolLabel(event.name, event.title), operation: event.name, message: result.message ?? event.message ?? event.title, evidence: evidenceText(result.evidence, result.evidenceIds), ok: result.ok, verified: result.verified, failed: result.ok === false, data: result.data, effectConfirmed: result.effectConfirmed, needsObservation: result.needsObservation });
      continue;
    }
    if (phase === 'execute_request' || phase === 'native_execute_request' || phase === 'local_execute_request') {
      const candidate = object(event.candidate);
      const id = string(candidate.id, 160) || string(event.id, 160) || null;
      const record = add({ id, label: candidate.label, operation: candidate.operation ?? event.operation, message: event.message });
      if (Number.isSafeInteger(event.step)) byStep.set(event.step, record);
      continue;
    }
    if (phase === 'execute_result' || phase === 'native_execute_result' || phase === 'local_execute_result') {
      const receipt = object(event.receipt ?? event.result);
      const record = Number.isSafeInteger(event.step) ? byStep.get(event.step) : records.at(-1);
      if (record) add({ id: record.id, message: event.message, evidence: receipt.evidence, ok: receipt.ok, verified: receipt.verified, stateChanged: receipt.stateChanged, outcome: receipt.outcome, data: receipt.data, effectConfirmed: receipt.effectConfirmed, needsObservation: receipt.needsObservation });
      continue;
    }
    if (phase === 'verify') {
      const record = Number.isSafeInteger(event.step) ? byStep.get(event.step) : records.at(-1);
      if (record) add({ id: record.id, message: event.message, evidence: event.evidence, outcome: event.outcome, verified: event.outcome === 'verified', stateChanged: event.outcome === 'observed_change', failed: event.outcome === 'not_verified', effectConfirmed: event.effectConfirmed, needsObservation: event.needsObservation });
    }
  }
  for (const completed of boundedArray(report?.completed, MAX_STEPS)) {
    const candidate = candidates.get(completed?.id);
    const record = add({ id: string(completed?.id, 160) || null, label: completed?.label ?? candidate?.label, operation: completed?.operation ?? candidate?.operation, evidence: completed?.evidence, outcome: completed?.outcome, verified: completed?.outcome === 'verified', stateChanged: completed?.outcome === 'observed_change', failed: !['verified', 'observed_change', 'success', 'local_saved'].includes(completed?.outcome), effectConfirmed: completed?.outcome === 'observed_change', needsObservation: completed?.outcome === 'observed_change' });
    if (completed?.outcome === 'verified') record.status = 'verified';
  }
  return records.slice(0, MAX_STEPS).map(record => ({ ...record, statusLabel: STATUS_LABELS[record.status] ?? STATUS_LABELS.pending }));
}

function snapshotFrom(report) {
  const events = eventList(report);
  const candidates = [report?.final, report?.observation?.snapshot, report?.observation, ...events.slice().reverse().map(event => event.snapshot ?? event.observation)];
  return candidates.find(item => item && typeof item === 'object' && (Array.isArray(item.windows) || Array.isArray(item.elements) || Array.isArray(item.controls))) ?? null;
}
function windowView(value) {
  const item = object(value);
  return { id: string(item.id, 160), title: string(item.title ?? item.name ?? item.label, 260) || 'Окно без названия', app: string(item.processName ?? item.app ?? item.appName, 160), active: item.active === true, minimized: item.minimized === true, maximized: item.maximized === true };
}
function controlView(value) {
  const item = object(value);
  return { id: string(item.id, 160), name: string(item.name ?? item.label, 280) || 'Элемент без названия', role: string(item.role, 100), selected: typeof item.selected === 'boolean' ? item.selected : null, toggleState: string(item.toggleState, 100), expandState: string(item.expandState, 100) };
}

/** Current observation, coverage and available UI are kept separate from decisions. */
export function formatObservation(report = {}) {
  const snapshot = snapshotFrom(report);
  if (!snapshot) return { available: false, coverage: 'Наблюдение не приложено к отчёту.', availableWindow: null, windows: [], controls: [], facts: [] };
  const windows = boundedArray(snapshot.windows, MAX_WINDOWS).map(windowView);
  const rawControls = array(snapshot.elements).length ? snapshot.elements : snapshot.controls;
  const controls = boundedArray(rawControls, MAX_CONTROLS).filter(item => object(item).role !== 'Window').map(controlView);
  const selectedId = string(snapshot.facts?.selectedWindowId, 160);
  const availableWindow = windows.find(item => item.id === selectedId) ?? windows.find(item => item.active) ?? windows[0] ?? null;
  const metadata = object(snapshot.metadata);
  const coverage = metadata.truncated === true ? 'Наблюдение неполное: часть окон или элементов могла быть пропущена.' : (hasCyrillic(metadata.coverage) ? string(metadata.coverage, 500) : '') || `Наблюдение: окон ${windows.length}, элементов ${controls.length}.`;
  const facts = Object.entries(object(snapshot.facts)).slice(0, 20).map(([key, value]) => ({ label: key.replaceAll('_', ' '), value: typeof value === 'string' ? string(value, 240) : String(value) }));
  return { available: true, coverage, availableWindow, windows, controls, facts, truncated: metadata.truncated === true };
}

export function formatCapabilities(report = {}) {
  const source = Array.isArray(report?.capabilities) ? report.capabilities : array(report?.capabilities?.capabilities);
  return boundedArray(source, MAX_CAPABILITIES).map(item => {
    const capability = object(item);
    const name = string(capability.name, 120);
    return { name, title: capabilityTitle(name, capability.title), description: capabilityDescription(name, capability.description), available: typeof capability.available === 'boolean' ? capability.available : null, reason: hasCyrillic(capability.reason) ? string(capability.reason, 500) : '' };
  }).filter(item => item.title || item.name);
}

function isAgentReport(report) {
  return report?.mode === 'AGENT_ASSISTANT' || eventList(report).some(event => String(event.phase ?? '').startsWith('agent_'));
}
function latestAgentRequest(report) {
  return eventList(report).slice().reverse().find(event => event.phase === 'agent_request') ?? null;
}
function firstInteger(...values) {
  return values.find(value => Number.isSafeInteger(value) && value >= 0) ?? null;
}
function firstBoolean(...values) {
  return values.find(value => typeof value === 'boolean') ?? null;
}
function agentContextSource(report) {
  const latest = latestAgentRequest(report);
  const wrapper = object(report?.capabilities);
  return object(report?.context ?? report?.agentContext ?? report?.requestContext ?? latest?.context ?? wrapper.context);
}
export function formatContext(report = {}) {
  const context = agentContextSource(report);
  const history = object(context.history);
  const latest = latestAgentRequest(report);
  const turns = firstInteger(context.turnCount, context.turns, context.historyTurns, context.historyCount, history.turns);
  const historyTurns = firstInteger(context.historyTurns, context.historyCount, context.turnCount, context.turns, history.turns);
  const requestTools = array(latest?.tools ?? latest?.request?.tools);
  const toolCount = firstInteger(context.toolCount, context.toolsCount, requestTools.length || null);
  const commandIncluded = firstBoolean(context.commandIncluded, context.hasCommand, context.commandSent);
  const inferredCurrentTime = typeof context.nowIso === 'string' && context.nowIso.trim() !== '' ? true : undefined;
  const currentTimeIncluded = firstBoolean(context.currentTimeIncluded, context.nowIncluded, context.currentTimeSent, inferredCurrentTime);
  const historyIncluded = firstBoolean(context.historyIncluded, context.hasHistory, context.historySent, history.included);
  const timeZone = string(context.timeZone ?? context.timezone, 120);
  return { turns, turnCount: turns, historyTurns, toolCount, commandIncluded, currentTimeIncluded, historyIncluded, timeZone, available: turns !== null || toolCount !== null || commandIncluded !== null || currentTimeIncluded !== null || Boolean(timeZone) };
}
function agentRequestFields(report) {
  const fields = [];
  const requests = eventList(report).filter(event => event.phase === 'agent_request');
  const latest = requests.at(-1) ?? {};
  const command = string(report?.command, 1024) || requests.map(event => string(event.text, 1024)).find(Boolean) || boundedArray(report?.calls, MAX_CALLS).map(call => string(call?.request?.text, 1024)).find(Boolean);
  if (command) fields.push({ label: 'Текст команды', value: command });
  const tools = array(latest.tools).length ? latest.tools : array(latest.request?.tools).length ? latest.request.tools : boundedArray(report?.calls, MAX_CALLS).map(call => array(call?.request?.tools)).find(list => list.length) ?? [];
  if (tools.length) fields.push({ label: 'Доступные операции', value: tools.length + ' описаний передано агенту.' });
  const context = formatContext(report);
  if (context.historyTurns !== null) fields.push({ label: 'Контекст прошлых ходов', value: 'Передан контекст предыдущих запросов: ' + context.historyTurns + '.' });
  else if (context.historyIncluded === true) fields.push({ label: 'Контекст прошлых ходов', value: 'Передан контекст предыдущих запросов.' });
  if (context.currentTimeIncluded === true) fields.push({ label: 'Текущее время', value: context.timeZone ? 'Передано вместе с часовым поясом ' + context.timeZone + '.' : 'Передано агенту.' });
  else if (context.currentTimeIncluded === false) fields.push({ label: 'Текущее время', value: 'В этот запрос не включалось.' });
  if (context.commandIncluded === false) fields.push({ label: 'Команда пользователя', value: 'В этот запрос не включалась.' });
  return fields.slice(0, 12);
}
export function formatDataSent(report = {}) {
  const fields = [];
  if (isAgentReport(report)) {
    fields.push(...agentRequestFields(report));
  } else {
    for (const call of boundedArray(report?.calls, MAX_CALLS)) {
      for (const item of requestData(call?.request)) {
        const key = item.label + '\\0' + item.value;
        if (!fields.some(existing => existing.label + '\\0' + existing.value === key)) fields.push(item);
      }
    }
  }
  for (const event of eventList(report)) {
    if (event.phase === 'agent_tool_call') {
      const call = object(event.toolCall);
      fields.push({ label: 'Данные инструменту', value: toolCallData({ ...call, title: event.title }) });
    }
  }
  if (!fields.length && string(report?.command, 1024)) fields.push({ label: 'Текст команды', value: string(report.command, 1024) });
  if (!fields.length) fields.push({ label: 'Данные запроса', value: 'Данные не записаны в этом старом отчёте.' });
  return fields.slice(0, 24);
}

function responseTextCandidates(event) {
  const result = [];
  const add = value => { const textValue = string(value, MAX_TEXT); if (textValue && !result.includes(textValue)) result.push(textValue); };
  const toolCall = object(event?.toolCall);
  const toolName = event?.name ?? toolCall.name;
  const responseCalls = boundedArray(event?.responseCalls, MAX_RESPONSES);
  if (event?.phase === 'agent_response') {
    add(event?.text);
    add(event?.response?.text);
    for (const call of responseCalls) {
      if (call?.name === 'assistant_respond') add(object(call?.arguments ?? call?.args).text);
    }
    if (!result.length && !responseCalls.length) add(event?.message);
  } else if (toolName === 'assistant_respond') {
    add(object(toolCall.arguments ?? toolCall.args).text);
    const eventResult = object(event?.result);
    add(eventResult.message);
    add(object(eventResult.data).text);
  }
  return result;
}
export function formatAgentResponses(report = {}) {
  const texts = [];
  for (const event of eventList(report)) {
    for (const textValue of responseTextCandidates(event)) {
      if (!texts.includes(textValue)) texts.push(textValue);
      if (texts.length >= MAX_RESPONSES) break;
    }
    if (texts.length >= MAX_RESPONSES) break;
  }
  if (!texts.length) {
    const fallback = string(report?.final?.text ?? report?.message, MAX_TEXT);
    if (fallback) texts.push(fallback);
  }
  return texts.slice(0, MAX_RESPONSES).map((textValue, index) => ({ index: index + 1, text: textValue }));
}

/** One renderer-facing view model for the details dialog. */
export function formatLogView(report = {}) {
  const value = object(report);
  return {
    decisions: formatDecisionLog(value),
    executions: formatExecutionLog(value),
    observation: formatObservation(value),
    capabilities: formatCapabilities(value),
    context: formatContext(value),
    dataSent: formatDataSent(value),
    agentResponses: formatAgentResponses(value),
    agentMode: isAgentReport(value),
  };
}

// Friendly aliases for callers that prefer the term used by the UI.
export const buildLogViewModel = formatLogView;
