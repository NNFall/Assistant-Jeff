import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatAgentProgress, formatCapabilities, formatDataSent, formatDataTree, formatDecisionLog, formatExecutionLog, formatGoalVerification, formatJevProgress, formatLogView, formatObservation, formatRuntimeProvider } from '../desktop/automation/log-view.mjs';

const currentRequest = {
  state: {
    command: 'Сверни Editor',
    observation: { app: 'Editor', summary: 'Открытое окно редактора.' },
    candidates: [{ id: 'g1_a_win_minimize', label: 'Свернуть окно: Editor', operation: 'minimize' }],
    completed: [],
  },
  questions: {
    next_action: { criteria: {
      g1_a_win_minimize: 'minimize: Свернуть окно: Editor',
      done: 'Цель уже достигнута.',
      unsupported: 'Нет однозначного действия.',
    } },
  },
};

function currentReport(overrides = {}) {
  return {
    calls: [{
      kind: 'action', request: currentRequest,
      decision: {
        choice: 'g1_a_win_minimize', actionId: 'g1_a_win_minimize', probability: .93, confidence: .88,
        probabilities: { g1_a_win_minimize: .93, done: .04, unsupported: .03 },
      },
    }],
    trace: [
      { phase: 'observe', snapshot: { version: 'v1', windows: [{ id: 'w1', title: 'Editor', processName: 'Editor', active: true }], elements: [{ id: 'save', role: 'Button', name: 'Сохранить' }], facts: { selectedWindowId: 'w1' }, metadata: { provider: 'Windows UI Automation' } } },
      { phase: 'execute_request', step: 1, candidate: { id: 'g1_a_win_minimize', label: 'Свернуть окно: Editor', operation: 'minimize' } },
      { phase: 'execute_result', step: 1, receipt: { operation: 'minimize', verified: true, stateChanged: true, evidence: 'window_minimized' } },
      { phase: 'verify', step: 1, outcome: 'verified', evidence: 'window_minimized' },
    ],
    completed: [{ id: 'g1_a_win_minimize', label: 'Свернуть окно: Editor', operation: 'minimize', outcome: 'verified', evidence: 'window_minimized' }],
    final: { version: 'v2', windows: [{ id: 'w1', title: 'Editor', processName: 'Editor', active: true, minimized: true }], elements: [{ id: 'save', role: 'Button', name: 'Сохранить' }], facts: { selectedWindowId: 'w1' }, metadata: { provider: 'Windows UI Automation' } },
    ...overrides,
  };
}

test('current Jev decisions resolve candidate labels and keep probability separate from confidence', () => {
  const [step] = formatDecisionLog(currentReport());
  assert.equal(step.selectedAction, 'Свернуть окно: Editor');
  assert.equal(step.probability, .93);
  assert.equal(step.confidence, .88);
  assert.equal(step.alternatives[0].label, 'Свернуть окно: Editor');
  assert.doesNotMatch(step.selectedAction, /g1_a_win_minimize/u);
  assert.match(step.dataSent.find(item => item.label === 'Текст команды').value, /Сверни Editor/u);
});

function stepRequest(label = 'Свернуть окно: Editor') {
  return {
    model: 'jev-latest',
    state: {command: 'Сверни Editor', observation: {summary: 'Окно редактора открыто.'}, candidates: [{id: 'step_01', label, operation: 'minimize'}], recentSteps: []},
    questions: {next_step: {type: 'choice', criteria: {step_01: label, done: 'All effects are verified.', unavailable: 'No action can advance the task.'}}},
  };
}
const stepDecision = {choice: 'step_01', actionId: 'step_01', probability: .94, confidence: .87, probabilities: {step_01: .94, done: .04, unavailable: .02}, model: 'jev-test', latencyMs: 173, usage: {input_tokens: 125, output_tokens: 18}};

test('Jev steps expose their human choice, timing and exact normalized exchange', () => {
  const request = stepRequest();
  const report = {mode: 'JEV_DESKTOP', provider: 'typesafe/jev', calls: [{request, decision: stepDecision}]};
  const original = structuredClone(report);
  const [step] = formatDecisionLog(report);
  assert.equal(step.selectedAction, 'Свернуть окно: Editor');
  assert.equal(step.provider, 'Jev');
  assert.equal(step.latencyMs, 173);
  assert.equal(step.probability, .94);
  assert.equal(step.confidence, .87);
  assert.deepEqual(JSON.parse(step.requestJson), request);
  assert.deepEqual(JSON.parse(step.responseJson), stepDecision);
  assert.equal(step.responseNormalized, true);
  assert.equal(step.alternatives.find(item => item.choice === 'done').label, 'Завершить по оценке Jev');
  assert.doesNotMatch(step.alternatives.find(item => item.choice === 'unavailable').label, /No action/u);
  assert.deepEqual(report, original);
});

test('recovered event-only Jev journals retain request, response and chosen action', () => {
  const request = stepRequest();
  const report = {events: [
    {phase: 'model_request', step: 1, request},
    {phase: 'model_response', step: 1, response: {model: 'jev-test', answers: {next_step: {type: 'choice', ...stepDecision}}}},
    {phase: 'model_decision', step: 1, label: 'Свернуть окно: Editor', ...stepDecision},
  ]};
  const [step] = formatDecisionLog(report);
  assert.equal(step.selectedAction, 'Свернуть окно: Editor');
  assert.equal(step.latencyMs, 173);
  assert.deepEqual(JSON.parse(step.requestJson), request);
  assert.equal(JSON.parse(step.responseJson).choice, 'step_01');
  assert.match(formatJevProgress(report.events[2]), /Jev выбрал: Свернуть окно/u);
  assert.doesNotMatch(formatJevProgress(report.events[2]), /step_01/u);
  assert.match(formatJevProgress({phase: 'model_decision', choice: 'done', label: 'Готово'}), /по оценке Jev/u);
});

test('step-local action identifiers never merge unrelated executions or chosen labels', () => {
  const report = {mode: 'JEV_DESKTOP', calls: [
    {request: stepRequest('Свернуть редактор'), decision: stepDecision},
    {request: stepRequest('Показать браузер'), decision: stepDecision},
  ], events: [
    {phase: 'execute_request', step: 1, actionId: 'step_01', label: 'Свернуть редактор', operation: 'minimize'},
    {phase: 'execute_result', step: 1, result: {ok: true, verified: true}},
    {phase: 'execute_request', step: 2, actionId: 'step_01', label: 'Показать браузер', operation: 'activate'},
    {phase: 'execute_result', step: 2, result: {ok: false, verified: false}},
  ], completed: [{step: 1, id: 'step_01', label: 'Свернуть редактор', operation: 'minimize', outcome: 'verified'}]};
  assert.deepEqual(formatDecisionLog(report).map(item => item.selectedAction), ['Свернуть редактор', 'Показать браузер']);
  const records = formatExecutionLog(report);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(item => item.label), ['Свернуть редактор', 'Показать браузер']);
  assert.deepEqual(records.map(item => item.status), ['verified', 'failed']);
  assert.equal(records[0].statusLabel, 'Шаг подтверждён Windows');
});

test('routing decisions and runtime providers distinguish Jev selection from Gemini work', () => {
  const request = {state: {command: 'Сохрани заметку'}, questions: {route: {criteria: {desktop: 'Windows', memory: 'Заметки', conversation: 'Вопрос'}}}};
  const report = {mode: 'AGENT_ASSISTANT', provider: 'jev', delegation: {route: 'memory', provider: 'gemini'}, calls: [
    {kind: 'route', provider: 'jev', request, decision: {choice: 'memory', probability: .97, confidence: .9, latencyMs: 123}},
  ], events: [{phase: 'agent_request'}]};
  assert.equal(formatDecisionLog(report)[0].selectedAction, 'Заметки и напоминания — Gemini');
  assert.equal(formatDecisionLog(report)[0].kind, 'route');
  assert.equal(formatRuntimeProvider(report).label, 'Заметки и напоминания — Gemini');
  assert.equal(formatRuntimeProvider({status: 'running', events: [{phase: 'route_request', provider: 'jev'}]}).label, 'Выбор исполнителя — Jev');
  assert.equal(formatRuntimeProvider({status: 'running', events: [{phase: 'route_request'}, {phase: 'desktop_delegate_request'}]}).label, 'Управление Windows — Jev');
  assert.equal(formatRuntimeProvider({status: 'running', events: [{phase: 'assistant_delegate_request', route: 'conversation'}, {phase: 'agent_request'}]}).provider, 'Gemini');
  assert.equal(formatRuntimeProvider({status: 'running', events: [{phase: 'assistant_delegate_request', route: 'memory'}, {phase: 'agent_request'}]}).label, 'Заметки и напоминания — Gemini');
  assert.equal(formatRuntimeProvider({mode: 'JEV_ASSISTANT', provider: 'jev', reason: 'low_confidence'}).label, 'Выбор исполнителя — Jev');
});

test('model-assessed final status stays separate from confirmed step receipts', () => {
  const report = {mode: 'JEV_DESKTOP', ok: true, reason: 'goal_model_assessed', goalVerification: 'model_assessed', events: [
    {phase: 'execute_request', step: 1, label: 'Свернуть редактор', operation: 'minimize'},
    {phase: 'execute_result', step: 1, result: {ok: true, data: {receipt: {verified: true, evidence: 'window_minimized'}}}},
  ]};
  const model = formatLogView(report);
  assert.equal(model.executions[0].statusLabel, 'Шаг подтверждён Windows');
  assert.equal(model.goalVerification.kind, 'model_assessed');
  assert.match(model.goalVerification.message, /итог всей задачи отдельно не проверен/u);
  assert.equal(formatGoalVerification({...report, reason: 'goal_verified'}).kind, 'model_assessed');
  assert.equal(formatGoalVerification({...report, reason: 'goal_verified', goalVerification: 'native_verified'}).kind, 'verified');
  assert.equal(formatGoalVerification({...report, ok: false, reason: 'aborted'}).kind, 'unverified');
});

test('already satisfied postconditions stay distinct from executed Windows effects', () => {
  const [record]=formatExecutionLog({mode:'JEV_DESKTOP',events:[
    {phase:'execute_request',step:1,actionId:'step_01',label:'Свернуть редактор',operation:'minimize'},
    {phase:'execute_result',step:1,result:{ok:true,verified:true,effectAttempted:false}},
    {phase:'verify',step:1,verified:true,outcome:'already_satisfied'},
  ],satisfiedPostconditions:[{step:1,id:'step_01',label:'Свернуть редактор',operation:'minimize'}]});
  assert.equal(record.status,'already_satisfied');
  assert.equal(record.statusLabel,'Уже в нужном состоянии');
});

test('exact exchange details redact credentials while preserving normalized usage counts', () => {
  const [step] = formatDecisionLog({calls: [{request: {...stepRequest(), authorization: 'Bearer secret-value'}, decision: {...stepDecision, apiKey: 'private-key'}}]});
  assert.doesNotMatch(step.requestJson + step.responseJson, /secret-value|private-key/u);
  assert.equal(JSON.parse(step.responseJson).usage.input_tokens, 125);
});

test('execution log distinguishes verified, executed and failed outcomes', () => {
  const report = currentReport({
    trace: [
      { phase: 'execute_request', step: 1, candidate: { id: 'a', label: 'Открыть редактор', operation: 'launch' } },
      { phase: 'execute_result', step: 1, receipt: { ok: true, stateChanged: true, verified: false, evidence: 'process_started' } },
      { phase: 'verify', step: 1, outcome: 'observed_change', evidence: 'window_not_observed' },
      { phase: 'execute_request', step: 2, candidate: { id: 'b', label: 'Закрыть редактор', operation: 'close' } },
      { phase: 'execute_result', step: 2, receipt: { ok: false, verified: false, evidence: 'window_missing' } },
      { phase: 'verify', step: 2, outcome: 'not_verified', evidence: 'window_missing' },
    ],
    completed: [],
  });
  const records = formatExecutionLog(report);
  assert.deepEqual(records.map(item => item.status), ['executed', 'failed']);
  assert.deepEqual(records.map(item => item.statusLabel), ['Выполнено', 'Не выполнено']);
  assert.equal(records[0].label, 'Открыть редактор');
  assert.equal(formatExecutionLog({ completed: [{ id: 'note', label: 'Сохранить заметку', operation: 'note', outcome: 'local_saved' }] })[0].status, 'executed');
});

test('future agent tool events map results and responses without exposing ids as primary copy', () => {
  const model = formatLogView({
    events: [
      { phase: 'agent_tool_call', toolCall: { id: 'tool_hash_42', name: 'windows_app_launch', arguments: { app: 'Калькулятор' } } },
      { phase: 'agent_tool_result', toolCallId: 'tool_hash_42', name: 'windows_app_launch', result: { ok: true, verified: false, evidence: 'window_started', message: 'Окно открыто.' } },
      { phase: 'agent_response', text: 'Готово <script>alert(1)</script>' },
    ],
    capabilities: [{ name: 'desktop', title: 'Работа с окнами', description: 'Открытие приложений.', available: false, reason: 'Не включено.' }],
    context: { turns: 3 },
  });
  assert.equal(model.executions[0].status, 'executed');
  assert.equal(model.executions[0].label, 'Открываю приложение');
  assert.doesNotMatch(model.executions[0].label, /tool_hash_42/u);
  assert.match(model.executions[0].dataSent, /Калькулятор/u);
  const idSafe = formatLogView({ events: [{ phase: 'agent_tool_call', toolCall: { id: 'tool_hash_42', name: 'note_get', arguments: { id: 'note_hash_999', title: 'Чай' } } }] });
  assert.doesNotMatch(idSafe.dataSent[0].value, /note_hash_999/u);
  assert.match(idSafe.dataSent[0].value, /идентификатор скрыт/u);
  assert.equal(model.agentResponses[0].text, 'Готово <script>alert(1)</script>');
  assert.equal(model.capabilities[0].available, false);
  assert.equal(model.context.turns, 3);
});

test('observation keeps coverage, available window and current controls bounded', () => {
  const observation = formatObservation(currentReport());
  assert.equal(observation.available, true);
  assert.equal(observation.availableWindow.title, 'Editor');
  assert.equal(observation.controls[0].name, 'Сохранить');
  assert.match(observation.coverage, /Наблюдение/u);
  const empty = formatObservation({});
  assert.equal(empty.available, false);
  assert.equal(empty.windows.length, 0);
});

test('compact Jev observations preserve the inspected window and incomplete coverage', () => {
  const observation={windows:[{title:'Другое окно',app:'other',active:false},{title:'Редактор',app:'editor',active:true}],controls:[{name:'Перенос строк',role:'CheckBox',toggleState:'On'}],inspected:{title:'Редактор'},coverage:{truncated:true}};
  const view=formatObservation({events:[{phase:'observe',observation}]});
  assert.equal(view.availableWindow.title,'Редактор');
  assert.equal(view.truncated,true);
  assert.match(view.coverage,/неполное/u);
  const data=formatDataSent({calls:[{request:{...stepRequest(),state:{...stepRequest().state,observation}},decision:stepDecision}]});
  assert.match(data.find(item=>item.label==='Наблюдение интерфейса').value,/Окон: 2; элементов: 1[\s\S]*Редактор/u);
});

test('capabilities preserve explicit availability and never invent enabled state', () => {
  const [known, unknown] = formatCapabilities({ capabilities: [
    { name: 'desktop', title: 'Окна', description: 'UI Automation', available: true },
    { name: 'voice', title: 'Голос', description: 'Неизвестно' },
  ] });
  assert.equal(known.available, true);
  assert.equal(unknown.available, null);
  const wrapped = formatCapabilities({ capabilities: { capabilities: [{ title: 'Обёрнутый список', description: 'ok', available: true }] } });
  assert.equal(wrapped[0].title, 'Обёрнутый список');
});

test('details view has readable sections, collapsed technical JSON and text-only rendering hooks', async () => {
  const html = await readFile(new URL('../scripts/desktop-lab/lab.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../scripts/desktop-lab/lab.js', import.meta.url), 'utf8');
  for (const id of ['readable-log', 'data-sent-list', 'decision-steps', 'execution-steps', 'readable-observation-meta', 'capability-list', 'new-conversation']) assert.match(html, new RegExp(`id="${id}"`, 'u'));
  assert.match(html, /Технический JSON и внутренние идентификаторы \(дополнительно\)/u);
  assert.match(js, /textContent/u);
  assert.doesNotMatch(js, /\.innerHTML\s*=/u);
});


test('readable agent projection hides tool/schema/evidence codes and keeps final answer text', () => {
  const report = {
    trace: [
      { phase: 'agent_response', text: '', responseCalls: [{ name: 'note_update', arguments: { id: 'provider-update-after-read', text: 'Новый текст', expectedText: 'Старый текст' } }] },
      { phase: 'agent_tool_call', title: 'Изменить заметку', toolCall: { id: 'provider-update-after-read', name: 'note_update', arguments: { id: 1, text: 'Новый текст', expectedText: 'Старый текст' } } },
      { phase: 'agent_tool_result', toolCallId: 'provider-update-after-read', name: 'note_update', title: 'Изменить заметку', result: { ok: false, verified: false, evidence: 'target_not_read', message: 'Сначала прочитайте эту заметку.' } },
      { phase: 'agent_response', text: '', responseCalls: [{ name: 'assistant_respond', arguments: { status: 'completed', text: 'Готово.', evidenceIds: ['provider-update-after-read'] } }] },
      { phase: 'agent_tool_call', title: 'Ответ пользователю', toolCall: { id: 'respond-1', name: 'assistant_respond', arguments: { status: 'completed', text: 'Готово.', evidenceIds: ['provider-update-after-read'] } } },
    ],
    capabilities: [{ name: 'windows_observe', title: 'Посмотреть окна', description: 'Read real Windows windows and windowId details.', available: true }],
  };
  const model = formatLogView(report);
  const visible = [
    ...model.dataSent.map(item => item.value),
    ...model.executions.flatMap(item => [item.label, item.message, item.evidence, item.dataSent, JSON.stringify(item.dataTree)]),
    ...model.agentResponses.map(item => item.text),
    ...model.capabilities.flatMap(item => [item.title, item.description, item.reason]),
  ].join('\n');
  assert.match(visible, /Готово/u);
  assert.doesNotMatch(visible, /note_update|note_get|assistant_respond|expectedText|evidenceIds|target_not_read|note_read|provider-update-after-read/u);
  assert.deepEqual(model.agentResponses, [{ index: 1, text: 'Готово.' }]);
  assert.equal(model.executions[0].label, 'Обновляю заметку');
  assert.match(model.executions[0].evidence, /Сначала прочитайте/u);
});

test('confirmed effect that still needs a fresh observation is visibly pending verification', () => {
  const [record] = formatExecutionLog({ events: [
    { phase: 'agent_tool_call', toolCall: { id: 'call-1', name: 'windows_execute', arguments: { actionId: 'action-1' } } },
    { phase: 'agent_tool_result', toolCallId: 'call-1', name: 'windows_execute', result: { ok: true, verified: false, effectConfirmed: true, needsObservation: true, message: 'Действие отправлено.' } },
  ] });
  assert.equal(record.status, 'pending_verification');
  assert.equal(record.statusLabel, 'Действие отправлено, проверяю результат');
});

test('agent live progress uses human labels and distinguishes pending verification', () => {
  assert.equal(formatAgentProgress({ phase: 'agent_request' }), 'Продумываю следующий шаг');
  assert.equal(formatAgentProgress({
    phase: 'agent_tool_call',
    title: 'Изменить заметку',
    toolCall: { id: 'provider-call-1', name: 'note_update', arguments: { id: 'provider-note-1' } },
  }), 'Обновляю заметку');
  assert.equal(formatAgentProgress({
    phase: 'agent_tool_result',
    name: 'windows_execute',
    result: { ok: true, verified: false, effectConfirmed: true, needsObservation: true },
  }), 'Действие отправлено, проверяю результат');
  const correction = formatAgentProgress({ phase: 'agent_tool_result', name: 'note_update', result: { ok: false } });
  assert.match(correction, /Исправляю следующий шаг/u);
  assert.doesNotMatch(correction, /note_update|provider-call-1/u);
  assert.equal(formatAgentProgress({ phase: 'agent_error' }), 'Не удалось получить ответ агента');
});

test('agent result trees show bounded human labels for windows and text fields while hiding identifiers', () => {
  const tree = formatDataTree({ snapshot: { windows: [{ id: 'window-1', title: 'Блокнот', active: true }], textFields: [{ id: 'field-1', name: 'Текст заметки', value: 'Привет' }], evidenceIds: ['provider-1'] }, data: { code: 'invalid_arguments' } });
  const visible = JSON.stringify(tree);
  assert.match(visible, /Снимок интерфейса|Окна|Текстовые поля|Блокнот|Текст заметки|Аргументы нужно исправить/u);
  assert.doesNotMatch(visible, /window-1|field-1|provider-1|evidenceIds/u);
  assert.ok(visible.length < 12000);
});


test('agent request data summary reports only safe metadata and labels legacy gaps honestly', () => {
  const report = {
    mode: 'AGENT_ASSISTANT',
    command: 'Сохрани заметку',
    context: { turnCount: 8, historyTurns: 8, toolCount: 12, commandIncluded: true, currentTimeIncluded: true, timeZone: 'Europe/Samara' },
    events: [{ phase: 'agent_request', text: 'Сохрани заметку', tools: Array.from({ length: 12 }, (_, index) => ({ name: 'tool_' + index })) }],
  };
  const values = formatDataSent(report).map(item => item.value).join('\\n');
  assert.match(values, /Сохрани заметку/u);
  assert.match(values, /12 описаний передано/u);
  assert.match(values, /Передан контекст предыдущих запросов: 8/u);
  assert.match(values, /часовым поясом Europe\/Samara/u);
  assert.doesNotMatch(values, /contents|prompt|Схема/u);
  const legacy = formatDataSent({ mode: 'AGENT_ASSISTANT', events: [{ phase: 'agent_finished', reason: 'agent_answer' }] });
  assert.equal(legacy.at(-1).value, 'Данные не записаны в этом старом отчёте.');
});
