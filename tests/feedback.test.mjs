import test from 'node:test';
import assert from 'node:assert/strict';
import {describeResult, describeError} from '../desktop/automation/feedback.mjs';

const effect = (operation = 'minimize', outcome = 'verified') => ({operation, outcome, evidence: 'window_minimized'});
const receipt = (operation, evidence, extra = {}) => ({phase: 'execute_result', receipt: {operation, evidence, verified: false, stateChanged: false, ...extra}});
const request = operation => ({phase: 'execute_request', operation});

test('a verified goal needs explicit success and preserves the spoken success contract', () => {
  assert.deepEqual(describeResult({ok: true, reason: 'goal_verified'}), {
    tone: 'success', title: 'Готово', message: 'Задача выполнена.', spoken: 'Готово. Задача выполнена.', retryable: false,
  });
  for (const ok of [false, undefined, null, 1, 'true']) {
    const actual = describeResult({ok, reason: 'goal_verified'});
    assert.notEqual(actual.tone, 'success');
    assert.doesNotMatch(actual.spoken, /Задача выполнена/u);
  }
});

test('observation is not represented as a verified success even when report.ok is true', () => {
  for (const report of [
    {ok: true, reason: 'goal_observed'},
    {ok: true, reason: 'goal_verified', completed: [effect('invoke', 'observed_change')]},
  ]) {
    const actual = describeResult(report);
    assert.equal(actual.tone, 'warning');
    assert.doesNotMatch(actual.spoken, /Задача выполнена/u);
    assert.equal(actual.retryable, false);
  }
});

test('low confidence explains how to rephrase, without diagnosing a launch failure from command wording', () => {
  const actual = describeResult({ok: false, reason: 'low_confidence', command: 'Открой диспетчер задач'});
  assert.equal(actual.title, 'Не уверен, что выбрал нужное действие');
  assert.match(actual.message, /название приложения/u);
  assert.equal(actual.retryable, true);
  assert.doesNotMatch(actual.spoken, /Не получилось открыть приложение/u);
});

test('unsupported refers to unavailable window or control and does not invent an app launch failure', () => {
  const actual = describeResult({ok: false, reason: 'unsupported', command: 'Открой музыку'});
  assert.match(actual.message, /окно или элемент/u);
  assert.notEqual(actual.title, 'Не получилось открыть приложение');
});

test('an explicit launch rejection has a clear app failure despite conservative in-flight flag', () => {
  for (const reason of ['APP_LAUNCH_FAILED', 'APP_ELEVATION_REQUIRED']) {
    const actual = describeResult({ok: false, reason, executionUncertain: true, trace: [request('launch')]});
    assert.equal(actual.title, 'Не получилось открыть приложение');
    assert.equal(actual.tone, 'error');
    assert.doesNotMatch(actual.message, /Действие могло выполниться/u);
  }
  assert.equal(describeError('APP_ELEVATION_REQUIRED').retryable, false);
});

test('launch failures retain partial work that occurred before the failed launch', () => {
  const actual = describeResult({ok: false, reason: 'APP_LAUNCH_FAILED', completed: [effect()]});
  assert.equal(actual.tone, 'warning');
  assert.match(actual.message, /Часть действий выполнена/u);
  assert.equal(actual.retryable, false);
});

test('a started process whose window was not found is not called a failed launch or success', () => {
  const actual = describeResult({ok: false, reason: 'not_verified', trace: [request('launch'), receipt('launch', 'process_started_window_not_observed')]});
  assert.equal(actual.title, 'Программа запущена, окно не найдено');
  assert.equal(actual.tone, 'warning');
  assert.equal(actual.retryable, false);
  assert.doesNotMatch(actual.spoken, /Задача выполнена|Не получилось открыть приложение/u);
});

test('plain cancellation and read-only inspection remain neutral', () => {
  for (const completed of [[], [effect('inspect')]]) {
    const actual = describeResult({ok: false, reason: 'aborted', completed, executionUncertain: false});
    assert.equal(actual.tone, 'neutral');
    assert.match(actual.spoken, /остановлено/u);
    assert.doesNotMatch(actual.message, /Часть действий/u);
  }
});

test('cancellation after a completed mutation states partial completion', () => {
  for (const completed of [[effect()], [effect('note', 'local_saved')]]) {
    const actual = describeResult({ok: false, reason: 'aborted', completed});
    assert.equal(actual.tone, 'warning');
    assert.match(actual.message, /Часть действий выполнена, но завершение задачи не подтверждено/u);
    assert.equal(actual.retryable, false);
  }
});

test('in-flight cancellation never suggests that no action happened', () => {
  const actual = describeResult({ok: false, reason: 'aborted', executionUncertain: true});
  assert.equal(actual.tone, 'warning');
  assert.match(actual.message, /Действие могло выполниться/u);
  assert.equal(actual.retryable, false);
  assert.doesNotMatch(actual.spoken, /ничего не|действия не выполнялись|Задача выполнена/u);
});

test('executionUncertain uses true strictly instead of generic truthiness', () => {
  for (const executionUncertain of [false, undefined, null, 1, 'true']) {
    assert.equal(describeResult({ok: false, reason: 'aborted', executionUncertain}).tone, 'neutral');
  }
});

test('interrupted journal identifies a pending native action but ignores pending inspection', () => {
  const stopped = describeResult({status: 'interrupted', reason: 'interrupted', events: [request('minimize')]});
  assert.equal(stopped.tone, 'warning');
  assert.match(stopped.message, /могло выполниться/u);
  assert.equal(describeResult({reason: 'interrupted', events: [request('inspect')]}).tone, 'neutral');
});

test('log failure overrides a stale successful message and a successful local result', () => {
  const report = {ok: false, reason: 'LOG_WRITE_FAILED', message: 'Заметка сохранена.', result: {ok: true}, completed: [effect('note', 'local_saved')]};
  const actual = describeResult(report);
  assert.equal(actual.title, 'Не удалось сохранить журнал');
  assert.equal(actual.tone, 'warning');
  assert.match(actual.message, /могли уже выполниться/u);
  assert.doesNotMatch(actual.spoken, /Заметка сохранена|Задача выполнена/u);
  assert.equal(actual.retryable, false);
  assert.equal(describeResult({ok: true, reason: 'LOG_WRITE_FAILED', message: 'Готово'}).tone, 'error');
});

test('text replacement receipt is read from both trace and stored journal events', () => {
  for (const property of ['trace', 'events']) {
    const actual = describeResult({ok: false, reason: 'not_verified', completed: [], [property]: [request('replace_text'), receipt('replace_text', 'text_set_unverified')]});
    assert.equal(actual.tone, 'warning');
    assert.equal(actual.title, 'Текст передан приложению');
    assert.match(actual.message, /содержимое поля не проверялось/u);
    assert.equal(actual.retryable, false);
    assert.doesNotMatch(actual.spoken, /текст заменён|Задача выполнена/u);
  }
});

test('foreground denial describes the exact limitation without asserting an uncertain focus effect', () => {
  const actual = describeResult({ok: false, reason: 'not_verified', trace: [receipt('activate', 'foreground_not_granted')]});
  assert.equal(actual.title, 'Не получилось показать окно');
  assert.equal(actual.tone, 'error');
  assert.match(actual.message, /панели задач/u);
  assert.doesNotMatch(actual.message, /могло выполниться/u);
});

test('provider errors are friendly and never expose report.message or errorDetails', () => {
  for (const reason of ['WINDOWS_CHOICE_NETWORK', 'WINDOWS_CHOICE_HTTP', 'WINDOWS_CHOICE_RESPONSE', 'WINDOWS_TIMEOUT', 'UNKNOWN_CODE']) {
    const actual = describeResult({ok: false, reason, message: 'Bearer private-token', errorDetails: 'apikey_private', error: 'private-provider-body'});
    assert.doesNotMatch(JSON.stringify(actual), /private|Bearer|apikey/u);
    assert.notEqual(actual.tone, 'success');
  }
});

test('a provider failure after an effect reports partial completion, not a full failure', () => {
  const actual = describeResult({ok: false, reason: 'WINDOWS_CHOICE_NETWORK', completed: [effect()]});
  assert.equal(actual.tone, 'warning');
  assert.match(actual.message, /Часть действий выполнена/u);
  assert.equal(actual.retryable, false);
});

test('receipt verification and state changes require exact booleans', () => {
  for (const verified of [false, undefined, null, 1, 'true']) {
    const actual = describeResult({ok: false, reason: 'goal_not_verified', trace: [receipt('minimize', 'unknown', {verified, stateChanged: undefined})]});
    assert.match(actual.message, /могло выполниться/u);
    assert.doesNotMatch(actual.message, /Часть действий выполнена/u);
  }
  const observed = describeResult({ok: false, reason: 'goal_not_verified', trace: [receipt('invoke', 'state_changed', {stateChanged: true})]});
  assert.match(observed.message, /Интерфейс изменился/u);
  assert.doesNotMatch(observed.message, /Часть действий выполнена/u);
});

test('successful chat answers are preserved and their spoken version is bounded', () => {
  const message = '  Ответ Gemini.\n' + 'Текст. '.repeat(400);
  const actual = describeResult({ok: true, reason: 'chat_answer', message});
  assert.equal(actual.tone, 'success');
  assert.equal(actual.message, message);
  assert.ok(actual.spoken.length <= 2000);
  assert.equal(actual.spoken.at(-1), '…');
});

test('failed or incomplete chat reports cannot leak stale successful or provider text', () => {
  for (const report of [
    {ok: false, reason: 'chat_answer', message: 'SECRET'},
    {reason: 'chat_answer', message: 'SECRET'},
    {ok: false, reason: 'chat_failed', message: 'SECRET', error: 'SECRET'},
    {ok: true, reason: 'chat_answer', message: '  '},
  ]) {
    const actual = describeResult(report);
    assert.notEqual(actual.tone, 'success');
    assert.doesNotMatch(JSON.stringify(actual), /SECRET/u);
  }
});

test('local successes speak truthful receipts and local help is neutral', () => {
  assert.equal(describeResult({ok: true, reason: 'local_completed', result: {kind: 'note'}, message: 'Заметка сохранена.'}).spoken, 'Заметка сохранена.');
  assert.equal(describeResult({ok: true, reason: 'local_completed', result: {kind: 'help'}, message: 'Команды: …'}).tone, 'neutral');
});

test('local parser rejection keeps actionable validation but a storage failure ignores old success text', () => {
  const actual = describeResult({ok: false, reason: 'local_rejected', intent: {kind: 'error', message: 'Укажите текст напоминания после длительности.'}, result: {ok: false}});
  assert.equal(actual.message, 'Укажите текст напоминания после длительности.');
  const storage = describeResult({ok: false, reason: 'local_rejected', intent: {kind: 'note'}, result: {ok: true}, message: 'Заметка сохранена.'});
  assert.doesNotMatch(storage.spoken, /Заметка сохранена/u);
});

test('all status descriptions have bounded spoken text and stable field types', () => {
  const reasons = ['goal_verified', 'goal_observed', 'low_confidence', 'unsupported', 'aborted', 'time_limit', 'step_limit', 'repeated_action', 'unknown_action', 'no_request', 'LOG_WRITE_FAILED', 'local_rejected', 'chat_failed'];
  for (const reason of reasons) {
    const actual = describeResult({ok: false, reason, completed: [effect()], message: 'x'.repeat(10000)});
    assert.deepEqual(Object.keys(actual).sort(), ['message', 'retryable', 'spoken', 'title', 'tone']);
    assert.ok(['success', 'warning', 'error', 'neutral'].includes(actual.tone));
    assert.equal(typeof actual.retryable, 'boolean');
    assert.ok(actual.spoken.length <= 350);
  }
});

test('malformed and unknown reports do not throw, reveal input or claim success', () => {
  for (const report of [undefined, null, false, 'SECRET', {}, {ok: true, reason: 'unknown', completed: [null], trace: ['bad', null]}, {completed: {}, events: {}}]) {
    const actual = describeResult(report);
    assert.notEqual(actual.tone, 'success');
    assert.doesNotMatch(JSON.stringify(actual), /SECRET/u);
  }
  assert.equal(describeError({message: 'SECRET'}).tone, 'error');
});

test('feedback is pure and does not edit or reorder the report', () => {
  const report = {ok: false, reason: 'not_verified', trace: [receipt('replace_text', 'text_set_unverified')], completed: []};
  const original = structuredClone(report);
  assert.deepEqual(describeResult(report), describeResult(report));
  assert.deepEqual(report, original);
});

test('voice and microphone failures suggest a recovery without echoing exception text', () => {
  for (const code of ['NO_SPEECH', 'EMPTY_TRANSCRIPT', 'TRANSCRIPT_TOO_LONG', 'VOICE_PROCESSING_FAILED', 'CLOUD_DISABLED',
    'WAKE_LOAD_FAILED', 'WAKE_INFERENCE_FAILED', 'WAKE_RESET_FAILED', 'NotAllowedError', 'NotFoundError', 'NotReadableError',
    'OverconstrainedError', 'ENCODER_MISSING', 'ENCODER_TIMEOUT', 'ENCODER_FAILED', 'AUDIO_INVALID', 'AUDIO_TOO_LARGE',
    'GEMINI_UNAVAILABLE', 'VOICE_MODE_INVALID', 'VOICE_BUSY']) {
    const actual = describeError(code);
    assert.notEqual(actual.title, 'Не получилось завершить задачу', code);
    assert.ok(actual.spoken.length <= 350, code);
    assert.doesNotMatch(actual.spoken, /Задача выполнена/u);
  }
  assert.equal(describeError('NO_SPEECH').tone, 'neutral');
  assert.equal(describeError('NotAllowedError').retryable, false);
});

test('speech playback failure keeps task outcome separate and discourages duplicate execution', () => {
  for (const code of ['VOICE_PLAYBACK_FAILED', 'DENIS_NOT_INSTALLED', 'DENIS_AUDIO_INVALID', 'DENIS_MODEL_CONFIG']) {
    const actual = describeError(code);
    assert.equal(actual.tone, 'warning');
    assert.equal(actual.retryable, false);
    assert.match(actual.message, /Не нужно повторять команду/u);
    assert.doesNotMatch(actual.message, /Задача выполнена|задача не выполнена/u);
  }
});

test('specific native unverified receipts explain uncertainty even when the flag is true', () => {
  for (const [operation, evidence, title] of [
    ['replace_text', 'text_set_unverified', 'Текст передан приложению'],
    ['launch', 'process_started_window_not_observed', 'Программа запущена, окно не найдено'],
  ]) {
    const report = {ok: false, reason: 'not_verified', executionUncertain: true, events: [request(operation), receipt(operation, evidence)]};
    assert.equal(describeResult(report).title, title);
    assert.equal(describeResult(report).retryable, false);
    // A controller-rejected receipt or snapshot cannot establish this detail.
    for (const reason of ['execution_uncertain', 'WINDOWS_INVALID_SNAPSHOT']) {
      const actual = describeResult({...report, reason});
      assert.equal(actual.title, 'Результат не подтверждён');
      assert.match(actual.message, /могло выполниться/u);
    }
  }
});

test('semantic clarification preserves its question without claiming completion', () => {
  const actual=describeResult({ok:false,reason:'clarification_required',needsClarification:true,message:'Во сколько завтра?'});
  assert.equal(actual.tone,'neutral');assert.equal(actual.title,'Нужно уточнение');
  assert.equal(actual.message,'Во сколько завтра?');assert.equal(actual.spoken,'Во сколько завтра?');
  for(const needsClarification of [false,undefined,'true'])assert.notEqual(describeResult({ok:false,reason:'clarification_required',needsClarification,message:'PRIVATE'}).message,'PRIVATE');
});

test('system completion requires an explicitly verified successful receipt', () => {
  const report={ok:true,reason:'system_completed',message:'Громкость установлена на 30%.',result:{ok:true,verified:true}};
  assert.equal(describeResult(report).message,report.message);assert.equal(describeResult(report).tone,'success');
  for(const result of [{ok:true},{ok:false,verified:true},{ok:true,verified:'true'},null]){
    const actual=describeResult({...report,result});assert.notEqual(actual.tone,'success');assert.notEqual(actual.message,report.message);
  }
  assert.notEqual(describeResult({...report,executionUncertain:true}).tone,'success');
});

test('routine spoken failures are short while detailed text stays useful', () => {
  for(const reason of ['unsupported','low_confidence','WINDOWS_CHOICE_NETWORK','APP_LAUNCH_FAILED','time_limit','step_limit','no_request']){
    const actual=describeResult({ok:false,reason});assert.ok(actual.spoken.length<=100,reason);
    assert.equal(actual.spoken.split(/[.!?]/u).filter(part=>part.trim()).length,1,reason);assert.ok(actual.message.length>0);
  }
  const uncertain=describeResult({ok:false,reason:'unsupported',executionUncertain:true});
  assert.match(uncertain.spoken,/не подтверждён.*проверьте.*повтором/u);
  assert.match(uncertain.message,/Действие могло выполниться/u);
  assert.doesNotMatch(describeResult({ok:false,reason:'no_request'}).message,/начните|Расскажи|Объясни/u);
});

test('semantic parent keeps native desktop receipt details and uncertainty', () => {
  const parent={ok:false,reason:'not_verified',events:[{phase:'intent_decision',route:'desktop'}],desktopEvents:[request('replace_text'),receipt('replace_text','text_set_unverified')],completed:[]};
  assert.equal(describeResult(parent).title,'Текст передан приложению');
  assert.match(describeResult({...parent,reason:'aborted',desktopEvents:[request('minimize')]}).message,/могло выполниться/u);
  assert.equal(describeResult({...parent,reason:'aborted',desktopEvents:[request('inspect')]}).tone,'neutral');
});

test('unresolved semantic dispatch warns on interruption while matched results keep their evidence', () => {
  for (const prefix of ['desktop_delegate', 'system_execute']) {
    const dispatch = {phase:`${prefix}_request`};
    for (const property of ['events', 'trace']) {
      const actual = describeResult({ok:false,reason:'interrupted',[property]:[dispatch]});
      assert.equal(actual.tone,'warning');assert.equal(actual.retryable,false);
      assert.match(actual.message,/могло выполниться/u);
    }
    const events = [dispatch,{phase:`${prefix}_result`,ok:false,reason:'no_request'}];
    assert.equal(describeResult({ok:false,reason:'no_request',events}).retryable,true);
    assert.equal(describeResult({ok:false,reason:'aborted',events,executionUncertain:true}).retryable,false);
  }
  const events=[{phase:'desktop_delegate_request'},{phase:'desktop_delegate_result',ok:true,reason:'goal_verified'}];
  for (const interruption of [{reason:'interrupted'}, {reason:'interrupted',status:'interrupted'}]) {
    const recovered=describeResult({ok:false,...interruption,events});
    assert.equal(recovered.tone,'warning');assert.equal(recovered.retryable,false);
  }
  assert.equal(describeResult({ok:true,reason:'goal_verified',events,completed:[{operation:'close',outcome:'verified'}]}).tone,'success');
  assert.equal(describeResult({ok:false,reason:'APP_LAUNCH_FAILED',events,executionUncertain:false}).retryable,true);
  assert.equal(describeResult({ok:false,reason:'not_verified',events,desktopEvents:[request('replace_text'),receipt('replace_text','text_set_unverified')]}).title,'Текст передан приложению');
});

test('semantic provider and live speech errors use safe actionable copy', () => {
  assert.equal(describeResult({ok:false,reason:'intent_failed',error:'ASSISTANT_INTENT_KEY',message:'PRIVATE'}).title,'Jev не подключён');
  for(const error of ['ASSISTANT_INTENT_NETWORK','ASSISTANT_INTENT_HTTP','ASSISTANT_INTENT_TIMEOUT']){
    const actual=describeResult({ok:false,reason:'intent_failed',error,message:'PRIVATE'});
    assert.equal(actual.title,'Нет ответа от Jev');assert.doesNotMatch(JSON.stringify(actual),/PRIVATE/u);
  }
  for(const code of ['LIVE_TRANSCRIPTION_UNAVAILABLE','LIVE_AUDIO_REJECTED','LIVE_TRANSCRIPTION_FAILED']){
    const actual=describeError(code);assert.match(actual.message,/После записи/u);assert.ok(actual.spoken.length<=100);
  }
});

test('recovered system result retains verified or uncertain effects before the final report is saved', () => {
  const report=result=>({ok:false,reason:'interrupted',events:[{phase:'system_execute_request',intent:{kind:'volume',percent:75}},{phase:'system_execute_result',result}]});
  const verified=describeResult(report({ok:true,verified:true,effectAttempted:true}));
  assert.equal(verified.tone,'warning');assert.equal(verified.retryable,false);assert.match(verified.message,/Часть действий выполнена/u);
  const uncertain=describeResult(report({ok:false,verified:false,effectAttempted:true}));
  assert.equal(uncertain.tone,'warning');assert.equal(uncertain.retryable,false);assert.match(uncertain.message,/могло выполниться/u);
  const rejected=describeResult(report({ok:false,verified:false,effectAttempted:false}));
  assert.equal(rejected.tone,'neutral');assert.equal(rejected.retryable,true);
});
