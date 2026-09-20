import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, MAX_PAGE_SIZE } from '../desktop/core/store.mjs';

const BASE_TIME = 1_900_000_000;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'jeff-store-management-'));
  const store = new Store(join(directory, 'assistant.sqlite'));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

test('note get/update/delete report exact state and preserve literal text', t => {
  const store = fixture(t);
  const literal = "Проверка 100%_готово \\ путь; '; DROP TABLE notes; --";
  const id = store.addNote(literal);

  assert.deepEqual(store.getNote(id), { id, text: literal, created_at: store.getNote(id).created_at });
  assert.equal(store.searchNotes('%').items[0].id, id);
  assert.equal(store.searchNotes('_').items[0].id, id);
  assert.equal(store.searchNotes('\\').items[0].id, id);
  assert.equal(store.searchNotes('DROP TABLE').items[0].text, literal);

  const updated = store.updateNote(id, 'Сохранить, включая запятые!');
  assert.equal(updated.ok, true);
  assert.equal(updated.found, true);
  assert.equal(updated.changed, true);
  assert.equal(updated.item.text, 'Сохранить, включая запятые!');
  assert.deepEqual(store.updateNote(id, 'Сохранить, включая запятые!'), {
    ok: true,
    found: true,
    changed: false,
    item: updated.item,
  });

  assert.deepEqual(store.updateNote(999, 'Нет такой записи'), { ok: false, found: false, changed: false, item: null });
  assert.equal(store.deleteNote(id), true);
  assert.equal(store.getNote(id), null);
  assert.equal(store.deleteNote(id), false);
});

test('note search has literal matching, deterministic pagination and visible total coverage', t => {
  const store = fixture(t);
  const ids = [1, 2, 3, 4, 5].map(number => store.addNote(`элемент ${number}`));
  store.addNote('другая запись');

  assert.deepEqual(store.searchNotes('элемент', { limit: 2, offset: 0 }), {
    items: store.notes().slice(0, 2), total: 5, limit: 2, offset: 0,
  });
  assert.deepEqual(store.searchNotes('элемент', { limit: 2, offset: 2 }).items.map(item => item.id), ids.slice(2, 4));
  assert.deepEqual(store.searchNotes('элемент', { limit: 2, offset: 4 }).items.map(item => item.id), ids.slice(4));
  assert.equal(store.searchNotes('элемент', { limit: 2, offset: 5 }).items.length, 0);
  assert.equal(store.searchNotes('').total, 6);

  for (const options of [{ limit: 0 }, { limit: MAX_PAGE_SIZE + 1 }, { limit: 1.5 }, { limit: '2' }, { offset: -1 }, { offset: 1.5 }, { offset: '2' }, { page: 2 }]) {
    assert.throws(() => store.searchNotes('элемент', options));
  }
  for (const query of [null, 3, 'x\0y', 'x'.repeat(2001)]) assert.throws(() => store.searchNotes(query));
});

test('note and reminder search folds Cyrillic case while preserving literal wildcards', t => {
  const store = fixture(t);
  const noteId = store.addNote('ПоЕздКА Ёлка');
  const reminderId = store.addReminder('ЁЖИК и ПоЕздКА', 1_900_000_100);
  assert.deepEqual(store.searchNotes('поездка').items.map(item => item.id), [noteId]);
  assert.deepEqual(store.searchNotes('ёлка').items.map(item => item.id), [noteId]);
  assert.deepEqual(store.searchReminders('ёжик').items.map(item => item.id), [reminderId]);
  assert.deepEqual(store.searchReminders('ПОЕЗДКА').items.map(item => item.id), [reminderId]);
});

test('reminder get/search/update keeps pending and delivered policy explicit', t => {
  const store = fixture(t);
  const pendingId = store.addReminder('проверить чай', BASE_TIME + 60);
  const deliveredId = store.addReminder('уже сообщено', BASE_TIME + 120);
  store.completeReminder(deliveredId);

  assert.equal(store.getReminder(999), null);
  assert.deepEqual(store.searchReminders('чай').items.map(item => item.id), [pendingId]);
  assert.deepEqual(store.searchReminders('', { status: 'pending' }).items.map(item => item.id), [pendingId]);
  assert.deepEqual(store.searchReminders('', { status: 'delivered' }).items.map(item => item.id), [deliveredId]);
  assert.deepEqual(store.searchReminders('', { status: 'all' }).items.map(item => item.id), [pendingId, deliveredId]);

  const rescheduled = store.updateReminder(pendingId, { text: 'проверить чай после обеда', dueAt: BASE_TIME + 3600 });
  assert.equal(rescheduled.ok, true);
  assert.equal(rescheduled.found, true);
  assert.equal(rescheduled.changed, true);
  assert.equal(rescheduled.item.text, 'проверить чай после обеда');
  assert.equal(rescheduled.item.due_at, BASE_TIME + 3600);
  assert.equal(rescheduled.item.delivered_at, null);

  const deliveredText = store.updateReminder(deliveredId, { text: 'сообщено повторно' });
  assert.equal(deliveredText.changed, true);
  assert.equal(deliveredText.item.delivered_at > 0, true);
  assert.throws(() => store.updateReminder(deliveredId, { dueAt: BASE_TIME + 7200 }), /нельзя перенести/u);
  assert.equal(store.getReminder(deliveredId).due_at, BASE_TIME + 120);

  assert.deepEqual(store.updateReminder(999, { text: 'нет такого' }), { ok: false, found: false, changed: false, item: null });
  assert.equal(store.deleteReminder(deliveredId), true);
  assert.equal(store.deleteReminder(deliveredId), false);
});

test('reminder search and update validate arguments without changing schema', t => {
  const store = fixture(t);
  const id = store.addReminder('безопасная запись 50%_x', BASE_TIME);
  assert.equal(store.searchReminders('%').items[0].id, id);
  assert.equal(store.searchReminders('_').items[0].id, id);
  assert.equal(store.searchReminders('50%_x').items[0].id, id);

  for (const options of [{ status: 'unknown' }, { status: 'pending', page: 2 }, { limit: 0 }, { offset: -1 }]) {
    assert.throws(() => store.searchReminders('', options));
  }
  for (const patch of [{}, null, { text: '' }, { text: 'x\0y' }, { dueAt: 0 }, { due_at: BASE_TIME }, { text: 'x', dueAt: 'later' }]) {
    assert.throws(() => store.updateReminder(id, patch));
  }
  const noteId = store.addNote('валидная заметка');
  assert.throws(() => store.updateNote(noteId, ''));
});
