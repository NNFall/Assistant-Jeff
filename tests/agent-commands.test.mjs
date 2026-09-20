import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentCommands } from '../desktop/agent/commands.mjs';

const noteSchema = {
  type: 'object',
  properties: { query: { type: 'string', minLength: 1, maxLength: 100 } },
  required: ['query'],
  additionalProperties: false,
};
const updateSchema = {
  type: 'object',
  properties: { entityId: { type: 'string', minLength: 1 }, text: { type: 'string', minLength: 1, maxLength: 100 } },
  required: ['entityId', 'text'],
  additionalProperties: false,
};
const responseArgs = (status, text, evidenceIds = []) => ({
  functionCall: { name: 'assistant_respond', args: { status, text, evidenceIds }, id: `response-${status}` },
});

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-jeff-agent-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function toolsFor(state = {}) {
  return [
    {
      name: 'note_search', title: 'Search notes', description: 'Read the current note state.', parameters: noteSchema, effect: false,
      execute: async args => ({ ok: true, verified: true, effectAttempted: false, evidence: ['search-receipt'], message: `Found ${args.query}`, data: { entityId: state.entityId ?? 'note-1', id: 7, windows: [{ id: 'window-local' }], actions: [{ id: 'action-local' }], snapshot: { stale: true }, actionId: 'old-action' } }),
    },
    {
      name: 'note_update', title: 'Update note', description: 'Update a note after reading it in this run.', parameters: updateSchema, effect: true,
      execute: async (args, context) => {
        state.updates = (state.updates ?? 0) + 1;
        state.lastContext = context;
        return { ok: true, verified: true, effectAttempted: true, evidence: [`update-${state.updates}`], message: `Updated ${args.entityId}`, data: { entityId: args.entityId } };
      },
    },
  ];
}

test('multi-step agent preserves opaque signatures in next payload and records only readable journal data', async t => {
  const directory = await tempDirectory(t);
  const seen = [];
  const state = {};
  let updateEvidenceId;
  let step = 0;
  const service = new AgentCommands({
    directory,
    createTools: () => toolsFor(state),
    modelStep: async (payload) => {
      seen.push(payload);
      step += 1;
      if (step === 1) return { model: 'mock', latencyMs: 3, usage: { totalTokenCount: 4 }, content: { role: 'model', parts: [{ functionCall: { name: 'note_search', args: { query: 'milk' }, id: 'search-1' }, thoughtSignature: 'opaque-search' }] } };
      if (step === 2) {
        assert.ok(JSON.stringify(payload.contents).includes('opaque-search'));
        return { model: 'mock', latencyMs: 4, content: { role: 'model', parts: [{ functionCall: { name: 'note_update', args: { entityId: 'note-1', text: 'buy milk' }, id: 'update-1' }, thoughtSignature: 'opaque-update' }] } };
      }
      updateEvidenceId = payload.contents.flatMap(content => content.parts ?? []).find(part => part.functionResponse?.name === 'note_update')?.functionResponse.response.evidenceId;
      return { model: 'mock', latencyMs: 5, content: { role: 'model', parts: [responseArgs('completed', 'Заметка обновлена.', [updateEvidenceId])] } };
    },
  });

  const report = await service.run({ command: 'обнови заметку про молоко' });
  assert.equal(report.ok, true);
  assert.equal(report.reason, 'agent_completed');
  assert.equal(report.context.historyTurns, 0);
  assert.equal(report.context.toolCount, seen[0].tools.length);
  assert.equal(report.context.commandIncluded, true);
  assert.equal(report.context.currentTimeIncluded, true);
  assert.equal(report.context.timeZone, seen[0].context.timeZone);
  assert.deepEqual(report.evidenceIds, [updateEvidenceId]);
  assert.deepEqual(report.completed[0], { operation: 'note_update', id: report.evidenceIds[0], label: 'Update note', outcome: 'verified', evidence: [report.evidenceIds[0]] });
  assert.deepEqual(Object.keys(seen[0]), ['contents', 'tools', 'context']);
  assert.deepEqual(Object.keys(seen[0].tools[0]).sort(), ['description', 'name', 'parameters']);
  assert.deepEqual(Object.keys(seen[0].context).sort(), ['capabilities', 'nowIso', 'timeZone']);
  assert.ok(JSON.stringify(report).includes('Заметка обновлена.'));
  assert.doesNotMatch(JSON.stringify(report), /opaque-(?:search|update)/u);
  const files = (await fs.readdir(directory)).filter(name => name.endsWith('.json') && !name.endsWith('.tmp'));
  const saved = JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8'));
  assert.doesNotMatch(JSON.stringify(saved), /opaque-(?:search|update)/u);
  assert.ok(saved.events.some(event => event.phase === 'agent_tool_result' && event.toolCallId === report.evidenceIds[0]));
  assert.deepEqual(saved.events.find(event => event.phase === 'agent_request').context, report.context);
});

test('providerless function calls get a local evidence id but no synthetic function response id', async t => {
  const directory = await tempDirectory(t);
  let step = 0;
  let localId;
  const service = new AgentCommands({
    directory,
    createTools: () => [{
      name: 'read', title: 'Read', description: 'Read current state.', effect: false,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: async () => ({ ok: true, verified: true, effectAttempted: false, message: 'Read.' }),
    }],
    modelStep: async payload => {
      step += 1;
      if (step === 1) return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ functionCall: { name: 'read', args: {} } }] } };
      const response = payload.contents.flatMap(content => content.parts ?? []).find(part => part.functionResponse?.name === 'read')?.functionResponse;
      assert.ok(response);
      assert.equal(Object.hasOwn(response, 'id'), false);
      assert.equal(typeof response.response.evidenceId, 'string');
      localId = response.response.evidenceId;
      return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [responseArgs('completed', 'Прочитано.', [localId])] } };
    },
  });
  const report = await service.run({ command: 'прочитай состояние' });
  assert.equal(report.reason, 'agent_completed');
  assert.deepEqual(report.evidenceIds, [localId]);
  const callEvent = report.trace.find(event => event.phase === 'agent_tool_call');
  const resultEvent = report.trace.find(event => event.phase === 'agent_tool_result');
  assert.equal(callEvent.toolCall.id, localId);
  assert.equal(resultEvent.toolCallId, localId);
});

test('text-only question is kept in context until assistant_respond clarification', async t => {
  const directory = await tempDirectory(t);
  let step = 0;
  const service = new AgentCommands({
    directory,
    createTools: () => [],
    modelStep: async payload => {
      step += 1;
      if (step === 1) return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ text: 'Какую заметку изменить?' }] } };
      assert.match(JSON.stringify(payload.contents), /Какую заметку изменить\?/u);
      assert.match(JSON.stringify(payload.contents), /assistant_respond/u);
      return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [responseArgs('clarification', 'Уточни название заметки.')] } };
    },
  });
  const report = await service.run({ command: 'измени заметку' });
  assert.equal(report.reason, 'clarification_required');
  assert.equal(report.needsClarification, true);
  assert.equal(step, 2);
});

test('text-only answer requires assistant_respond before it is returned', async t => {
  const directory = await tempDirectory(t);
  let step = 0;
  const service = new AgentCommands({
    directory,
    createTools: () => [],
    modelStep: async payload => {
      step += 1;
      if (step === 1) return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ text: 'Сейчас 12:00.' }] } };
      return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [responseArgs('answer', 'Сейчас 12:00.')] } };
    },
  });
  const report = await service.run({ command: 'который час' });
  assert.equal(report.reason, 'agent_answer');
  assert.equal(report.message, 'Сейчас 12:00.');
  assert.equal(step, 2);
});

test('repeated text-only responses stop after bounded protocol corrections', async t => {
  const directory = await tempDirectory(t);
  let step = 0;
  const service = new AgentCommands({
    directory,
    maxSteps: 8,
    createTools: () => [],
    modelStep: async () => {
      step += 1;
      return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ text: `Ответ ${step}` }] } };
    },
  });
  const report = await service.run({ command: 'ответь' });
  assert.equal(report.reason, 'agent_incomplete');
  assert.equal(report.ok, false);
  assert.equal(step, 3);
});

test('clarification becomes grounded history and entity ids survive while snapshots do not', async t => {
  const directory = await tempDirectory(t);
  let run = 0;
  let firstStep = true;
  let secondPayload;
  const service = new AgentCommands({
    directory,
    createTools: () => toolsFor(),
    modelStep: async payload => {
      if (run === 0) {
        if (firstStep) { firstStep = false; return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ functionCall: { name: 'note_search', args: { query: 'todo' }, id: 'read-1' } }] } }; }
        run += 1;
        return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [responseArgs('clarification', 'Какую строку изменить?')] } };
      }
      secondPayload = payload;
      return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [responseArgs('answer', 'Уточнение получено.')] } };
    },
  });
  const first = await service.run({ command: 'найди заметку todo' });
  assert.equal(first.reason, 'clarification_required');
  const second = await service.run({ command: 'используй note-1' });
  assert.equal(second.reason, 'agent_answer');
  assert.ok(JSON.stringify(secondPayload.contents).includes('entityId'));
  assert.match(secondPayload.contents[0].parts[0].text, /"id":7/u);
  assert.doesNotMatch(JSON.stringify(secondPayload.contents), /snapshot|actionId|old-action/u);
  assert.doesNotMatch(JSON.stringify(secondPayload.contents), /windows|window-local|actions|action-local/u);
});

test('bad arguments and unknown tools are correction results and never dispatch effects', async t => {
  const directory = await tempDirectory(t);
  let updates = 0;
  let step = 0;
  const service = new AgentCommands({
    directory,
    createTools: () => [{ name: 'write', title: 'Write', description: 'Write data.', parameters: updateSchema, effect: true, execute: async () => { updates += 1; return { ok: true, verified: true, effectAttempted: true, evidence: ['write-1'] }; } }],
    modelStep: async () => {
      step += 1;
      if (step === 1) return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ functionCall: { name: 'write', args: { entityId: 'note-1', text: 'x', extra: true }, id: 'bad-1' } }] } };
      return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [responseArgs('answer', 'Аргументы исправлены не были.')] } };
    },
  });
  const report = await service.run({ command: 'запиши' });
  assert.equal(report.reason, 'agent_answer');
  assert.equal(updates, 0);
  assert.ok(report.trace.some(event => event.phase === 'agent_tool_result' && event.result?.data?.code === 'invalid_arguments'));
});

test('tool calls are sequential and cancellation after a receipt prevents following effects', async t => {
  const directory = await tempDirectory(t);
  const controller = new AbortController();
  let updates = 0;
  const events = [];
  const service = new AgentCommands({
    directory,
    progress: event => { events.push(event); if (event.phase === 'agent_tool_result' && event.name === 'read') controller.abort(); },
    createTools: () => [{ name: 'read', title: 'Read', description: 'Read.', parameters: { type: 'object', properties: {}, required: [] }, effect: false, execute: async () => ({ ok: true, verified: true, effectAttempted: false, evidence: ['read-1'] }) }, { name: 'write', title: 'Write', description: 'Write.', parameters: { type: 'object', properties: {}, required: [] }, effect: true, execute: async () => { updates += 1; return { ok: true, verified: true, effectAttempted: true, evidence: ['write-1'] }; } }],
    modelStep: async () => ({ model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ functionCall: { name: 'read', args: {}, id: 'read-1' } }, { functionCall: { name: 'write', args: {}, id: 'write-1' } }] } }),
  });
  const report = await service.run({ command: 'прочитай и запиши', signal: controller.signal });
  assert.equal(report.reason, 'aborted');
  assert.equal(updates, 0);
  const readCallIndex = events.findIndex(event => event.phase === 'agent_tool_call' && event.title === 'Read');
  const readResultIndex = events.findIndex(event => event.phase === 'agent_tool_result' && event.name === 'read');
  assert.ok(readCallIndex < readResultIndex);
  assert.equal(events.some(event => event.phase === 'agent_tool_call' && event.title === 'Write'), false);
});

test('partial verified effects are preserved when a later effect is uncertain', async t => {
  const directory = await tempDirectory(t);
  let step = 0;
  const service = new AgentCommands({
    directory,
    createTools: () => [{ name: 'first', title: 'First', description: 'First.', parameters: { type: 'object', properties: {}, required: [] }, effect: true, execute: async () => ({ ok: true, verified: true, effectAttempted: true, evidence: ['first-1'] }) }, { name: 'second', title: 'Second', description: 'Second.', parameters: { type: 'object', properties: {}, required: [] }, effect: true, execute: async () => ({ ok: true, verified: false, effectAttempted: true, evidence: [] }) }],
    modelStep: async payload => {
      step += 1;
      return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: step === 1 ? [{ functionCall: { name: 'first', args: {}, id: 'first-1' } }, { functionCall: { name: 'second', args: {}, id: 'second-1' } }] : [responseArgs('completed', 'Готово.', ['first-1'])] } };
    },
  });
  const report = await service.run({ command: 'сделай два шага' });
  assert.equal(report.reason, 'execution_uncertain');
  assert.equal(report.executionUncertain, true);
  assert.equal(report.completed.length, 1);
  assert.equal(report.completed[0].id, report.completed[0].evidence[0]);
  assert.equal(step, 1);
});

test('completed without a valid receipt cannot claim success, and provider errors are bounded', async t => {
  const directory = await tempDirectory(t);
  const service = new AgentCommands({
    directory,
    createTools: () => [{ name: 'write', title: 'Write', description: 'Write.', parameters: { type: 'object', properties: {}, required: [] }, effect: true, execute: async () => ({ ok: true, verified: true, effectAttempted: true, evidence: ['write-1'] }) }],
    modelStep: async () => ({ model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ functionCall: { name: 'write', args: {}, id: 'write-1' } }, responseArgs('completed', 'Ложно готово.', [])] } }),
  });
  const report = await service.run({ command: 'запиши' });
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'agent_incomplete');
  assert.equal(report.completed.length, 0);

  const broken = new AgentCommands({ directory, createTools: () => [], modelStep: async () => { throw new Error('private provider token'); } });
  const errorReport = await broken.run({ command: 'ответь' });
  assert.equal(errorReport.reason, 'provider_error');
  assert.doesNotMatch(JSON.stringify(errorReport), /private provider token/u);
});

test('invalid completion evidence is corrected without repeating the mutation', async t => {
  const directory = await tempDirectory(t);
  let step = 0;
  let mutations = 0;
  let correctionPayload;
  const service = new AgentCommands({
    directory,
    createTools: () => [{ name: 'write', title: 'Write', description: 'Write.', parameters: { type: 'object', properties: {}, required: [] }, effect: true, execute: async () => { mutations += 1; return { ok: true, verified: true, effectAttempted: true, data: { entityId: 'note-1' } }; } }],
    modelStep: async payload => {
      step += 1;
      if (step === 1) return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ functionCall: { name: 'write', args: {}, id: 'write-1' } }] } };
      if (step === 2) return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [responseArgs('completed', 'Сохранено.', [])] } };
      correctionPayload = payload;
      const responses = payload.contents.flatMap(content => content.parts ?? []).filter(part => part.functionResponse).map(part => part.functionResponse);
      const correction = responses.find(response => response.response?.status === 'invalid_evidence');
      if (correction) {
        assert.equal(correction.response.data.validEvidenceIds.length, 1);
        return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [responseArgs('completed', 'Сохранено.', correction.response.data.validEvidenceIds)] } };
      }
      return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [responseArgs('incomplete', 'Ожидаю подтверждение.')] } };
    },
  });
  const report = await service.run({ command: 'сохрани' });
  assert.equal(report.reason, 'agent_completed');
  assert.equal(mutations, 1);
  assert.ok(correctionPayload);
});

test('confirmed UI dispatch needs a dedicated fresh observation before another mutation', async t => {
  const directory = await tempDirectory(t);
  let step = 0;
  let invokes = 0;
  let writes = 0;
  const service = new AgentCommands({
    directory,
    createTools: () => [{ name: 'ui_invoke', title: 'Invoke', description: 'Dispatch UI action.', parameters: { type: 'object', properties: {}, required: [] }, effect: true, execute: async () => { invokes += 1; return { ok: true, verified: false, effectAttempted: true, effectConfirmed: true, needsObservation: true, message: 'Dispatched.' }; } }, { name: 'clock_now', title: 'Clock', description: 'Read time.', parameters: { type: 'object', properties: {}, required: [] }, effect: false, execute: async () => ({ ok: true, verified: true, effectAttempted: false }) }, { name: 'ui_observe', title: 'Observe UI', description: 'Read current UI.', observation: true, parameters: { type: 'object', properties: {}, required: [] }, effect: false, execute: async () => ({ ok: true, verified: true, effectAttempted: false, data: { entityId: 'control-1' } }) }, { name: 'ui_write', title: 'Write UI', description: 'Second UI action.', parameters: { type: 'object', properties: {}, required: [] }, effect: true, execute: async () => { writes += 1; return { ok: true, verified: true, effectAttempted: true }; } }],
    modelStep: async payload => {
      step += 1;
      if (step === 1) return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ functionCall: { name: 'ui_invoke', args: {}, id: 'invoke-1' } }] } };
      if (step === 2) return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ functionCall: { name: 'clock_now', args: {}, id: 'clock-1' } }] } };
      if (step === 3) return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ functionCall: { name: 'ui_observe', args: {}, id: 'observe-1' } }] } };
      if (step === 4) return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ functionCall: { name: 'ui_write', args: {}, id: 'write-1' } }] } };
      const evidence = payload.contents.flatMap(content => content.parts ?? []).filter(part => part.functionResponse).map(part => part.functionResponse).filter(response => ['ui_observe', 'ui_write'].includes(response.name)).map(response => response.response.evidenceId).filter(Boolean);
      return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [responseArgs('completed', 'Готово.', evidence)] } };
    },
  });
  const report = await service.run({ command: 'измени интерфейс' });
  assert.equal(report.reason, 'agent_completed');
  assert.equal(invokes, 1);
  assert.equal(writes, 1);
  const invoke = report.completed.find(item => item.label === 'Invoke');
  const observeEvidenceId = report.trace.find(event => event.phase === 'agent_tool_result' && event.name === 'ui_observe')?.result?.evidenceId;
  assert.equal(invoke.outcome, 'observed_change');
  assert.equal(invoke.verifiedBy, observeEvidenceId);
});

test('context can be cleared while idle and limits terminate bounded runs', async t => {
  const directory = await tempDirectory(t);
  let calls = 0;
  const service = new AgentCommands({
    directory,
    maxSteps: 1,
    createTools: () => [],
    modelStep: async () => { calls += 1; return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ functionCall: { name: 'unknown', args: {}, id: 'unknown-1' } }] } }; },
  });
  const report = await service.run({ command: 'повтори' });
  assert.equal(report.reason, 'agent_incomplete');
  assert.equal(calls, 1);
  assert.equal(service.clearContext(), true);
  assert.equal(service.running, false);
  assert.equal(service.activeRunId, null);
  assert.deepEqual(service.capabilities().map(item => item.name), []);
});

test('stop aborts an in-flight model step with the run AbortSignal', async t => {
  const directory = await tempDirectory(t);
  let seenSignal;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const service = new AgentCommands({
    directory,
    timeoutMs: 5000,
    createTools: () => [],
    modelStep: async (_payload, { signal }) => {
      seenSignal = signal;
      started();
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
      return { model: 'mock', latencyMs: 0, content: { role: 'model', parts: [{ text: 'unexpected' }] } };
    },
  });
  const pending = service.run({ command: 'останови зависший шаг' });
  await startedPromise;
  assert.ok(seenSignal instanceof AbortSignal);
  assert.equal(service.running, true);
  assert.equal(service.stop(), true);
  const report = await pending;
  assert.equal(report.reason, 'aborted');
  assert.equal(report.executionUncertain, false);
  assert.equal(service.running, false);
});
