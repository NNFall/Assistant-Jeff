import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

export const MAX_TEXT_LENGTH = 2000;
export const MAX_COMMAND_LENGTH = 4096;
export const MAX_DELAY_SECONDS = 365 * 24 * 60 * 60;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 100;
export const MAX_PAGE_OFFSET = 1_000_000_000;

export function validateText(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Текст не должен быть пустым.');
  if ([...value].length > MAX_TEXT_LENGTH) throw new TypeError(`Текст не должен превышать ${MAX_TEXT_LENGTH} символов.`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) throw new TypeError('Текст содержит недопустимые управляющие символы.');
  return value.trim();
}
export function validateTimestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError('Время должно быть конечным положительным числом секунд Unix.');
  return value;
}
function validateId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Идентификатор должен быть положительным целым числом.');
  return value;
}

function validateSearchQuery(value) {
  if (typeof value !== 'string') throw new TypeError('Поисковый запрос должен быть строкой.');
  if ([...value].length > MAX_TEXT_LENGTH) throw new TypeError(`Поисковый запрос не должен превышать ${MAX_TEXT_LENGTH} символов.`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) throw new TypeError('Поисковый запрос содержит недопустимые управляющие символы.');
  return value;
}

function validateOptionsObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} должны быть объектом.`);
  return value;
}

function validatePageOptions(value) {
  const options = validateOptionsObject(value, 'Параметры страницы');
  for (const key of Object.keys(options)) {
    if (!['limit', 'offset'].includes(key)) throw new TypeError(`Неизвестный параметр страницы: ${key}.`);
  }
  const limit = options.limit === undefined ? DEFAULT_PAGE_SIZE : options.limit;
  const offset = options.offset === undefined ? 0 : options.offset;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new RangeError(`Лимит должен быть целым числом от 1 до ${MAX_PAGE_SIZE}.`);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_PAGE_OFFSET) throw new RangeError(`Смещение должно быть целым числом от 0 до ${MAX_PAGE_OFFSET}.`);
  return { limit, offset };
}

function escapeLikeLiteral(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function searchPattern(query) {
  return `%${escapeLikeLiteral(query.toLocaleLowerCase('ru-RU'))}%`;
}

function validateReminderStatus(value) {
  if (!['pending', 'delivered', 'all'].includes(value)) throw new TypeError('Статус напоминаний должен быть pending, delivered или all.');
  return value;
}

function validateSearchReminderOptions(value) {
  const options = validateOptionsObject(value, 'Параметры поиска напоминаний');
  for (const key of Object.keys(options)) {
    if (!['status', 'limit', 'offset'].includes(key)) throw new TypeError(`Неизвестный параметр поиска напоминаний: ${key}.`);
  }
  const { limit, offset } = validatePageOptions({ limit: options.limit, offset: options.offset });
  const status = validateReminderStatus(options.status === undefined ? 'pending' : options.status);
  return { status, limit, offset };
}

function validateNoteUpdatePatch(value) {
  return validateText(value);
}

function validateReminderUpdatePatch(value) {
  const patch = validateOptionsObject(value, 'Изменения напоминания');
  const keys = Object.keys(patch);
  if (!keys.length) throw new TypeError('Нужно указать хотя бы одно изменение напоминания.');
  for (const key of keys) {
    if (!['text', 'dueAt'].includes(key)) throw new TypeError(`Неизвестное изменение напоминания: ${key}.`);
  }
  const result = {};
  if (Object.hasOwn(patch, 'text')) result.text = validateText(patch.text);
  if (Object.hasOwn(patch, 'dueAt')) result.dueAt = validateTimestamp(patch.dueAt);
  return result;
}

function mutationResult({ found, changed, item = null }) {
  return { ok: found, found, changed, item };
}

/** Same on-disk schema and Unix-second timestamps as the original Python Store. */
export class Store {
  #db;
  constructor(dbPath) {
    if (typeof dbPath !== 'string' || !dbPath.trim() || dbPath === ':memory:') throw new TypeError('Нужен путь к постоянному файлу SQLite.');
    this.dbPath = resolve(dbPath);
    this.#db = new DatabaseSync(this.dbPath);
    this.#db.function('jeff_casefold', { deterministic: true }, value => typeof value === 'string' ? value.toLocaleLowerCase('ru-RU') : value);
    this.#db.exec(`PRAGMA busy_timeout = 10000;
      CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, due_at REAL NOT NULL, created_at REAL NOT NULL, delivered_at REAL);
      CREATE INDEX IF NOT EXISTS reminders_pending_due ON reminders(due_at, id) WHERE delivered_at IS NULL;`);
  }
  notes() { return this.#db.prepare('SELECT * FROM notes ORDER BY id').all().map(row => ({ ...row })); }
  pending() { return this.#db.prepare('SELECT * FROM reminders WHERE delivered_at IS NULL ORDER BY due_at, id').all().map(row => ({ ...row })); }
  due(now = Date.now() / 1000) { return this.#db.prepare('SELECT * FROM reminders WHERE delivered_at IS NULL AND due_at <= ? ORDER BY due_at, id').all(validateTimestamp(now)).map(row => ({ ...row })); }
  addNote(text) { return Number(this.#db.prepare('INSERT INTO notes(text, created_at) VALUES (?, ?)').run(validateText(text), Date.now() / 1000).lastInsertRowid); }
  addReminder(text, dueAt) { return Number(this.#db.prepare('INSERT INTO reminders(text, due_at, created_at) VALUES (?, ?, ?)').run(validateText(text), validateTimestamp(dueAt), Date.now() / 1000).lastInsertRowid); }
  completeReminder(id) { this.#db.prepare('UPDATE reminders SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(Date.now() / 1000, validateId(id)); }
  getNote(id) {
    const row = this.#db.prepare('SELECT * FROM notes WHERE id = ?').get(validateId(id));
    return row ? { ...row } : null;
  }
  searchNotes(query, options = {}) {
    const pattern = searchPattern(validateSearchQuery(query));
    const { limit, offset } = validatePageOptions(options);
    const where = 'jeff_casefold(text) LIKE ? ESCAPE \'\\\'';
    const total = Number(this.#db.prepare(`SELECT COUNT(*) AS total FROM notes WHERE ${where}`).get(pattern).total);
    const items = this.#db.prepare(`SELECT * FROM notes WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`).all(pattern, limit, offset).map(row => ({ ...row }));
    return { items, total, limit, offset };
  }
  updateNote(id, text) {
    const noteId = validateId(id);
    const nextText = validateNoteUpdatePatch(text);
    const current = this.getNote(noteId);
    if (!current) return mutationResult({ found: false, changed: false });
    if (current.text === nextText) return mutationResult({ found: true, changed: false, item: current });
    this.#db.prepare('UPDATE notes SET text = ? WHERE id = ?').run(nextText, noteId);
    return mutationResult({ found: true, changed: true, item: this.getNote(noteId) });
  }
  getReminder(id) {
    const row = this.#db.prepare('SELECT * FROM reminders WHERE id = ?').get(validateId(id));
    return row ? { ...row } : null;
  }
  searchReminders(query, options = {}) {
    const pattern = searchPattern(validateSearchQuery(query));
    const { status, limit, offset } = validateSearchReminderOptions(options);
    const statusClause = status === 'pending' ? ' AND delivered_at IS NULL' : status === 'delivered' ? ' AND delivered_at IS NOT NULL' : '';
    const where = `jeff_casefold(text) LIKE ? ESCAPE '\\'${statusClause}`;
    const total = Number(this.#db.prepare(`SELECT COUNT(*) AS total FROM reminders WHERE ${where}`).get(pattern).total);
    const items = this.#db.prepare(`SELECT * FROM reminders WHERE ${where} ORDER BY due_at, id LIMIT ? OFFSET ?`).all(pattern, limit, offset).map(row => ({ ...row }));
    return { items, total, status, limit, offset };
  }
  updateReminder(id, patch) {
    const reminderId = validateId(id);
    const changes = validateReminderUpdatePatch(patch);
    const current = this.getReminder(reminderId);
    if (!current) return mutationResult({ found: false, changed: false });
    if (Object.hasOwn(changes, 'dueAt') && current.delivered_at !== null) {
      throw new TypeError('Доставленное напоминание нельзя перенести: сначала создайте новое напоминание.');
    }
    const textChanged = Object.hasOwn(changes, 'text') && current.text !== changes.text;
    const dueChanged = Object.hasOwn(changes, 'dueAt') && current.due_at !== changes.dueAt;
    if (!textChanged && !dueChanged) return mutationResult({ found: true, changed: false, item: current });
    if (textChanged && dueChanged) {
      this.#db.prepare('UPDATE reminders SET text = ?, due_at = ? WHERE id = ?').run(changes.text, changes.dueAt, reminderId);
    } else if (textChanged) {
      this.#db.prepare('UPDATE reminders SET text = ? WHERE id = ?').run(changes.text, reminderId);
    } else {
      this.#db.prepare('UPDATE reminders SET due_at = ? WHERE id = ?').run(changes.dueAt, reminderId);
    }
    return mutationResult({ found: true, changed: true, item: this.getReminder(reminderId) });
  }
  deleteNote(id) {
    const noteId = validateId(id);
    const deleted = Number(this.#db.prepare('DELETE FROM notes WHERE id = ?').run(noteId).changes) > 0;
    return deleted;
  }
  deleteReminder(id) {
    const reminderId = validateId(id);
    const deleted = Number(this.#db.prepare('DELETE FROM reminders WHERE id = ?').run(reminderId).changes) > 0;
    return deleted;
  }
  close() { if (this.#db) { this.#db.close(); this.#db = null; } }
}
