import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readProtected} from '../desktop/secrets.mjs';
import {chooseUiAction, buildUiChoiceRequest} from '../desktop/providers/ui-choice.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Logs Jev decisions separately from actions performed with the Computer Use tool.
 * No desktop input, arbitrary script execution or automatic retry is provided here.
 */
export class UiExperimentSession {
  #key;
  constructor(name = 'yandex-ui-test') {
    if (!/^[a-z0-9-]{1,60}$/.test(name)) throw new Error('Invalid experiment name.');
    this.file = path.join(root, 'work', `${name}.json`);
    this.report = {createdAt: new Date().toISOString(),
      observer: 'Codex Computer Use: accessibility or screenshot interpreted by Codex',
      selector: 'Jev text-only API', executor: 'Codex Computer Use, one observed action at a time', steps: []};
  }
  async init() {
    this.#key = process.env.TYPESAFE_API_KEY || await readProtected(path.join(root, 'data', 'secrets', 'typesafe.dpapi'));
    if (!this.#key) throw new Error('TypeSafe credential unavailable.');
    try { this.report = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot resume experiment report.');
    }
    return this;
  }
  async save() {
    await fs.mkdir(path.dirname(this.file), {recursive: true});
    await fs.writeFile(this.file, JSON.stringify(this.report, null, 2) + '\n');
  }
  async decide(test, input) {
    // The caller supplies only task-related observed UI labels, never private page content.
    const projected = buildUiChoiceRequest(input).state;
    const decision = await chooseUiAction(input, {apiKey: this.#key});
    const step = {index: this.report.steps.length + 1, test, input: projected, decision};
    this.report.steps.push(step);
    await this.save();
    return {index: step.index, ...decision};
  }
  async record(index, outcome, verification) {
    const step = this.report.steps.find(item => item.index === index);
    if (!step) throw new Error('Unknown experiment step.');
    // Retain earlier failed attempts even if a later executor fallback succeeds.
    step.attempts ??= step.outcome ? [{recordedAt: null, outcome: step.outcome,
      verification: step.verification, source: 'legacy report entry'}] : [];
    const attempt = {recordedAt: new Date().toISOString(), outcome: String(outcome).slice(0,80),
      verification: String(verification).slice(0,1500)};
    step.attempts.push(attempt);
    step.outcome = attempt.outcome;
    step.verification = attempt.verification;
    await this.save();
  }
}
