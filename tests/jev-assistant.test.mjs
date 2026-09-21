import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JevAssistant } from '../desktop/agent/jev-assistant.mjs';
import { AgentCommands } from '../desktop/agent/commands.mjs';
import { RunJournal } from '../scripts/desktop-lab/journal.mjs';
import { describeResult } from '../desktop/automation/feedback.mjs';

const decision = (choice, extra = {}) => ({ choice, actionId: ['done', 'unavailable'].includes(choice) ? null : choice, probability: 0.96, confidence: 0.92, probabilities: { [choice]: 0.96 }, model: 'jev-test', latencyMs: 1, ...extra });
const response = choice => ({ model: 'jev-test', answers: { next_step: { type: 'choice', choice, confidence: 0.92, probabilities: { [choice]: 1 } } }, usage: { input_tokens: 20, output_tokens: 10 } });

async function directoryFor(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jeff-jev-assistant-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function delegate(overrides = {}) {
  return {
    calls: [], stops: 0, clears: 0, running: false,
    async run(input) {
      this.calls.push(input);
      return { runId: 'child-run', mode: 'JEV_DESKTOP', ok: true, reason: 'goal_verified', message: 'Выполнено.', calls: [], completed: [], events: [] };
    },
    stop() { this.stops += 1; },
    clearContext() { this.clears += 1; return true; },
    capabilities() { return []; },
    ...overrides,
  };
}

async function fixture(t, options = {}) {
  const directory = await directoryFor(t);
  const desktop = options.desktop ?? delegate();
  const data = options.data ?? delegate({ capabilities: () => [{ name: 'note_create', available: true, effect: true }] });
  const inputs = [];
  const service = new JevAssistant({
    directory, desktopCommands: desktop, dataCommands: data,
    apiKeyResolver: async () => 'test-key-not-a-real-secret',
    choose: async (input, callbacks) => {
      inputs.push(input);
      await callbacks.onResponse(response(options.route ?? 'desktop'));
      return decision(options.route ?? 'desktop');
    },
    ...options.service,
  });
  return { service, desktop, data, directory, inputs };
}

test('desktop requests are routed by Jev directly to its loop without calling the data model', async t => {
  const f = await fixture(t);
  const report = await f.service.run({ command: 'открой Блокнот' });
  assert.equal(report.ok, true);
  assert.equal(report.reason, 'goal_verified');
  assert.equal(report.provider, 'jev');
  assert.equal(report.routing.route, 'desktop');
  assert.equal(report.delegation.provider, 'jev');
  assert.equal(f.desktop.calls.length, 1);
  assert.equal(f.desktop.calls[0].mode, 'desktop');
  assert.ok(f.desktop.calls[0].signal instanceof AbortSignal);
  assert.equal(f.data.calls.length, 0);
  assert.equal(f.inputs.length, 1);
  assert.deepEqual(f.inputs[0].candidates.map(item => item.id), ['desktop', 'memory', 'conversation']);
  assert.deepEqual(report.calls.map(item => item.provider), ['jev']);
  const saved = JSON.parse(await fs.readFile(report.logPath, 'utf8'));
  assert.equal(saved.routing.route, 'desktop');
  assert.equal(saved.status, 'finished');
  assert.notEqual(report.runId, report.childRunId);
  assert.equal(f.service.running, false);
  assert.equal(f.service.activeRunId, null);
});

test('memory keeps the existing data agent and flattens its receipt evidence into the root journal', async t => {
  const directory = await directoryFor(t), seen = [], notes = [];
  let step = 0;
  const data = new AgentCommands({
    directory,
    createTools: () => [{ name: 'note_create', title: 'Создать заметку', description: 'Save a note.', effect: true,
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      execute: async ({ text }) => { notes.push(text); return { ok: true, verified: true, effectAttempted: true, evidence: ['saved'], message: 'Заметка сохранена.', data: { id: 1 } }; },
    }],
    modelStep: async payload => {
      seen.push(payload);
      if (++step === 1) return { content: { role: 'model', parts: [{ functionCall: { name: 'note_create', args: { text: 'Купить чай' }, id: 'save-note' } }] } };
      const evidenceId = payload.contents.flatMap(item => item.parts ?? []).find(item => item.functionResponse?.name === 'note_create').functionResponse.response.evidenceId;
      return { content: { role: 'model', parts: [{ functionCall: { name: 'assistant_respond', args: { status: 'completed', text: 'Заметка сохранена.', evidenceIds: [evidenceId] } } }] } };
    },
  });
  const desktop = delegate();
  const service = new JevAssistant({ directory, desktopCommands: desktop, dataCommands: data, apiKeyResolver: async () => 'test', choose: async () => decision('memory') });
  const report = await service.run({ command: 'запиши заметку Купить чай' });
  assert.deepEqual(notes, ['Купить чай']);
  assert.equal(desktop.calls.length, 0);
  assert.equal(report.reason, 'agent_completed');
  assert.equal(report.provider, 'gemini');
  assert.equal(report.routingProvider, 'jev');
  assert.deepEqual(seen[0].tools.map(item => item.name), ['note_create', 'assistant_respond']);
  assert.equal(describeResult(report).tone, 'success');
  const receipt = report.events.find(item => item.phase === 'agent_tool_result' && item.name === 'note_create');
  assert.equal(receipt.runId, report.runId);
  assert.equal(receipt.sourceRunId, report.childRunId);
  assert.equal(receipt.result.evidenceId, report.evidenceIds[0]);
  assert.deepEqual(report.events.map(item => item.sequence), report.events.map((_, index) => index + 1));
  assert.ok(report.events.findIndex(item => item.phase === 'route_decision') < report.events.findIndex(item => item.phase === 'agent_request'));
  const saved = JSON.parse(await fs.readFile(report.logPath, 'utf8'));
  assert.equal(describeResult(saved).tone, 'success');
});

test('conversation uses the bounded data/conversation delegate and preserves compact follow-up context', async t => {
  const data = delegate({ async run(input) {
    this.calls.push(input);
    return { runId: `data-${this.calls.length}`, mode: 'AGENT_ASSISTANT', ok: false, reason: 'clarification_required', needsClarification: true, message: 'Во сколько завтра?', completed: [], events: [] };
  } });
  const inputs = [];
  const f = await fixture(t, { data, service: { choose: async input => { inputs.push(input); return decision(inputs.length === 1 ? 'memory' : 'conversation'); } } });
  await f.service.run({ command: 'напомни завтра купить чай' });
  await f.service.run({ command: 'в пять вечера' });
  assert.equal(f.desktop.calls.length, 0);
  assert.equal(data.calls.length, 2);
  assert.equal(data.calls[1].mode, 'chat');
  assert.equal(inputs[1].recentSteps.length, 1);
  assert.equal(inputs[1].recentSteps[0].route, 'memory');
  assert.equal(inputs[1].recentSteps[0].needsClarification, true);
  assert.equal(inputs[1].recentSteps[0].reply, 'Во сколько завтра?');
  assert.equal('snapshot' in inputs[1].recentSteps[0], false);
  assert.equal(f.service.clearContext(), true);
  await f.service.run({ command: 'почему небо голубое?' });
  assert.deepEqual(inputs[2].recentSteps, []);
  assert.equal(data.clears, 1);
});

test('low probability or confidence and unavailable route never fall back to either delegate', async t => {
  for (const choice of [decision('desktop', { probability: 0.79 }), decision('desktop', { confidence: 0.79 }), decision('unavailable'), decision('done')]) {
    const f = await fixture(t, { service: { choose: async () => choice } });
    const report = await f.service.run({ command: 'сделай это' });
    assert.equal(report.ok, false);
    assert.ok(['low_confidence', 'no_request'].includes(report.reason));
    assert.equal(f.desktop.calls.length + f.data.calls.length, 0);
    assert.equal(report.events.some(item => item.phase.endsWith('delegate_request')), false);
  }
});

test('unknown or mismatched route IDs and provider failures cannot reach Gemini or desktop execution', async t => {
  const choices = [decision('shell'), decision('desktop', { actionId: 'memory' }), decision('desktop', { actionId: null }), decision('desktop', { probability: Number.NaN })];
  for (const choice of choices) {
    const f = await fixture(t, { service: { choose: async () => choice } });
    const report = await f.service.run({ command: 'открой Блокнот' });
    assert.equal(report.reason, 'routing_failed');
    assert.equal(report.error, 'JEV_ROUTE_INVALID_RESPONSE');
    assert.equal(f.desktop.calls.length + f.data.calls.length, 0);
  }
  const f = await fixture(t, { service: { choose: async () => { throw new Error('private-provider-response'); } } });
  const report = await f.service.run({ command: 'открой Блокнот' });
  assert.equal(report.reason, 'routing_failed');
  assert.equal(f.desktop.calls.length + f.data.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(report), /private-provider-response/);
});

test('missing TypeSafe credentials fail closed instead of switching to a data model', async t => {
  let choices = 0;
  const f = await fixture(t, { service: { apiKeyResolver: async () => '', choose: async () => { choices++; return decision('desktop'); } } });
  const report = await f.service.run({ command: 'открой Блокнот' });
  assert.equal(report.error, 'TYPESAFE_KEY_MISSING');
  assert.equal(choices, 0);
  assert.equal(f.desktop.calls.length + f.data.calls.length, 0);
});

test('Stop aborts the routing request, clears context and prevents a late route from executing', async t => {
  let enter, release, capturedSignal;
  const entered = new Promise(resolve => { enter = resolve; });
  const f = await fixture(t, { service: { choose: async (_input, { signal }) => {
    capturedSignal = signal; enter();
    await new Promise(resolve => { release = resolve; });
    return decision('desktop');
  } } });
  const pending = f.service.run({ command: 'открой Блокнот' });
  await entered;
  assert.equal(f.service.running, true);
  assert.ok(f.service.activeRunId);
  assert.equal(f.service.clearContext(), false);
  assert.throws(() => f.service.run({ command: 'ещё команда' }), { code: 'TASK_ALREADY_RUNNING' });
  assert.equal(f.service.stop(), true);
  assert.equal(capturedSignal.aborted, true);
  release();
  const report = await pending;
  assert.equal(report.reason, 'aborted');
  assert.equal(report.executionUncertain, false);
  assert.equal(f.desktop.calls.length + f.data.calls.length, 0);
  assert.equal(f.data.stops, 1);
  assert.equal(f.service.running, false);
});

test('external cancellation preserves completed child evidence and stops further delegation', async t => {
  const abort = new AbortController();
  const desktop = delegate({ async run(input) {
    this.calls.push(input); abort.abort();
    return { runId: 'partial-child', ok: false, reason: 'aborted', executionUncertain: false,
      completed: [{ id: 'a1', operation: 'minimize', outcome: 'verified' }],
      events: [{ phase: 'execute_result', runId: 'partial-child', sequence: 1, receipt: { operation: 'minimize', verified: true, effectAttempted: true } }] };
  } });
  const f = await fixture(t, { desktop });
  const report = await f.service.run({ command: 'сверни Блокнот', signal: abort.signal });
  assert.equal(report.reason, 'aborted');
  assert.equal(report.completed.length, 1);
  assert.equal(report.events.some(item => item.phase === 'execute_result'), true);
  assert.equal(f.data.calls.length, 0);
  assert.equal(desktop.stops, 1);
});

test('journal failure before delegation prevents all effects and late child failures remain uncertain', async t => {
  const f = await fixture(t, { service: { journalFactory: async (...args) => {
    const journal = await RunJournal.create(...args), record = journal.record.bind(journal);
    journal.record = (phase, data) => phase === 'desktop_delegate_request' ? Promise.reject(Object.assign(new Error(), { code: 'LOG_WRITE_FAILED' })) : record(phase, data);
    return journal;
  } } });
  const report = await f.service.run({ command: 'открой Блокнот' });
  assert.equal(report.reason, 'LOG_WRITE_FAILED');
  assert.equal(f.desktop.calls.length + f.data.calls.length, 0);
  const broken = await fixture(t, { desktop: delegate({ async run() { throw new Error('native-private-details'); } }) });
  const uncertain = await broken.service.run({ command: 'открой Блокнот' });
  assert.equal(uncertain.reason, 'delegation_failed');
  assert.equal(uncertain.executionUncertain, true);
  assert.doesNotMatch(JSON.stringify(uncertain), /native-private-details/);
});

test('forced modes restrict route candidates and capabilities disclose separate provider roles', async t => {
  const desktop = delegate({ capabilities: () => [{ name: 'desktop_observe', available: true, effect: false }] });
  const inputs = [];
  const f = await fixture(t, { desktop, service: { choose: async input => { inputs.push(input); return decision(input.candidates[0].id); } } });
  await f.service.run({ command: 'открой Блокнот', mode: 'desktop' });
  await f.service.run({ command: 'объясни, как открыть Блокнот', mode: 'chat' });
  assert.deepEqual(inputs[0].candidates.map(item => item.id), ['desktop']);
  assert.deepEqual(inputs[1].candidates.map(item => item.id), ['conversation']);
  assert.equal(f.data.calls[0].mode, 'chat');
  assert.deepEqual(f.service.capabilities().map(({ name, route, provider }) => ({ name, route, provider })), [
    { name: 'desktop_observe', route: 'desktop', provider: 'jev' },
    { name: 'note_create', route: 'memory', provider: 'gemini' },
  ]);
});

test('pre-aborted input does not discover credentials or call either model', async t => {
  let keys = 0;
  const f = await fixture(t, { service: { apiKeyResolver: async () => { keys++; return 'test'; } } });
  const abort = new AbortController(); abort.abort();
  const report = await f.service.run({ command: 'открой Блокнот', signal: abort.signal });
  assert.equal(report.reason, 'aborted');
  assert.equal(keys, 0);
  assert.equal(f.inputs.length, 0);
  assert.equal(f.desktop.calls.length + f.data.calls.length, 0);
});

test('an unresolved native child retains the facade single-flight lock after its uncertainty report', async t => {
  const desktop = delegate({ async run(input) {
    this.calls.push(input); this.running = true; this.activeRunId = 'uncertain-child';
    return { runId: this.activeRunId, ok: false, reason: 'execution_uncertain', executionUncertain: true, completed: [], events: [] };
  } });
  const f = await fixture(t, { desktop });
  const report = await f.service.run({ command: 'открой Блокнот' });
  assert.equal(f.service.running, true);
  assert.equal(f.service.activeRunId, report.runId);
  assert.equal(f.service.clearContext(), false);
  assert.throws(() => f.service.run({ command: 'сверни Блокнот' }), { code: 'TASK_ALREADY_RUNNING' });
  desktop.running = false; desktop.activeRunId = null;
  assert.equal(f.service.running, false);
  assert.equal(f.service.activeRunId, null);
  assert.equal(f.service.clearContext(), true);
});
