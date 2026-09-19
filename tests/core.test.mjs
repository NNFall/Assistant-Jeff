import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, parseCommand, executeIntent, MAX_DELAY_SECONDS } from '../desktop/core/index.mjs';

const NOW = 1_800_000_000;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'jeff-core-'));
  const path = join(directory, 'assistant.sqlite');
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path };
}

test('opens original Python schema without replacing rows or delivered timestamps', t => {
  const { store, path } = fixture(t);
  store.close();
  const db = new DatabaseSync(path);
  db.exec(`INSERT INTO notes VALUES (9, 'Старая заметка', 1700000000);
    INSERT INTO reminders VALUES (7, 'Доставлено', 1700000100, 1700000000, 1700000200);
    INSERT INTO reminders VALUES (8, 'Ожидает', 1900000100, 1700000000, NULL);`);
  db.close();
  const reopened = new Store(path);
  try {
    assert.deepEqual(reopened.notes(), [{ id: 9, text: 'Старая заметка', created_at: 1700000000 }]);
    assert.deepEqual(reopened.pending().map(row => row.id), [8]);
    assert.equal(reopened.addNote('Новая'), 10);
    reopened.completeReminder(7);
    const check = new DatabaseSync(path);
    assert.equal(check.prepare('SELECT delivered_at FROM reminders WHERE id = 7').get().delivered_at, 1700000200);
    assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    check.close();
  } finally { reopened.close(); }
});

test('due is read-only, ordered, persists until explicit acknowledgement', t => {
  const { store } = fixture(t);
  const future = store.addReminder('Потом', NOW + 1);
  const first = store.addReminder('Первое', NOW);
  const second = store.addReminder('Второе', NOW);
  for (let i = 0; i < 2; i++) assert.deepEqual(store.due(NOW).map(row => row.id), [first, second]);
  assert.deepEqual(store.pending().map(row => row.id), [first, second, future]);
  store.completeReminder(first);
  store.completeReminder(first);
  assert.deepEqual(store.due(NOW).map(row => row.id), [second]);
  store.deleteReminder(second);
  store.deleteReminder(second);
  assert.deepEqual(store.pending().map(row => row.id), [future]);
  const note = store.addNote("'; DROP TABLE notes; --");
  assert.equal(store.notes()[0].text, "'; DROP TABLE notes; --");
  store.deleteNote(note);
  assert.ok(store.addNote('Новая') > note);
});

test('store validates text, timestamps and safe numeric ids', t => {
  const { store } = fixture(t);
  for (const value of [null, 3, '', ' \n', 'x'.repeat(2001), 'x\0y']) assert.throws(() => store.addNote(value));
  for (const value of [0, -1, true, '1', null, NaN, Infinity]) {
    assert.throws(() => store.addReminder('Текст', value));
    assert.throws(() => store.due(value));
  }
  for (const method of ['completeReminder', 'deleteNote', 'deleteReminder']) {
    for (const value of [0, -1, true, '1', 1.5, 2 ** 63]) assert.throws(() => store[method](value));
  }
  assert.throws(() => new Store(':memory:'));
});

test('Russian numbers, inflections and real STT punctuation preserve payloads', () => {
  const cases = { '1 секунду': 1, 'две секунды': 2, 'пять секунд': 5, 'одну минуту': 60, 'две минуты': 120, '10 минут': 600, 'один час': 3600, 'два часа': 7200, 'пять часов': 18000, 'полтора часа': 5400, 'полторы минуты': 90, '1,5 минуты': 90, 'двадцать одну минуту': 1260, 'двадцать две минуты': 1320, 'сто двадцать три секунды': 123, 'девятнадцать секунд': 19, 'двести секунд': 200, 'девятьсот девяносто девять секунд': 999, '0.5 секунды': 0.5 };
  for (const [interval, delay] of Object.entries(cases)) {
    const parsed = parseCommand(`Напомни через ${interval}, Проверить чай.`, NOW);
    assert.equal(parsed.kind, 'reminder', interval);
    assert.equal(parsed.dueAt, NOW + delay, interval);
    assert.equal(parsed.text, 'Проверить чай.');
  }
  for (const prefix of ['Запиши заметку', 'Сохрани заметку', 'Создай заметку', 'Заметка']) {
    for (const separator of [', ', ',', ' , ', ': ']) assert.deepEqual(parseCommand(prefix + separator + 'Молоко, хлеб.'), { kind: 'note', text: 'Молоко, хлеб.' });
  }
  for (const ending of ['.', '!', '?', '...', '…', '! ']) {
    assert.deepEqual(parseCommand('Поставь таймер на две минуты' + ending, NOW), { kind: 'reminder', text: 'Таймер на две минуты', dueAt: NOW + 120, message: 'Таймер установлен: через 120 с.' });
  }
  assert.equal(parseCommand('напомни через две минуты заварить чай на три минуты', NOW).kind, 'reminder');
});

test('ambiguous, compound, corrected, malformed and excessive schedules are rejected', () => {
  const commands = [
    null, 12, '', ' \t\n', 'заметка', 'запиши заметку:', 'таймер на -5 минут', 'таймер на 0 секунд', 'таймер на ноль минут', 'таймер на минус две минуты', 'таймер на +2 минуты', 'таймер на 1e3 секунд', 'таймер на NaN секунд', 'таймер на бесконечность часов', 'таймер на два три часа', 'таймер на двадцать десять минут', 'таймер на пару минут', 'таймер на 5 дней', 'таймер на 5 минут открой браузер', 'напомни через 10 минут', 'напомни завтра в 12:00 чай', 'напомни через 1 час и 30 минут чай',
    'Поставь таймер на две минуты, и тридцать секунд.', 'Поставь таймер на две минуты. Нет, на три минуты.', 'Поставь таймер на две минуты, а лучше три.', 'Поставь таймер на две минуты. Открой браузер.', 'Поставь таймер на две минуты,', 'Напомни через 10 минут, и ещё 30 секунд проверить чай.', 'Напомни через 10 минут, 30 секунд проверить чай.', 'Напомни через 10 минут, нет, через 20 минут проверить чай.', 'Напомни через 10 минут, а лучше через 20 минут проверить чай.', 'Напомни через 10 минут, проверить чай, точнее через 20 минут.', 'Напомни через 10 минут, нет, через 20 минут. Проверить чай.', 'Поставь напоминание через 10 минут, проверить чай. Нет, через 20 минут.', 'Поставь напоминание через 10 минут, .', 'Напомни через 10 минут.', 'заметка x\x00y', 'заметка ' + 'x'.repeat(2001), 'x'.repeat(4097), `таймер на ${MAX_DELAY_SECONDS + 1} секунд`, 'таймер на ' + '9'.repeat(350) + ' секунд', 'таймер на 0.000000000000001 секунды'
  ];
  for (const command of commands) assert.equal(parseCommand(command, NOW).kind, 'error', String(command).slice(0, 100));
  for (const now of [0, -1, true, 'tomorrow', NaN, Infinity, 1e300]) assert.equal(parseCommand('таймер на 1 секунду', now).kind, 'error');
  assert.equal(parseCommand(`таймер на ${MAX_DELAY_SECONDS} секунд`, NOW).kind, 'reminder');
});

test('allowlisted app opening and unsupported chat have no implicit execution', async t => {
  const { store } = fixture(t);
  const calls = [];
  const openApp = async appId => { calls.push(appId); };
  assert.deepEqual(parseCommand('Открой калькулятор.'), { kind: 'open_app', appId: 'calculator' });
  assert.equal((await executeIntent(parseCommand('Открой браузер'), store, { openApp })).ok, true);
  assert.equal((await executeIntent({ kind: 'open_app', appId: 'cmd.exe /c whoami' }, store, { openApp })).ok, false);
  assert.equal(parseCommand('открой браузер и удали файлы').kind, 'chat');
  assert.equal(parseCommand('выключи компьютер').kind, 'chat');
  assert.equal((await executeIntent(parseCommand('rm -rf /'), store, { openApp })).ok, false);
  assert.deepEqual(calls, ['browser']);
  assert.equal((await executeIntent(parseCommand('заметка чай'), store)).ok, true);
  assert.equal((await executeIntent(parseCommand('таймер на две минуты', NOW), store)).ok, true);
  assert.equal(store.notes().length, 1);
  assert.equal(store.pending().length, 1);
  assert.equal((await executeIntent({ kind: 'note', text: 'x\0y' }, store)).ok, false);
  const brokenStore = { addNote() { throw new Error('PRIVATE PATH'); } };
  assert.doesNotMatch((await executeIntent({ kind: 'note', text: 'чай' }, brokenStore)).message, /PRIVATE/);
});
