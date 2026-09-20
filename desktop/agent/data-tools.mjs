import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_OFFSET,
  MAX_PAGE_SIZE,
  MAX_TEXT_LENGTH,
  validateText,
} from '../core/store.mjs';

const DAY_SECONDS = 24 * 60 * 60;
const MAX_DUE_SECONDS = 366 * DAY_SECONDS;
const DAY_MILLISECONDS = DAY_SECONDS * 1000;
const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/u;
const NO_DATA = Symbol('no-data');

const integerSchema = {
  type: 'integer', minimum: 1, maximum: MAX_SAFE_ID,
};
const textSchema = {
  type: 'string', minLength: 1, maxLength: MAX_TEXT_LENGTH,
  description: 'Непустой текст без управляющих символов.',
};
const expectedTextSchema = {
  ...textSchema,
  description: 'Точный текущий текст записи для защиты от устаревшего изменения.',
};
const dateTimeSchema = {
  type: 'string',
  format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:\\d{2})$',
  description: 'Явная известная дата и время ISO 8601 с Z или смещением ±HH:MM. Для нового срока используй результат time_resolve; для текущего срока передай без изменений поле data.expectedDueAt из reminder_get или reminders_search. Не вычисляй и не угадывай дату.',
};
const expectedDueAtSchema = {
  ...dateTimeSchema,
  description: 'Точный текущий срок напоминания ISO 8601. Скопируй без изменений поле data.expectedDueAt из reminder_get или reminders_search; не вычисляй и не угадывай его.',
};
const querySchema = {
  type: 'string', maxLength: MAX_TEXT_LENGTH,
  description: 'Буквальный фрагмент текста; символы %, _ и обратная косая черта не являются шаблонами.',
};
const pageProperties = {
  limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
  offset: { type: 'integer', minimum: 0, maximum: MAX_PAGE_OFFSET, default: 0 },
};
const dateOnlySchema = {
  type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Явная календарная дата YYYY-MM-DD.',
};
const clockTimeSchema = {
  type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$', description: 'Явное местное время HH:MM; 24:00 не допускается.',
};

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function result({ ok, verified, effectAttempted, evidence, message, data = NO_DATA }) {
  const value = { ok, verified, effectAttempted, evidence, message };
  if (data !== NO_DATA) value.data = data;
  return value;
}

function success(evidence, message, data = NO_DATA, effectAttempted = false) {
  return result({ ok: true, verified: true, effectAttempted, evidence, message, data });
}

function failure(evidence, message, { effectAttempted = false, data = NO_DATA } = {}) {
  return result({ ok: false, verified: false, effectAttempted, evidence, message, data });
}

function invalid(message = 'Некорректные параметры инструмента.') {
  return failure('invalid_args', message);
}

function checkAbort(signal) {
  return Boolean(signal?.aborted);
}

function aborted() {
  return failure('aborted', 'Выполнение остановлено до изменения данных.');
}

function validateArgs(args, { required = [], optional = [] } = {}) {
  if (!plain(args)) throw new TypeError('Аргументы должны быть объектом.');
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new TypeError(`Неизвестный аргумент: ${key}.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(args, key)) throw new TypeError(`Отсутствует аргумент: ${key}.`);
  }
  return args;
}

function validateId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Идентификатор должен быть положительным целым числом.');
  return value;
}

function validateExactText(value, label = 'expectedText') {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} должен быть непустой строкой.`);
  if ([...value].length > MAX_TEXT_LENGTH) throw new TypeError(`${label} слишком длинный.`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) throw new TypeError(`${label} содержит управляющие символы.`);
  return value;
}

function validateQuery(value) {
  if (typeof value !== 'string') throw new TypeError('query должен быть строкой.');
  if ([...value].length > MAX_TEXT_LENGTH) throw new TypeError('query слишком длинный.');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) throw new TypeError('query содержит управляющие символы.');
  return value;
}

function validatePage(value, label) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} должен быть целым числом.`);
  return value;
}

function parseDateTime(value, nowMs, { future = false } = {}) {
  if (typeof value !== 'string') throw new TypeError('Дата должна быть строкой ISO 8601.');
  const match = DATE_TIME_RE.exec(value);
  if (!match) throw new TypeError('Дата должна содержать явную временную зону Z или ±HH:MM.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const offsetHours = match[8] === 'Z' ? 0 : Number(match[8].slice(1, 3));
  const offsetMinutes = match[8] === 'Z' ? 0 : Number(match[8].slice(4, 6));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offsetMinutes > 59
    || offsetHours > 14 || offsetHours === 14 && offsetMinutes !== 0) throw new TypeError('Дата содержит недопустимые компоненты.');
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) throw new TypeError('Дата содержит недопустимый день.');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError('Дата не распознана.');
  const seconds = milliseconds / 1000;
  if (future && (seconds <= nowMs / 1000 || seconds > nowMs / 1000 + MAX_DUE_SECONDS)) {
    throw new RangeError('Срок должен быть в будущем и не дальше 366 дней.');
  }
  return seconds;
}

function readNow(now) {
  const value = now();
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Текущее время недоступно.');
  return value;
}

function isoLocal(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function currentTime(now) {
  const nowMs = readNow(now);
  const date = new Date(nowMs);
  return { localISO: isoLocal(date), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', utcISO: date.toISOString() };
}

function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function localParts(epochMs, timeZone = localTimeZone()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
}

function utcFromParts({ year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0 }) {
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(hour, minute, second, millisecond);
  return value.getTime();
}

function sameParts(left, right) {
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].every(key => left[key] === right[key]);
}

function localOffset(epochMs, timeZone = localTimeZone()) {
  const parts = localParts(epochMs, timeZone);
  return Math.round((utcFromParts(parts) - epochMs) / 60_000) * 60_000;
}

function localIsoAt(epochMs, timeZone = localTimeZone()) {
  const parts = localParts(epochMs, timeZone);
  const offset = localOffset(epochMs, timeZone);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  const date = new Date(epochMs);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${pad(date.getUTCMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(absolute / 3_600_000))}:${pad(Math.floor(absolute / 60_000) % 60)}`;
}

function parseCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TypeError('date должен быть датой YYYY-MM-DD.');
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) throw new TypeError('date содержит недопустимый календарный день.');
  return { year, month, day };
}

function parseClockTime(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) throw new TypeError('time должен быть временем HH:MM.');
  const [hour, minute] = value.split(':').map(Number);
  return { hour, minute };
}

function localDateWithOffset(nowMs, dayOffset) {
  const nowParts = localParts(nowMs);
  const day = new Date(utcFromParts(nowParts) + dayOffset * DAY_MILLISECONDS);
  return { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() };
}

function resolveLocalWallTime(parts, timeZone = localTimeZone()) {
  const naive = utcFromParts(parts);
  const candidates = new Set();
  // Looking around the naive value captures both sides of a DST transition.
  for (const delta of [-24, -12, 0, 12, 24].map(hours => hours * 60 * 60 * 1000)) {
    const offset = localOffset(naive + delta, timeZone);
    const candidate = naive - offset;
    if (sameParts(localParts(candidate, timeZone), parts)) candidates.add(candidate);
  }
  if (candidates.size !== 1) throw new RangeError('Указанное местное время попадает в переход часового пояса.');
  return [...candidates][0];
}

function resolveTime(value, nowMs) {
  const args = validateArgs(value, { required: ['mode'], optional: ['amount', 'unit', 'date', 'dayOffset', 'time'] });
  if (args.mode === 'relative') {
    if (!Number.isSafeInteger(args.amount) || args.amount < 1 || !['minutes', 'hours', 'days'].includes(args.unit)
      || args.date !== undefined || args.dayOffset !== undefined || args.time !== undefined) throw new TypeError('Для relative нужны только положительные amount и unit.');
    const unitSeconds = { minutes: 60, hours: 3_600, days: DAY_SECONDS }[args.unit];
    const dueMs = nowMs + args.amount * unitSeconds * 1000;
    if (dueMs > nowMs + MAX_DUE_SECONDS * 1000) throw new RangeError('Срок должен быть не дальше 366 дней.');
    return dueMs;
  }
  if (args.mode !== 'calendar' || args.amount !== undefined || args.unit !== undefined || args.time === undefined
    || (args.date === undefined) === (args.dayOffset === undefined)) throw new TypeError('Для calendar нужны ровно дата или dayOffset и явное time.');
  if (args.dayOffset !== undefined && (!Number.isSafeInteger(args.dayOffset) || args.dayOffset < 0 || args.dayOffset > 366)) throw new RangeError('dayOffset должен быть от 0 до 366.');
  const date = args.date === undefined ? localDateWithOffset(nowMs, args.dayOffset) : parseCalendarDate(args.date);
  const time = parseClockTime(args.time);
  const dueMs = resolveLocalWallTime({ ...date, ...time, second: 0 }, localTimeZone());
  if (dueMs <= nowMs) throw new RangeError('Срок должен быть в будущем.');
  if (dueMs > nowMs + MAX_DUE_SECONDS * 1000) throw new RangeError('Срок должен быть не дальше 366 дней.');
  return dueMs;
}

function addKnown(set, id) {
  try { set.add(validateId(id)); } catch { /* A malformed store result is handled by the caller. */ }
}

function addKnownItems(set, items) {
  if (!Array.isArray(items)) return;
  for (const item of items) addKnown(set, item?.id);
}

function normalizeReminder(item) {
  if (!item || typeof item !== 'object' || !Number.isFinite(item.due_at)) return null;
  const timestamp = Number(item.due_at) * 1000;
  const date = new Date(timestamp);
  if (!Number.isFinite(timestamp) || Number.isNaN(date.getTime())) return null;
  const dueAt = date.toISOString();
  return { ...item, dueAt, expectedDueAt: dueAt };
}

function expectedReminderDue(value, nowMs) {
  return parseDateTime(value, nowMs);
}

function readNote(store, id, known) {
  const item = store.getNote(id);
  if (item) addKnown(known, id);
  return item;
}

function readReminder(store, id, known) {
  const item = store.getReminder(id);
  if (item) addKnown(known, id);
  return item ? normalizeReminder(item) : item;
}

function matchesNote(item, expectedText) {
  return Boolean(item) && item.text === expectedText;
}

function matchesReminder(item, expectedText, expectedDueAt) {
  return Boolean(item) && item.text === expectedText && item.due_at === expectedDueAt;
}

function storeFailure(error, effectAttempted) {
  return failure(effectAttempted ? 'effect_outcome_unknown' : 'store_error', effectAttempted
    ? 'Изменение могло выполниться; его результат не подтверждён.'
    : 'Не удалось прочитать локальные данные.', { effectAttempted });
}

function handleError(error, effectAttempted = false) {
  return !effectAttempted && (error instanceof TypeError || error instanceof RangeError)
    ? invalid(error.message)
    : storeFailure(error, effectAttempted);
}

function noteSearchSchema() {
  return {
    type: 'object', additionalProperties: false,
    properties: { query: querySchema, ...pageProperties }, required: ['query'],
  };
}

function reminderSearchSchema() {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      query: querySchema,
      status: { type: 'string', enum: ['pending', 'delivered', 'all'], default: 'pending' },
      ...pageProperties,
    }, required: ['query'],
  };
}

function timeResolveSchema() {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: ['relative', 'calendar'] },
      amount: { type: 'integer', minimum: 1, description: 'Для relative: положительное количество единиц.' },
      unit: { type: 'string', enum: ['minutes', 'hours', 'days'] },
      date: dateOnlySchema,
      dayOffset: { type: 'integer', minimum: 0, maximum: 366, description: 'Для calendar: 0 — сегодня, максимум 366 дней от сегодня.' },
      time: clockTimeSchema,
    },
    required: ['mode'],
    oneOf: [
      { properties: { mode: { const: 'relative' } }, required: ['amount', 'unit'] },
      {
        properties: { mode: { const: 'calendar' } }, required: ['time'],
        oneOf: [{ required: ['date'] }, { required: ['dayOffset'] }],
      },
    ],
    description: 'Рассчитывает только явно заданное relative или calendar время. Не подставляет отсутствующий день или час.',
  };
}

function descriptor(name, title, description, parameters, effect, execute) {
  return { name, title, description, parameters, effect, execute };
}

export function createDataTools({ store, now = Date.now } = {}) {
  if (!store || typeof store !== 'object') throw new TypeError('Нужно передать локальное хранилище.');
  if (typeof now !== 'function') throw new TypeError('now должен быть функцией.');

  // These sets intentionally belong to one tool run. A fresh createDataTools call
  // starts with no trusted targets, so a later model turn must read rows again.
  const knownNotes = new Set();
  const knownReminders = new Set();
  const canMutate = (set, id) => set.has(id);

  const tools = [];

  tools.push(descriptor(
    'notes_search', 'Поиск заметок',
    'Ищет заметки по буквальному фрагменту и возвращает страницу с общим количеством результатов.',
    noteSearchSchema(), false,
    async (args = {}, { signal } = {}) => {
      try {
        const value = validateArgs(args, { required: ['query'], optional: ['limit', 'offset'] });
        const query = validateQuery(value.query);
        const limit = validatePage(value.limit, 'limit');
        const offset = validatePage(value.offset, 'offset');
        if (limit !== undefined && (limit < 1 || limit > MAX_PAGE_SIZE)) throw new RangeError('limit вне допустимого диапазона.');
        if (offset !== undefined && (offset < 0 || offset > MAX_PAGE_OFFSET)) throw new RangeError('offset вне допустимого диапазона.');
        if (checkAbort(signal)) return aborted();
        const data = store.searchNotes(query, { ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }) });
        addKnownItems(knownNotes, data?.items);
        if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total)) return failure('read_unverified', 'Результат поиска не удалось подтвердить.');
        return success('notes_listed', 'Заметки прочитаны.', { items: data.items, total: data.total, limit: data.limit, offset: data.offset });
      } catch (error) {
        return handleError(error);
      }
    },
  ));

  tools.push(descriptor(
    'note_get', 'Прочитать заметку',
    'Читает одну заметку по точному числовому идентификатору и делает её доступной для защищённой мутации в этом запуске.',
    { type: 'object', additionalProperties: false, properties: { id: integerSchema }, required: ['id'] }, false,
    async (args = {}, { signal } = {}) => {
      try {
        const value = validateArgs(args, { required: ['id'] });
        const id = validateId(value.id);
        if (checkAbort(signal)) return aborted();
        const item = readNote(store, id, knownNotes);
        return item ? success('note_read', 'Заметка прочитана.', item) : failure('not_found', 'Заметка не найдена.');
      } catch (error) {
        return handleError(error);
      }
    },
  ));

  tools.push(descriptor(
    'note_create', 'Создать заметку',
    'Создаёт заметку с переданным текстом и подтверждает её повторным чтением.',
    { type: 'object', additionalProperties: false, properties: { text: textSchema }, required: ['text'] }, true,
    async (args = {}, { signal } = {}) => {
      let effectAttempted = false;
      try {
        const value = validateArgs(args, { required: ['text'] });
        const text = validateText(value.text);
        if (checkAbort(signal)) return aborted();
        effectAttempted = true;
        const id = validateId(store.addNote(text));
        const item = readNote(store, id, knownNotes);
        return item && item.text === text
          ? success('note_created', 'Заметка создана.', item, true)
          : failure('write_unverified', 'Заметка создана, но повторное чтение не подтвердило результат.', { effectAttempted: true, data: item ?? null });
      } catch (error) {
        return handleError(error, effectAttempted);
      }
    },
  ));

  tools.push(descriptor(
    'note_update', 'Изменить заметку',
    'Изменяет заметку только после чтения её в текущем запуске и точной проверки expectedText.',
    {
      type: 'object', additionalProperties: false,
      properties: { id: integerSchema, text: textSchema, expectedText: expectedTextSchema },
      required: ['id', 'text', 'expectedText'],
    }, true,
    async (args = {}, { signal } = {}) => {
      let effectAttempted = false;
      try {
        const value = validateArgs(args, { required: ['id', 'text', 'expectedText'] });
        const id = validateId(value.id);
        const text = validateText(value.text);
        const expectedText = validateExactText(value.expectedText);
        if (!canMutate(knownNotes, id)) return failure('target_not_read', 'Сначала прочитайте эту заметку в текущем запуске.');
        const current = readNote(store, id, knownNotes);
        if (!current) return failure('not_found', 'Заметка не найдена.');
        if (!matchesNote(current, expectedText)) return failure('stale_target', 'Заметка изменилась; сначала прочитайте её заново.', { data: current });
        if (checkAbort(signal)) return aborted();
        effectAttempted = true;
        try { store.updateNote(id, text); } catch (error) {
          const after = readNote(store, id, knownNotes);
          if (after?.text === text) return success('note_updated', 'Заметка изменена.', after, true);
          throw error;
        }
        const after = readNote(store, id, knownNotes);
        return after?.text === text
          ? success('note_updated', 'Заметка изменена.', after, true)
          : failure('write_unverified', 'Изменение заметки не подтверждено повторным чтением.', { effectAttempted: true, data: after ?? null });
      } catch (error) {
        return handleError(error, effectAttempted);
      }
    },
  ));

  tools.push(descriptor(
    'note_delete', 'Удалить заметку',
    'Удаляет заметку только после чтения её в текущем запуске и точной проверки expectedText.',
    {
      type: 'object', additionalProperties: false,
      properties: { id: integerSchema, expectedText: expectedTextSchema }, required: ['id', 'expectedText'],
    }, true,
    async (args = {}, { signal } = {}) => {
      let effectAttempted = false;
      try {
        const value = validateArgs(args, { required: ['id', 'expectedText'] });
        const id = validateId(value.id);
        const expectedText = validateExactText(value.expectedText);
        if (!canMutate(knownNotes, id)) return failure('target_not_read', 'Сначала прочитайте эту заметку в текущем запуске.');
        const current = readNote(store, id, knownNotes);
        if (!current) return failure('not_found', 'Заметка не найдена.');
        if (!matchesNote(current, expectedText)) return failure('stale_target', 'Заметка изменилась; сначала прочитайте её заново.', { data: current });
        if (checkAbort(signal)) return aborted();
        effectAttempted = true;
        store.deleteNote(id);
        const after = readNote(store, id, knownNotes);
        return after === null
          ? success('note_deleted', 'Заметка удалена.', null, true)
          : failure('write_unverified', 'Удаление заметки не подтверждено повторным чтением.', { effectAttempted: true, data: after });
      } catch (error) {
        return handleError(error, effectAttempted);
      }
    },
  ));

  tools.push(descriptor(
    'reminders_search', 'Поиск напоминаний',
    'Ищет напоминания по буквальному фрагменту, статусу и странице результатов. Каждый результат содержит вычисленные dueAt и expectedDueAt в ISO 8601; expectedDueAt можно передать в mutation без пересчёта.',
    reminderSearchSchema(), false,
    async (args = {}, { signal } = {}) => {
      try {
        const value = validateArgs(args, { required: ['query'], optional: ['status', 'limit', 'offset'] });
        const query = validateQuery(value.query);
        const limit = validatePage(value.limit, 'limit');
        const offset = validatePage(value.offset, 'offset');
        if (limit !== undefined && (limit < 1 || limit > MAX_PAGE_SIZE)) throw new RangeError('limit вне допустимого диапазона.');
        if (offset !== undefined && (offset < 0 || offset > MAX_PAGE_OFFSET)) throw new RangeError('offset вне допустимого диапазона.');
        if (value.status !== undefined && !['pending', 'delivered', 'all'].includes(value.status)) throw new TypeError('status имеет недопустимое значение.');
        if (checkAbort(signal)) return aborted();
        const data = store.searchReminders(query, {
          ...(value.status === undefined ? {} : { status: value.status }),
          ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }),
        });
        addKnownItems(knownReminders, data?.items);
        if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total)) return failure('read_unverified', 'Результат поиска не удалось подтвердить.');
        const items = data.items.map(normalizeReminder);
        if (items.some(item => item === null)) return failure('read_unverified', 'Результат поиска не удалось подтвердить.');
        return success('reminders_listed', 'Напоминания прочитаны.', { items, total: data.total, limit: data.limit, offset: data.offset });
      } catch (error) {
        return handleError(error);
      }
    },
  ));

  tools.push(descriptor(
    'reminder_get', 'Прочитать напоминание',
    'Читает одно напоминание по точному идентификатору. В data возвращаются dueAt и expectedDueAt в ISO 8601; скопируйте expectedDueAt без изменений для защищённой мутации в этом запуске.',
    { type: 'object', additionalProperties: false, properties: { id: integerSchema }, required: ['id'] }, false,
    async (args = {}, { signal } = {}) => {
      try {
        const value = validateArgs(args, { required: ['id'] });
        const id = validateId(value.id);
        if (checkAbort(signal)) return aborted();
        const item = readReminder(store, id, knownReminders);
        return item ? success('reminder_read', 'Напоминание прочитано.', item) : failure('not_found', 'Напоминание не найдено.');
      } catch (error) {
        return handleError(error);
      }
    },
  ));

  tools.push(descriptor(
    'reminder_create', 'Создать напоминание',
    'Создаёт напоминание с явной будущей датой ISO 8601 и подтверждает его повторным чтением. В data возвращаются dueAt и expectedDueAt, вычисленные из сохранённого срока.',
    { type: 'object', additionalProperties: false, properties: { text: textSchema, dueAt: dateTimeSchema }, required: ['text', 'dueAt'] }, true,
    async (args = {}, { signal } = {}) => {
      let effectAttempted = false;
      try {
        const value = validateArgs(args, { required: ['text', 'dueAt'] });
        const text = validateText(value.text);
        const dueAt = parseDateTime(value.dueAt, readNow(now), { future: true });
        if (checkAbort(signal)) return aborted();
        effectAttempted = true;
        const id = validateId(store.addReminder(text, dueAt));
        const item = readReminder(store, id, knownReminders);
        return item && item.text === text && item.due_at === dueAt
          ? success('reminder_created', 'Напоминание создано.', item, true)
          : failure('write_unverified', 'Напоминание создано, но повторное чтение не подтвердило результат.', { effectAttempted: true, data: item ?? null });
      } catch (error) {
        return handleError(error, effectAttempted);
      }
    },
  ));

  tools.push(descriptor(
    'reminder_update', 'Изменить напоминание',
    'Изменяет напоминание только после чтения его в текущем запуске и точной проверки expectedText и expectedDueAt. Передайте expectedDueAt без изменений из data.expectedDueAt текущего чтения.',
    {
      type: 'object', additionalProperties: false,
      properties: { id: integerSchema, text: textSchema, dueAt: dateTimeSchema, expectedText: expectedTextSchema, expectedDueAt: expectedDueAtSchema },
      required: ['id', 'expectedText', 'expectedDueAt'], anyOf: [{ required: ['text'] }, { required: ['dueAt'] }],
    }, true,
    async (args = {}, { signal } = {}) => {
      let effectAttempted = false;
      try {
        const value = validateArgs(args, { required: ['id', 'expectedText', 'expectedDueAt'], optional: ['text', 'dueAt'] });
        if (value.text === undefined && value.dueAt === undefined) throw new TypeError('Нужно указать text или dueAt.');
        const id = validateId(value.id);
        const expectedText = validateExactText(value.expectedText);
        const expectedDueAt = expectedReminderDue(value.expectedDueAt, readNow(now));
        const text = value.text === undefined ? undefined : validateText(value.text);
        const dueAt = value.dueAt === undefined ? undefined : parseDateTime(value.dueAt, readNow(now), { future: true });
        if (!canMutate(knownReminders, id)) return failure('target_not_read', 'Сначала прочитайте это напоминание в текущем запуске.');
        const current = readReminder(store, id, knownReminders);
        if (!current) return failure('not_found', 'Напоминание не найдено.');
        if (!matchesReminder(current, expectedText, expectedDueAt)) return failure('stale_target', 'Напоминание изменилось; сначала прочитайте его заново.', { data: current });
        if (dueAt !== undefined && current.delivered_at !== null) return failure('delivered_due_immutable', 'Доставленное напоминание нельзя перенести; сначала создайте новое.', { data: current });
        if (checkAbort(signal)) return aborted();
        effectAttempted = true;
        try { store.updateReminder(id, { ...(text === undefined ? {} : { text }), ...(dueAt === undefined ? {} : { dueAt }) }); } catch (error) {
          const after = readReminder(store, id, knownReminders);
          if (after && (text === undefined || after.text === text) && (dueAt === undefined || after.due_at === dueAt)) return success('reminder_updated', 'Напоминание изменено.', after, true);
          throw error;
        }
        const after = readReminder(store, id, knownReminders);
        return after && (text === undefined || after.text === text) && (dueAt === undefined || after.due_at === dueAt)
          ? success('reminder_updated', 'Напоминание изменено.', after, true)
          : failure('write_unverified', 'Изменение напоминания не подтверждено повторным чтением.', { effectAttempted: true, data: after ?? null });
      } catch (error) {
        return handleError(error, effectAttempted);
      }
    },
  ));

  tools.push(descriptor(
    'reminder_delete', 'Удалить напоминание',
    'Удаляет напоминание только после чтения его в текущем запуске и точной проверки expectedText и expectedDueAt. Передайте expectedDueAt без изменений из data.expectedDueAt текущего чтения.',
    {
      type: 'object', additionalProperties: false,
      properties: { id: integerSchema, expectedText: expectedTextSchema, expectedDueAt: expectedDueAtSchema },
      required: ['id', 'expectedText', 'expectedDueAt'],
    }, true,
    async (args = {}, { signal } = {}) => {
      let effectAttempted = false;
      try {
        const value = validateArgs(args, { required: ['id', 'expectedText', 'expectedDueAt'] });
        const id = validateId(value.id);
        const expectedText = validateExactText(value.expectedText);
        const expectedDueAt = expectedReminderDue(value.expectedDueAt, readNow(now));
        if (!canMutate(knownReminders, id)) return failure('target_not_read', 'Сначала прочитайте это напоминание в текущем запуске.');
        const current = readReminder(store, id, knownReminders);
        if (!current) return failure('not_found', 'Напоминание не найдено.');
        if (!matchesReminder(current, expectedText, expectedDueAt)) return failure('stale_target', 'Напоминание изменилось; сначала прочитайте его заново.', { data: current });
        if (checkAbort(signal)) return aborted();
        effectAttempted = true;
        store.deleteReminder(id);
        const after = readReminder(store, id, knownReminders);
        return after === null
          ? success('reminder_deleted', 'Напоминание удалено.', null, true)
          : failure('write_unverified', 'Удаление напоминания не подтверждено повторным чтением.', { effectAttempted: true, data: after });
      } catch (error) {
        return handleError(error, effectAttempted);
      }
    },
  ));

  tools.push(descriptor(
    'reminder_complete', 'Завершить напоминание',
    'Отмечает напоминание выполненным только после чтения его в текущем запуске и точной проверки expectedText и expectedDueAt. Передайте expectedDueAt без изменений из data.expectedDueAt текущего чтения.',
    {
      type: 'object', additionalProperties: false,
      properties: { id: integerSchema, expectedText: expectedTextSchema, expectedDueAt: expectedDueAtSchema },
      required: ['id', 'expectedText', 'expectedDueAt'],
    }, true,
    async (args = {}, { signal } = {}) => {
      let effectAttempted = false;
      try {
        const value = validateArgs(args, { required: ['id', 'expectedText', 'expectedDueAt'] });
        const id = validateId(value.id);
        const expectedText = validateExactText(value.expectedText);
        const expectedDueAt = expectedReminderDue(value.expectedDueAt, readNow(now));
        if (!canMutate(knownReminders, id)) return failure('target_not_read', 'Сначала прочитайте это напоминание в текущем запуске.');
        const current = readReminder(store, id, knownReminders);
        if (!current) return failure('not_found', 'Напоминание не найдено.');
        if (!matchesReminder(current, expectedText, expectedDueAt)) return failure('stale_target', 'Напоминание изменилось; сначала прочитайте его заново.', { data: current });
        if (current.delivered_at !== null) return failure('already_completed', 'Напоминание уже выполнено.', { data: current });
        if (checkAbort(signal)) return aborted();
        effectAttempted = true;
        store.completeReminder(id);
        const after = readReminder(store, id, knownReminders);
        return after?.delivered_at !== null && after?.delivered_at !== undefined
          ? success('reminder_completed', 'Напоминание отмечено выполненным.', after, true)
          : failure('write_unverified', 'Завершение напоминания не подтверждено повторным чтением.', { effectAttempted: true, data: after ?? null });
      } catch (error) {
        return handleError(error, effectAttempted);
      }
    },
  ));

  tools.push(descriptor(
    'clock_now', 'Текущее время',
    'Возвращает текущее локальное и UTC-время. Используй его, чтобы запросить у пользователя явный срок напоминания; не угадывай «завтра» самостоятельно.',
    { type: 'object', additionalProperties: false, properties: {} }, false,
    async (args = {}, { signal } = {}) => {
      try {
        validateArgs(args);
        if (checkAbort(signal)) return aborted();
        return success('clock_read', 'Текущее время прочитано.', currentTime(now));
      } catch (error) {
        return error instanceof TypeError || error instanceof RangeError ? invalid(error.message) : failure('clock_unavailable', 'Текущее время недоступно.');
      }
    },
  ));

  tools.push(descriptor(
    'time_resolve', 'Рассчитать срок',
    'Рассчитывает срок из явно заданных typed-компонентов relative или calendar в локальном часовом поясе. Не угадывает отсутствующие день или время.',
    timeResolveSchema(), false,
    async (args = {}, { signal } = {}) => {
      try {
        if (checkAbort(signal)) return aborted();
        const nowMs = readNow(now);
        const dueMs = resolveTime(args, nowMs);
        const timeZone = localTimeZone();
        const dueAt = localIsoAt(dueMs, timeZone);
        const display = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short', timeZone }).format(new Date(dueMs));
        return success('time_resolved', 'Срок рассчитан.', { dueAt, display, timeZone });
      } catch (error) {
        return handleError(error);
      }
    },
  ));

  return tools;
}
