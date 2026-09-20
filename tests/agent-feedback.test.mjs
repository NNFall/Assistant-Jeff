import test from 'node:test';
import assert from 'node:assert/strict';
import {describeResult} from '../desktop/automation/feedback.mjs';

const call = (id = 'tool_volume_1', effect = true) => ({
  phase: 'agent_tool_call', effect,
  toolCall: {id, name: effect ? 'system_volume_set' : 'system_volume_get', arguments: effect ? {percent: 30} : {}},
});
const result = (id = 'tool_volume_1', receipt = {}) => ({
  phase: 'agent_tool_result', toolCallId: id, name: 'system_volume_set',
  result: {ok: true, verified: true, effectAttempted: true, message: 'Громкость установлена на 30%.', ...receipt},
});
const completed = overrides => ({
  ok: true, reason: 'agent_completed', message: 'Громкость установлена на 30%.',
  evidenceIds: ['tool_volume_1'], events: [call(), result()], ...overrides,
});
const assertNoCompletion = report => {
  const actual = describeResult(report);
  assert.notEqual(actual.tone, 'success');
  assert.doesNotMatch(actual.spoken, /Громкость установлена|Задача выполнена/u);
  return actual;
};

test('agent completion uses the report evidence IDs and a verified executor result', () => {
  for (const property of ['events', 'trace']) {
    const report = completed({events: undefined, [property]: [call(), result()]});
    const actual = describeResult(report);
    assert.deepEqual(actual, {
      tone: 'success', title: 'Готово', message: report.message, spoken: report.message, retryable: false,
    });
    assert.deepEqual(report.evidenceIds, ['tool_volume_1']);
  }
});

test('a model completion claim or an unrelated successful receipt is not completion evidence', () => {
  for (const evidenceIds of [undefined, null, [], 'tool_volume_1', ['absent'], ['tool_volume_1', 'absent']]) {
    const actual = assertNoCompletion(completed({evidenceIds}));
    assert.equal(actual.retryable, false);
  }
  assertNoCompletion(completed({events: [], result: {ok: true, verified: true}}));
  assertNoCompletion(completed({events: [{phase: 'agent_response', evidenceIds: ['tool_volume_1'], ok: true, verified: true}]}));
  assertNoCompletion(completed({events: [call(), {...result(), phase: 'provider_result'}]}));
});

test('agent completion requires exact successful booleans in both report and source receipt', () => {
  for (const ok of [false, undefined, null, 1, 'true']) {
    assertNoCompletion(completed({ok}));
    assertNoCompletion(completed({events: [call(), result(undefined, {ok})]}));
  }
  for (const verified of [false, undefined, null, 1, 'true']) {
    assertNoCompletion(completed({events: [call(), result(undefined, {verified})]}));
  }
  assertNoCompletion(completed({executionUncertain: true}));
});

test('every cited completion receipt must be verified even when another effect succeeded', () => {
  const events = [call(), result(), call('tool_second'), result('tool_second', {ok: false, verified: false, effectAttempted: false})];
  const actual = assertNoCompletion(completed({events, evidenceIds: ['tool_volume_1', 'tool_second']}));
  assert.equal(actual.tone, 'warning');
  assert.equal(actual.retryable, false);
  assert.match(actual.message, /Часть действий выполнена/u);
});

test('read-only agent answer preserves its text without claiming that a task mutation completed', () => {
  const message = 'Системная громкость сейчас 30%.';
  const actual = describeResult({
    ok: true, reason: 'agent_answer', message,
    events: [call('tool_read', false), result('tool_read', {effectAttempted: false, message})],
  });
  assert.equal(actual.tone, 'success');
  assert.equal(actual.title, 'Ответ готов');
  assert.equal(actual.message, message);
  assert.equal(actual.spoken, message);
  assert.doesNotMatch(actual.spoken, /Готово|Задача выполнена/u);
});

test('agent answer cannot hide a verified or unresolved mutation behind an informational result', () => {
  for (const events of [[call(), result()], [call()], [call(), result(undefined, {ok: false, verified: false})]]) {
    const actual = assertNoCompletion({ok: true, reason: 'agent_answer', message: 'Задача выполнена.', events});
    assert.equal(actual.tone, 'warning');
    assert.equal(actual.retryable, false);
  }
  for (const ok of [false, undefined, 1, 'true']) {
    const actual = describeResult({ok, reason: 'agent_answer', message: 'STALE_ANSWER'});
    assert.notEqual(actual.tone, 'success');
    assert.doesNotMatch(JSON.stringify(actual), /STALE_ANSWER/u);
  }
});

test('incomplete agent work describes the limitation and retains prior effect uncertainty', () => {
  const message = 'Не удалось найти нужное окно.';
  const empty = describeResult({ok: false, reason: 'agent_incomplete', message});
  assert.equal(empty.tone, 'warning');
  assert.equal(empty.message, message);
  assert.equal(empty.retryable, false);
  const partial = describeResult({ok: false, reason: 'agent_incomplete', message, events: [call(), result()]});
  assert.match(partial.message, /Часть действий выполнена/u);
  assert.match(partial.message, /Не удалось найти нужное окно/u);
  const uncertain = describeResult({ok: false, reason: 'agent_incomplete', message, events: [call()]});
  assert.match(uncertain.message, /могло выполниться/u);
  assert.equal(uncertain.retryable, false);
});

test('agent clarification preserves a generic question and cannot erase an earlier pending effect', () => {
  const report = {ok: false, reason: 'clarification_required', needsClarification: true, message: 'Какое приложение открыть?'};
  const actual = describeResult(report);
  assert.equal(actual.tone, 'neutral');
  assert.equal(actual.title, 'Нужно уточнение');
  assert.equal(actual.message, report.message);
  assert.equal(actual.spoken, report.message);
  const interrupted = describeResult({...report, events: [call()]});
  assert.equal(interrupted.tone, 'warning');
  assert.equal(interrupted.retryable, false);
  assert.match(interrupted.message, /могло выполниться/u);
});

test('durable effect dispatch without its matching result is uncertain after recovery', () => {
  for (const property of ['events', 'trace']) {
    for (const events of [[call()], [call(), result('unrelated')], [call(), result(), call('tool_second')]]) {
      const actual = describeResult({ok: false, reason: 'interrupted', status: 'interrupted', [property]: events});
      assert.equal(actual.tone, 'warning');
      assert.equal(actual.retryable, false);
      assert.match(actual.message, /могло выполниться/u);
      assert.match(actual.message, /Перед повтором проверьте/u);
      assert.doesNotMatch(actual.message, /Можно ввести новую команду.*Задача выполнена/u);
    }
  }
});

test('recovered matched effect results distinguish completion, rejection and uncertain dispatch', () => {
  const report = receipt => ({ok: false, reason: 'interrupted', events: [call(), result(undefined, receipt)]});
  const verified = describeResult(report({ok: true, verified: true, effectAttempted: true}));
  assert.equal(verified.tone, 'warning');
  assert.equal(verified.retryable, false);
  assert.match(verified.message, /Часть действий выполнена/u);
  const uncertain = describeResult(report({ok: false, verified: false, effectAttempted: true}));
  assert.equal(uncertain.tone, 'warning');
  assert.equal(uncertain.retryable, false);
  assert.match(uncertain.message, /могло выполниться/u);
  const rejected = describeResult(report({ok: false, verified: false, effectAttempted: false}));
  assert.equal(rejected.tone, 'neutral');
  assert.equal(rejected.retryable, true);
});

const observedInvokeEvents = () => [{
  phase: 'agent_tool_call', effect: true,
  toolCall: {id: 'tool_invoke_1', name: 'windows_execute', arguments: {snapshotVersion: 'fixture-v1', actionId: 'open-panel'}},
}, {
  phase: 'agent_tool_result', toolCallId: 'tool_invoke_1', name: 'windows_execute',
  result: {ok: true, verified: false, effectConfirmed: true, needsObservation: true, effectAttempted: true,
    evidence: 'uia_invoke_returned', message: 'Нажатие выполнено, результат нужно проверить.'},
}];

test('interruption after a confirmed invoke reports interface change without treating the dispatch as unknown', () => {
  for (const property of ['events', 'trace']) {
    for (const reason of ['interrupted', 'aborted']) {
      const actual = describeResult({ok: false, reason, [property]: observedInvokeEvents()});
      assert.equal(actual.tone, 'warning');
      assert.equal(actual.retryable, false);
      assert.match(actual.message, /Интерфейс изменился, но завершение задачи не подтверждено/u);
      assert.match(actual.message, /Перед повтором проверьте/u);
      assert.doesNotMatch(actual.message, /Действие могло выполниться|Часть действий выполнена|Задача выполнена/u);
    }
  }
});

test('a confirmed invoke needs a cited verified follow-up observation before completion can be shown', () => {
  const events = observedInvokeEvents();
  events.push({
    phase: 'agent_tool_call', effect: false,
    toolCall: {id: 'tool_observe_after_invoke', name: 'windows_observe', arguments: {}},
  }, {
    phase: 'agent_tool_result', toolCallId: 'tool_observe_after_invoke', name: 'windows_observe',
    result: {ok: true, verified: true, effectAttempted: false, evidence: 'windows_observed',
      message: 'Панель появилась в актуальном состоянии окна.'},
  });
  const report = {ok: true, reason: 'agent_completed', message: 'Панель открыта.', events,
    evidenceIds: ['tool_observe_after_invoke'], completed: [{id: 'tool_invoke_1', operation: 'windows_execute', outcome: 'observed_change'}]};
  const actual = describeResult(report);
  assert.equal(actual.tone, 'success');assert.equal(actual.title, 'Готово');
  assert.equal(actual.message, report.message);assert.equal(actual.spoken, report.message);
  assert.equal(actual.retryable, false);

  for (const evidenceIds of [[], ['tool_invoke_1'], ['missing_observation']]) {
    const ungrounded = describeResult({...report, evidenceIds});
    assert.equal(ungrounded.tone, 'warning');assert.equal(ungrounded.retryable, false);
    assert.match(ungrounded.message, /Интерфейс изменился/u);
    assert.doesNotMatch(ungrounded.spoken, /Панель открыта/u);
  }
});

test('an informational agent answer cannot conceal an already observed interface change', () => {
  for (const property of ['events', 'trace']) {
    const actual = describeResult({ok: true, reason: 'agent_answer', message: 'Панель открыта.', [property]: observedInvokeEvents()});
    assert.equal(actual.tone, 'warning');assert.equal(actual.retryable, false);
    assert.notEqual(actual.title, 'Ответ готов');
    assert.match(actual.message, /Интерфейс изменился/u);
    assert.doesNotMatch(actual.message, /Действие могло выполниться|Панель открыта/u);
    assert.doesNotMatch(actual.spoken, /Панель открыта/u);
  }
});

test('a matching result event without a trustworthy receipt cannot make an effect safe to repeat', () => {
  for (const receipt of [undefined, null, {}, {ok: false, verified: false}, {ok: false, verified: false, effectAttempted: 'false'}]) {
    const actual = describeResult({
      ok: false, reason: 'interrupted',
      events: [call(), {...result(), result: receipt}],
    });
    assert.equal(actual.tone, 'warning');
    assert.equal(actual.retryable, false);
    assert.match(actual.message, /могло выполниться/u);
  }
});

test('a pending read-only call does not imply a mutation and an unrelated receipt does not prove one', () => {
  for (const events of [[call('tool_read', false)], [result()], [call('tool_read', false), result('tool_read', {effectAttempted: false})]]) {
    const actual = describeResult({ok: false, reason: 'interrupted', events});
    assert.equal(actual.tone, 'neutral');
    assert.equal(actual.retryable, true);
    assert.doesNotMatch(actual.message, /Часть действий|могло выполниться/u);
  }
});

test('agent feedback remains bounded and does not mutate journal evidence', () => {
  const report = completed({message: 'Подтверждённый результат. '.repeat(200)});
  const original = structuredClone(report);
  const actual = describeResult(report);
  assert.ok(actual.message.length <= 2000);
  assert.ok(actual.spoken.length <= 2000);
  assert.equal(actual.spoken.at(-1), '…');
  assert.deepEqual(report, original);
});
