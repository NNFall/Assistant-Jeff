import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {UiExperimentSession} from '../scripts/ui-experiment-session.mjs';

test('fallback verification retains the earlier unverified click, including legacy reports', async () => {
  const work = fileURLToPath(new URL('../work/', import.meta.url));
  await fs.mkdir(work, {recursive: true});
  const temporary = await fs.mkdtemp(path.join(work, 'session-test-'));
  try {
    const session = new UiExperimentSession('test');
    session.file = path.join(temporary, 'report.json');
    session.report.steps.push({index: 1, outcome: 'click_not_verified', verification: 'Selected tab did not change.'});
    await session.record(1, 'verified', 'Keyboard fallback selected the observed target.');
    const saved = JSON.parse(await fs.readFile(session.file, 'utf8')).steps[0];
    assert.equal(saved.outcome, 'verified');
    assert.deepEqual(saved.attempts.map(attempt => attempt.outcome), ['click_not_verified', 'verified']);
    assert.equal(saved.attempts[0].verification, 'Selected tab did not change.');
    assert.equal(saved.attempts[0].recordedAt, null);
    assert.ok(Date.parse(saved.attempts[1].recordedAt));
  } finally { await fs.rm(temporary, {recursive: true, force: true}); }
});
