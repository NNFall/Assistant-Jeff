import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../desktop/core/store.mjs';
import { createDataTools } from '../desktop/agent/data-tools.mjs';

const NOW_MS = Date.parse('2026-09-20T10:00:00.000Z');
const DUE = '2026-09-20T16:00:00+04:00';
const DUE_NEXT = '2026-09-21T16:00:00+04:00';

function fixture(t, storeOverride) {
  const directory = mkdtempSync(join(tmpdir(), 'jeff-data-tools-'));
  const store = storeOverride ?? new Store(join(directory, 'assistant.sqlite'));
  t.after(() => {
    store.close?.();
    rmSync(directory, { recursive: true, force: true });
  });
  const tools = createDataTools({ store, now: () => NOW_MS });
  return { store, tools: Object.fromEntries(tools.map(tool => [tool.name, tool])) };
}

test('data tool descriptors expose the fixed typed surface and effect flags', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jeff-data-tools-contract-'));
  const store = new Store(join(directory, 'assistant.sqlite'));
  try {
    const tools = createDataTools({ store, now: () => NOW_MS });
    assert.deepEqual(tools.map(tool => tool.name), [
      'notes_search', 'note_get', 'note_create', 'note_update', 'note_delete',
      'reminders_search', 'reminder_get', 'reminder_create', 'reminder_update', 'reminder_delete', 'reminder_complete',
      'clock_now', 'time_resolve',
    ]);
    for (const tool of tools) {
      assert.equal(typeof tool.title, 'string');
      assert.equal(typeof tool.description, 'string');
      assert.equal(typeof tool.execute, 'function');
      assert.equal(typeof tool.parameters, 'object');
      assert.equal(tool.parameters.type, 'object');
      assert.equal(tool.parameters.additionalProperties, false);
    }
    assert.equal(tools.find(tool => tool.name === 'notes_search').effect, false);
    assert.equal(tools.find(tool => tool.name === 'note_create').effect, true);
    assert.equal(tools.find(tool => tool.name === 'clock_now').effect, false);
    const update = tools.find(tool => tool.name === 'reminder_update').parameters;
    assert.deepEqual(update.required, ['id', 'expectedText', 'expectedDueAt']);
    assert.equal(update.properties.dueAt.format, 'date-time');
    assert.match(update.properties.dueAt.description, /явн/iu);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('notes create/search/get/update/delete use readback and run-scoped target guards', async t => {
  const { store, tools } = fixture(t);
  const created = await tools.note_create.execute({ text: 'купить молоко; 100% готово' });
  assert.equal(created.ok, true);
  assert.equal(created.verified, true);
  assert.equal(created.effectAttempted, true);
  assert.equal(created.evidence, 'note_created');
  assert.equal(created.data.text, 'купить молоко; 100% готово');
  const id = created.data.id;

  const searched = await tools.notes_search.execute({ query: '100%', limit: 10, offset: 0 });
  assert.deepEqual(searched.data.items.map(item => item.id), [id]);
  assert.equal(searched.data.total, 1);
  assert.equal(searched.data.limit, 10);
  assert.equal(searched.data.offset, 0);
  const read = await tools.note_get.execute({ id });
  assert.equal(read.evidence, 'note_read');
  assert.equal(read.data.text, created.data.text);

  const updated = await tools.note_update.execute({ id, text: 'купить молоко и хлеб', expectedText: created.data.text });
  assert.equal(updated.ok, true);
  assert.equal(updated.verified, true);
  assert.equal(updated.effectAttempted, true);
  assert.equal(updated.data.text, 'купить молоко и хлеб');

  const stale = await tools.note_update.execute({ id, text: 'не применять', expectedText: created.data.text });
  assert.equal(stale.ok, false);
  assert.equal(stale.verified, false);
  assert.equal(stale.effectAttempted, false);
  assert.equal(stale.evidence, 'stale_target');
  assert.equal(store.getNote(id).text, 'купить молоко и хлеб');

  const deleted = await tools.note_delete.execute({ id, expectedText: 'купить молоко и хлеб' });
  assert.deepEqual(deleted, {
    ok: true, verified: true, effectAttempted: true, evidence: 'note_deleted', message: 'Заметка удалена.', data: null,
  });
  assert.equal(store.getNote(id), null);

  const nextRun = fixture(t);
  const notRead = await nextRun.tools.note_update.execute({ id, text: 'обойти защиту', expectedText: 'купить молоко и хлеб' });
  assert.equal(notRead.ok, false);
  assert.equal(notRead.evidence, 'target_not_read');
});

test('note mutations stop before effect on abort and malformed arguments', async t => {
  const { store, tools } = fixture(t);
  const controller = new AbortController();
  controller.abort();
  const stopped = await tools.note_create.execute({ text: 'не сохранять' }, { signal: controller.signal });
  assert.equal(stopped.evidence, 'aborted');
  assert.equal(stopped.effectAttempted, false);
  assert.equal(store.notes().length, 0);

  for (const args of [{}, { text: '' }, { text: 'x\0y' }, { text: 'x', extra: true }]) {
    const result = await tools.note_create.execute(args);
    assert.equal(result.ok, false);
    assert.equal(result.evidence, 'invalid_args');
    assert.equal(result.effectAttempted, false);
  }
});

test('reminder dates require explicit timezone and future bound, while expectedDueAt can verify old rows', async t => {
  const { store, tools } = fixture(t);
  for (const dueAt of [
    '2026-09-20T12:00:00',
    'tomorrow at 12:00',
    '2026-09-20T09:59:59Z',
    '2027-09-22T10:00:00Z',
    '2026-02-30T10:00:00Z',
  ]) {
    const result = await tools.reminder_create.execute({ text: 'не создавать', dueAt });
    assert.equal(result.ok, false, dueAt);
    assert.equal(result.evidence, 'invalid_args', dueAt);
    assert.equal(result.effectAttempted, false, dueAt);
  }
  const created = await tools.reminder_create.execute({ text: 'проверить чай', dueAt: DUE });
  assert.equal(created.ok, true);
  assert.equal(created.data.due_at, Date.parse(DUE) / 1000);
  assert.equal(created.data.dueAt, new Date(Date.parse(DUE)).toISOString());
  assert.equal(created.data.expectedDueAt, created.data.dueAt);
  const id = created.data.id;

  const listed = await tools.reminders_search.execute({ query: 'чай', status: 'pending' });
  assert.equal(listed.data.items[0].id, id);
  assert.equal(listed.data.items[0].expectedDueAt, created.data.expectedDueAt);
  const read = await tools.reminder_get.execute({ id });
  assert.equal(read.data.dueAt, created.data.dueAt);
  assert.equal(read.data.expectedDueAt, created.data.expectedDueAt);
  const updated = await tools.reminder_update.execute({
    id, text: 'проверить чай вечером', expectedText: read.data.text, expectedDueAt: read.data.expectedDueAt, dueAt: DUE_NEXT,
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.evidence, 'reminder_updated');
  assert.equal(updated.data.due_at, Date.parse(DUE_NEXT) / 1000);
  assert.equal(updated.data.expectedDueAt, new Date(Date.parse(DUE_NEXT)).toISOString());
});

test('reminder update/delete/complete require current text and due guards', async t => {
  const { store, tools } = fixture(t);
  const created = await tools.reminder_create.execute({ text: 'позвонить', dueAt: DUE });
  const id = created.data.id;
  const read = await tools.reminder_get.execute({ id });

  const staleText = await tools.reminder_update.execute({ id, text: 'не применять', expectedText: 'другой текст', expectedDueAt: read.data.expectedDueAt });
  assert.equal(staleText.evidence, 'stale_target');
  const staleDue = await tools.reminder_update.execute({ id, dueAt: DUE_NEXT, expectedText: read.data.text, expectedDueAt: DUE_NEXT });
  assert.equal(staleDue.evidence, 'stale_target');
  assert.equal(store.getReminder(id).due_at, Date.parse(DUE) / 1000);

  const completed = await tools.reminder_complete.execute({ id, expectedText: read.data.text, expectedDueAt: read.data.expectedDueAt });
  assert.equal(completed.ok, true);
  assert.equal(completed.verified, true);
  assert.equal(completed.evidence, 'reminder_completed');
  assert.equal(completed.data.delivered_at > 0, true);

  const already = await tools.reminder_complete.execute({ id, expectedText: read.data.text, expectedDueAt: read.data.expectedDueAt });
  assert.equal(already.evidence, 'already_completed');
  assert.equal(already.effectAttempted, false);

  const deleted = await tools.reminder_delete.execute({ id, expectedText: read.data.text, expectedDueAt: read.data.expectedDueAt });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.evidence, 'reminder_deleted');
  assert.equal(deleted.data, null);
  assert.equal(store.getReminder(id), null);
});

test('delivered reminder cannot be silently rescheduled, and fresh runs must reread ids', async t => {
  const { store, tools } = fixture(t);
  const created = await tools.reminder_create.execute({ text: 'готово', dueAt: DUE });
  const id = created.data.id;
  const read = await tools.reminder_get.execute({ id });
  assert.equal((await tools.reminder_complete.execute({ id, expectedText: read.data.text, expectedDueAt: read.data.expectedDueAt })).ok, true);
  const delivered = await tools.reminder_get.execute({ id });
  assert.equal(delivered.data.expectedDueAt, read.data.expectedDueAt);
  const moved = await tools.reminder_update.execute({ id, expectedText: delivered.data.text, expectedDueAt: delivered.data.expectedDueAt, dueAt: DUE_NEXT });
  assert.equal(moved.ok, false);
  assert.equal(moved.evidence, 'delivered_due_immutable');
  assert.equal(store.getReminder(id).due_at, Date.parse(DUE) / 1000);

  const fresh = fixture(t);
  const missingRead = await fresh.tools.reminder_delete.execute({ id, expectedText: delivered.data.text, expectedDueAt: delivered.data.expectedDueAt });
  assert.equal(missingRead.evidence, 'target_not_read');
});

test('abort raised during a synchronous create does not discard confirmed receipt', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'jeff-data-tools-abort-receipt-'));
  const base = new Store(join(directory, 'assistant.sqlite'));
  const controller = new AbortController();
  const store = {
    addNote(text) { const id = base.addNote(text); controller.abort(); return id; },
    getNote: base.getNote.bind(base),
    notes: base.notes.bind(base),
    close: base.close.bind(base),
  };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const tools = Object.fromEntries(createDataTools({ store, now: () => NOW_MS }).map(tool => [tool.name, tool]));
  const result = await tools.note_create.execute({ text: 'сохранить несмотря на Stop' }, { signal: controller.signal });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.effectAttempted, true);
  assert.equal(result.evidence, 'note_created');
  assert.equal(result.data.text, 'сохранить несмотря на Stop');
});

test('clock_now returns localISO, timezone and UTC without using guessed reminder dates', async t => {
  const { tools } = fixture(t);
  const result = await tools.clock_now.execute({});
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.effectAttempted, false);
  assert.equal(result.evidence, 'clock_read');
  assert.equal(result.data.utcISO, new Date(NOW_MS).toISOString());
  assert.equal(typeof result.data.timeZone, 'string');
  assert.match(result.data.localISO, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/u);
});

test('time_resolve calculates explicit relative and calendar times in local timezone', async t => {
  const { tools } = fixture(t);
  const relative = await tools.time_resolve.execute({ mode: 'relative', amount: 90, unit: 'minutes' });
  assert.equal(relative.ok, true);
  assert.equal(relative.verified, true);
  assert.equal(relative.effectAttempted, false);
  assert.equal(relative.evidence, 'time_resolved');
  assert.equal(Date.parse(relative.data.dueAt), NOW_MS + 90 * 60 * 1000);
  assert.equal(typeof relative.data.display, 'string');
  assert.equal(typeof relative.data.timeZone, 'string');

  const calendar = await tools.time_resolve.execute({ mode: 'calendar', dayOffset: 0, time: '14:20' });
  assert.equal(calendar.ok, true);
  assert.equal(Date.parse(calendar.data.dueAt) > NOW_MS, true);
  assert.match(calendar.data.dueAt, /T14:20:00(?:\.000)?[+-]\d{2}:\d{2}$/u);

  const explicitDate = await tools.time_resolve.execute({ mode: 'calendar', date: '2026-09-21', time: '14:20' });
  assert.equal(explicitDate.ok, true);
  assert.match(explicitDate.data.dueAt, /2026-09-21T14:20:00(?:\.000)?[+-]\d{2}:\d{2}$/u);
});

test('time_resolve rejects missing or conflicting components, past dates, invalid calendars and DST rollover', async t => {
  const { tools } = fixture(t);
  for (const args of [
    {},
    { mode: 'relative', amount: 0, unit: 'minutes' },
    { mode: 'relative', amount: 2, unit: 'weeks' },
    { mode: 'relative', amount: 2, unit: 'hours', time: '12:00' },
    { mode: 'calendar', date: '2026-09-21' },
    { mode: 'calendar', date: '2026-09-21', dayOffset: 1, time: '14:00' },
    { mode: 'calendar', dayOffset: 367, time: '14:00' },
    { mode: 'calendar', date: '2026-02-30', time: '14:00' },
    { mode: 'calendar', date: '2026-09-19', time: '14:00' },
    { mode: 'calendar', date: '2026-09-21', time: '24:00' },
  ]) {
    const result = await tools.time_resolve.execute(args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.evidence, 'invalid_args', JSON.stringify(args));
    assert.equal(result.effectAttempted, false, JSON.stringify(args));
  }
});
