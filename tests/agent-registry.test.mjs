import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalToolRegistry, validateToolArguments } from '../desktop/agent/registry.mjs';

const schema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 2, maxLength: 40 },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    labels: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['work', 'home'] } },
    nested: { type: 'object', properties: { entityId: { type: 'string', minLength: 1 } }, required: ['entityId'] },
  },
  required: ['title', 'priority'],
  additionalProperties: false,
};

test('local registry validates recursively and rejects unknown keys before dispatch', async () => {
  let executions = 0;
  const registry = new LocalToolRegistry([{
    name: 'save_note',
    title: 'Save note',
    description: 'Save a local note.',
    parameters: schema,
    effect: true,
    execute: async args => {
      executions += 1;
      return { ok: true, verified: true, effectAttempted: true, evidence: ['receipt-1'], message: args.title };
    },
  }]);

  const bad = await registry.dispatch('save_note', {
    title: 'ok', priority: 7, nested: { entityId: 'x', stale: true }, labels: ['cloud'], extra: true,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.effectAttempted, false);
  assert.equal(bad.data.code, 'invalid_arguments');
  assert.ok(bad.data.errors.some(error => error.code === 'unknown_key'));
  assert.ok(bad.data.errors.some(error => error.code === 'max'));
  assert.equal(executions, 0);

  const unknown = await registry.dispatch('run_shell', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.effectAttempted, false);
  assert.equal(unknown.data.code, 'unknown_tool');
  assert.equal(executions, 0);

  const valid = await registry.dispatch('save_note', {
    title: 'Hello', priority: 3, labels: ['work'], nested: { entityId: 'note-1' },
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.verified, true);
  assert.equal(valid.effectAttempted, true);
  assert.deepEqual(valid.evidence, ['receipt-1']);
  assert.equal(executions, 1);
});

test('schema helper reports structured correction errors and descriptor execution receives context', async () => {
  const errors = validateToolArguments({ type: 'object', properties: { value: { type: 'number', min: 0, max: 10 } }, required: ['value'] }, { value: -1 });
  assert.equal(errors.ok, false);
  assert.equal(errors.code, 'invalid_arguments');
  assert.equal(errors.errors[0].path, '$.value');

  let seen;
  const registry = new LocalToolRegistry([{
    name: 'inspect',
    title: 'Inspect',
    description: 'Read current facts.',
    parameters: { type: 'object', properties: {}, required: [] },
    effect: false,
    execute: async (args, context) => {
      seen = { args, context };
      return { ok: true, verified: true, effectAttempted: false, evidence: ['read-1'], data: { entityId: 'entity-1' } };
    },
  }]);
  const result = await registry.dispatch('inspect', {}, { signal: new AbortController().signal, context: { runId: 'run-1' } });
  assert.equal(result.ok, true);
  assert.equal(seen.context.context.runId, 'run-1');
});

test('reserved response tool cannot be supplied by a local descriptor', () => {
  assert.throws(() => new LocalToolRegistry([{
    name: 'assistant_respond', title: 'Spoof', description: 'Spoof final response.', effect: false,
    parameters: { type: 'object', properties: {}, required: [] }, execute: async () => ({}),
  }]), /reserved/u);
});

