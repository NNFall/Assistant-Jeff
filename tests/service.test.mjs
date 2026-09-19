import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantService } from '../desktop/service.mjs';

function fixture(options = {}) {
  const notes = [], reminders = [], apps = [], routeCalls = [], chatCalls = [];
  const store = {
    addNote(text) { notes.push(text); return notes.length; },
    addReminder(text, dueAt) { reminders.push({ text, dueAt }); return reminders.length; },
    pending() { return reminders; }
  };
  const service = new AssistantService({
    store,
    settings: () => ({ cloudEnabled: true }),
    keys: () => ({ typesafe: 'fake-test-key' }),
    route: async (text, options) => { routeCalls.push({ text, options }); return { route: 'unknown' }; },
    chat: async text => { chatCalls.push(text); return { text: 'Ответ', model: 'test-model' }; },
    openApp: async appId => { apps.push(appId); },
    ...options
  });
  return { service, notes, reminders, apps, routeCalls, chatCalls };
}

test('Jev sees even exact local requests, uncertainty never executes or invokes chat', async () => {
  const f = fixture();
  const answer = await f.service.execute('заметка чай');
  assert.equal(answer.ok, false);
  assert.equal(answer.kind, 'unknown');
  assert.equal(answer.route, 'jev');
  assert.ok(Number.isFinite(answer.latencyMs));
  assert.equal(f.routeCalls.length, 1);
  assert.deepEqual(f.routeCalls[0], { text: 'заметка чай', options: { apiKey: 'fake-test-key' } });
  assert.deepEqual(f.notes, []);
  assert.deepEqual(f.chatCalls, []);
});

test('only agreed local intent or conservative source span may change notes', async () => {
  const f = fixture({ route: async () => ({ route: 'note', text: 'Invented body' }) });
  assert.equal((await f.service.execute('заметка Не покупать хлеб.')).ok, true);
  assert.equal((await f.service.execute('запомни, что чай лежит в шкафу')).ok, true);
  assert.deepEqual(f.notes, ['Не покупать хлеб.', 'чай лежит в шкафу']);
  assert.equal((await f.service.execute('не сохраняй заметку чай')).ok, false);
  assert.equal((await f.service.execute('расскажи о заметках')).ok, false);
  assert.equal(f.notes.length, 2);
});

test('reminders use exact local durations, never model fabricated times', async () => {
  const f = fixture({ route: async () => ({ route: 'reminder', dueAt: 1, text: 'Invented' }) });
  const before = Date.now() / 1000;
  assert.equal((await f.service.execute('напомни через две минуты проверить чай')).ok, true);
  assert.equal(f.reminders[0].text, 'проверить чай');
  assert.ok(f.reminders[0].dueAt >= before + 120);
  assert.ok(f.reminders[0].dueAt <= Date.now() / 1000 + 120);
  assert.equal((await f.service.execute('надо будет вспомнить о чае')).ok, false);
  assert.equal(f.reminders.length, 1);
});

test('app launch requires allowlisted matching explicit non-negated request', async () => {
  const f = fixture({ route: async () => ({ route: 'open_app', appId: 'browser' }) });
  assert.equal((await f.service.execute('пожалуйста, открой браузер')).ok, true);
  assert.equal((await f.service.execute('можешь открыть браузер?')).ok, true);
  for (const text of ['не открывай браузер', 'открой браузер, нет, не надо', 'открой браузер и блокнот', 'открой калькулятор', 'скажи что такое браузер']) assert.equal((await f.service.execute(text)).ok, false, text);
  assert.deepEqual(f.apps, ['browser', 'browser']);
  const bad = fixture({ route: async () => ({ route: 'open_app', appId: 'cmd.exe' }) });
  assert.equal((await bad.service.execute('открой браузер')).ok, false);
  assert.deepEqual(bad.apps, []);
});

test('provider outage falls back only to exact safe parsed tool commands', async () => {
  const f = fixture({ route: async () => { throw new Error('SECRET network credentials'); } });
  const note = await f.service.execute('заметка чай');
  assert.equal(note.ok, true);
  assert.equal(note.route, 'local-fallback');
  const answer = await f.service.execute('не сохраняй заметку чай');
  assert.equal(answer.ok, false);
  assert.doesNotMatch(answer.message, /SECRET/);
  assert.deepEqual(f.notes, ['чай']);
  assert.deepEqual(f.chatCalls, []);
});

test('invalid input, help and reminder list are handled locally without cloud calls', async () => {
  const f = fixture();
  for (const text of [null, '', 'x'.repeat(4097), 'note\0text', 'таймер на -5 минут', 'напомни через 5 минут и 30 секунд чай']) assert.equal((await f.service.execute(text)).ok, false);
  assert.equal((await f.service.execute('помощь')).ok, true);
  assert.match((await f.service.execute('покажи напоминания')).message, /пока нет/);
  assert.equal(f.routeCalls.length, 0);
  assert.equal(f.chatCalls.length, 0);
});

test('cloud setting controls data egress; chat receives current command only', async () => {
  const off = fixture({ settings: () => ({ cloudEnabled: false }) });
  assert.equal((await off.service.execute('заметка чай')).ok, true);
  assert.equal((await off.service.execute('Как дела?')).ok, false);
  assert.equal(off.routeCalls.length, 0);
  assert.equal(off.chatCalls.length, 0);
  const on = fixture({ route: async () => ({ route: 'chat' }) });
  assert.equal((await on.service.execute('Как дела?')).message, 'Ответ');
  assert.deepEqual(on.chatCalls, ['Как дела?']);
  // Local intent disagreement asks for clarification instead of chatting.
  assert.equal((await on.service.execute('заметка чай')).kind, 'unknown');
  assert.deepEqual(on.notes, []);
  const broken = fixture({ route: async () => ({ route: 'chat' }), chat: async () => { throw new Error('SECRET'); } });
  assert.doesNotMatch((await broken.service.execute('Как дела?')).message, /SECRET/);
});

test('pre-aborted commands never route, save, launch or chat', async () => {
  const f = fixture();
  const signal = AbortSignal.abort();
  for (const text of ['заметка чай', 'открой браузер', 'Как дела?', 'покажи напоминания']) {
    const answer = await f.service.execute(text, { signal });
    assert.equal(answer.ok, false);
    assert.equal(answer.message, 'Команда отменена.');
  }
  assert.deepEqual(f.routeCalls, []);
  assert.deepEqual(f.notes, []);
  assert.deepEqual(f.apps, []);
  assert.deepEqual(f.chatCalls, []);
});

test('abort during successful or failed provider request suppresses effects and fallback', async () => {
  for (const failed of [false, true]) {
    for (const [text, route, appId] of [['заметка чай', 'note'], ['открой браузер', 'open_app', 'browser'], ['Как дела?', 'chat']]) {
      const controller = new AbortController();
      const f = fixture({ route: async (command, { signal }) => {
        assert.equal(signal, controller.signal);
        controller.abort();
        if (failed) throw new Error('Aborted private request');
        return { route, appId };
      } });
      assert.equal((await f.service.execute(text, { signal: controller.signal })).message, 'Команда отменена.');
      assert.deepEqual(f.notes, []);
      assert.deepEqual(f.apps, []);
      assert.deepEqual(f.chatCalls, []);
    }
  }
});

test('abort during chat suppresses successful answer and failure details', async () => {
  for (const failed of [false, true]) {
    const controller = new AbortController();
    const f = fixture({ route: async () => ({ route: 'chat' }), chat: async (text, { signal }) => {
      assert.equal(signal, controller.signal);
      controller.abort();
      if (failed) throw new Error('SECRET aborted chat');
      return { text: 'Stale response' };
    } });
    const answer = await f.service.execute('Как дела?', { signal: controller.signal });
    assert.equal(answer.ok, false);
    assert.equal(answer.message, 'Команда отменена.');
  }
});

test('imperative note content and quoted instructions never launch applications', async () => {
  const f = fixture({ route: async () => ({ route: 'note' }) });
  assert.equal((await f.service.execute('заметка «открой браузер» — пример команды')).ok, true);
  assert.deepEqual(f.notes, ['«открой браузер» — пример команды']);
  assert.deepEqual(f.apps, []);
  const confused = fixture({ route: async () => ({ route: 'open_app', appId: 'browser' }) });
  for (const text of ['заметка открой браузер', '«открой браузер»', 'расскажи про команду открой браузер']) {
    assert.equal((await confused.service.execute(text)).ok, false);
  }
  assert.deepEqual(confused.apps, []);
});
