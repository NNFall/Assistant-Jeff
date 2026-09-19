import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

export const MAX_TEXT_LENGTH = 2000;
export const MAX_COMMAND_LENGTH = 4096;
export const MAX_DELAY_SECONDS = 365 * 24 * 60 * 60;
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

/** Same on-disk schema and Unix-second timestamps as the original Python Store. */
export class Store {
  #db;
  constructor(dbPath) {
    if (typeof dbPath !== 'string' || !dbPath.trim() || dbPath === ':memory:') throw new TypeError('Нужен путь к постоянному файлу SQLite.');
    this.dbPath = resolve(dbPath);
    this.#db = new DatabaseSync(this.dbPath);
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
  deleteNote(id) { this.#db.prepare('DELETE FROM notes WHERE id = ?').run(validateId(id)); }
  deleteReminder(id) { this.#db.prepare('DELETE FROM reminders WHERE id = ?').run(validateId(id)); }
  close() { if (this.#db) { this.#db.close(); this.#db = null; } }
}
