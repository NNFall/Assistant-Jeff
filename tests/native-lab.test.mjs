import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeLab } from '../scripts/desktop-lab/controller.mjs';
import { LAB_SCENARIOS, validateScenarioCommand, firstVkTarget, isLabGoalSatisfied, isSupportedLabCandidate, verifyLabAction } from '../scripts/desktop-lab/scenarios.mjs';

const state = (facts = {}) => ({
  version: 'fixture', app: 'Jeff Desktop Lab Target', summary: 'fixture',
  facts: { selectedTab: 'Documentation', playing: false, language: 'English', ...facts },
  elements: [
    { id: 'doc', name: 'Documentation', label: '1. Documentation', capabilities: ['select'] },
    { id: 'feed', name: 'VK feed', label: '2. VK feed', capabilities: ['select'] },
    { id: 'video', name: 'VK video', label: '4. VK video', capabilities: ['select'] },
    { id: 'en', name: 'English', label: 'English', capabilities: ['select'] },
    { id: 'ru', name: 'Russian', label: 'Russian', capabilities: ['select'] },
    { id: 'play', name: 'Play music', label: 'Play music', capabilities: ['click'] },
    { id: 'pause', name: 'Pause music', label: 'Pause music', capabilities: ['click'] },
    { id: 'reset', name: 'Reset lab', label: 'Reset lab', capabilities: ['click'] },
  ],
});
const verify = (targetId, before, after, operation = 'click') => verifyLabAction({ before, after, candidate: { targetId, operation } }).outcome;

test('malformed manual commands are rejected before startup', async () => {
  const lab = new NativeLab();
  let starts = 0;
  lab.start = async () => { starts++; throw new Error('Must not start'); };
  for (const command of ['', null, ' '.repeat(4), 'a'.repeat(1025), 'hello\u0000']) {
    await assert.rejects(lab.run({ command }));
  }
  assert.equal(starts, 0);
  assert.equal(lab.running, false);
});

test('goal check identifies exact first VK and rejects missing or conflicting UIA facts', () => {
  const initial = state();
  assert.equal(firstVkTarget(initial), 'feed');
  const alreadySelected = state({ selectedTab: 'VK feed' });
  Object.assign(alreadySelected.elements[1], { role: 'TabItem', selected: true, capabilities: [] });
  assert.equal(firstVkTarget(alreadySelected), 'feed');
  assert.equal(isLabGoalSatisfied('tabs', alreadySelected, firstVkTarget(alreadySelected)), true);
  initial.elements[1].order = 2; initial.elements[2].order = 4;
  initial.elements.reverse();
  assert.equal(firstVkTarget(initial), 'feed');
  assert.equal(isLabGoalSatisfied('tabs', state({ selectedTab: 'VK video' }), 'feed'), false);
  assert.equal(isLabGoalSatisfied('tabs', state({ selectedTab: 'VK feed' }), 'feed'), true);
  const contradictory = state({ selectedTab: 'VK feed' }); contradictory.elements[1].selected = false;
  assert.equal(isLabGoalSatisfied('tabs', contradictory, 'feed'), false);
  assert.equal(isLabGoalSatisfied('music', state({ playing: true }), 'feed'), true);
  assert.equal(isLabGoalSatisfied('music', { facts: { playing: true } }, 'feed'), false);
});

test('Play, Pause and Reset each verify their own expected state, not any playback delta', () => {
  assert.equal(verify('play', state(), state({ playing: true })), 'verified');
  assert.equal(verify('play', state({ playing: true }), state()), 'not_verified');
  assert.equal(verify('pause', state({ playing: true }), state()), 'verified');
  assert.equal(verify('play', state(), state({ playing: true, selectedTab: 'VK video' })), 'not_verified');
  assert.equal(verify('reset', state({ playing: true, selectedTab: 'VK feed', language: 'Russian' }), state()), 'verified');
  assert.equal(verify('reset', state({ playing: true, selectedTab: 'VK feed' }), state({ selectedTab: 'VK feed' })), 'not_verified');
  assert.equal(verify('reset', state(), state()), 'not_verified');
});

test('selection verifies exact target and preserves unrelated facts', () => {
  assert.equal(verify('feed', state(), state({ selectedTab: 'VK feed' }), 'select'), 'verified');
  assert.equal(verify('feed', state(), state({ selectedTab: 'VK video' }), 'select'), 'not_verified');
  assert.equal(verify('ru', state(), state({ language: 'Russian' }), 'select'), 'verified');
  assert.equal(verify('ru', state(), state({ language: 'Russian', playing: true }), 'select'), 'not_verified');
  assert.equal(isSupportedLabCandidate(state(), { targetId: 'feed', operation: 'click' }), false);
  assert.equal(verify('unknown', state(), state({ playing: true })), 'not_verified');
});

test('pre-aborted startup never reaches native observation', async () => {
  const lab = new NativeLab();
  lab.state = () => assert.fail('No observation after cancellation');
  await assert.rejects(lab.start({ signal: AbortSignal.abort() }), { code: 'ABORTED' });
  assert.equal(lab.target, undefined);
});

test('startup propagates cancellation to readiness observation without real processes', async () => {
  const lab = new NativeLab();
  const controller = new AbortController();
  let receivedSignal;
  lab.target = { exitCode: null, killed: false, pid: 123 };
  lab.bridge = { closed: false, request: (_method, _args, signal) => {
    receivedSignal = signal;
    return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(Object.assign(new Error('ABORTED'), { code: 'ABORTED' })), { once: true }); queueMicrotask(() => controller.abort()); });
  } };
  await assert.rejects(lab.start({ signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(receivedSignal, controller.signal);
  assert.equal(lab.starting, null);
});

test('readiness retry delay is cancellable and does not issue another observation', async () => {
  const lab = new NativeLab();
  const controller = new AbortController();
  let attempts = 0;
  lab.target = { exitCode: null, killed: false, pid: 123 };
  lab.bridge = { closed: false, request: async () => { attempts++; setTimeout(() => controller.abort(), 5); throw new Error('Not ready'); } };
  await assert.rejects(lab.start({ signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(attempts, 1);
});
