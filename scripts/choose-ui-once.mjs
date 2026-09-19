import fs from 'node:fs/promises';
import {UiExperimentSession} from './ui-experiment-session.mjs';

// Input JSON comes from inspected UI state; this script selects but never clicks.
try {
  if (!process.argv[2]) throw new Error('Input file required.');
  const raw = await fs.readFile(process.argv[2], 'utf8');
  if (Buffer.byteLength(raw) > 30000) throw new Error('Input too large.');
  const {test, input} = JSON.parse(raw);
  const session = await new UiExperimentSession().init();
  console.log(JSON.stringify(await session.decide(test, input)));
} catch (error) {
  console.log(JSON.stringify({error: /^UI_/.test(error.code) ? error.code : 'UI_TEST_FAILED'}));
  process.exitCode = 1;
}
