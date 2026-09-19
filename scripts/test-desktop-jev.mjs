import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readProtected} from '../desktop/secrets.mjs';
import {chooseDesktopAction} from '../desktop/providers/desktop-choice.mjs';
import {WindowsTestBridge} from './windows-test-bridge.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => !['--benchmark', '--execute', '--snapshot'].includes(arg))) {
  throw new Error('Usage: node scripts/test-desktop-jev.mjs --benchmark | --execute | --snapshot');
}
const execute = args.includes('--execute');
const benchmark = args.includes('--benchmark');
const reportPath = path.join(root, 'work', execute ? 'desktop-jev-execution.json' : 'desktop-jev-benchmark.json');
const report = {createdAt: new Date().toISOString(), command: 'Сверни Хром и закрой HAPP',
  mode: execute ? 'real-window-actions' : benchmark ? 'synthetic-fixtures-no-actions' : 'snapshot-only',
  benchmark: [], steps: []};
await fs.mkdir(path.dirname(reportPath), {recursive: true});
const save = () => fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
const emit = value => console.log(JSON.stringify(value));
// Z-order changes after minimizing a window must not reshuffle model choices.
const project = windows => windows.map(w => ({id: `${w.appId}-${w.handle}`, appId: w.appId, appName: w.appName, minimized: w.minimized}))
  .sort((a,b) => a.id.localeCompare(b.id));
let bridge;
try {
  const apiKey = (benchmark || execute) ? process.env.TYPESAFE_API_KEY || await readProtected(path.join(root, 'data', 'secrets', 'typesafe.dpapi')) : null;
  if ((benchmark || execute) && !apiKey) throw new Error('TypeSafe credential unavailable.');
  if (benchmark) {
    const windows = [{id: 'a', appId: 'chrome', appName: 'Google Chrome', minimized: false},
      {id: 'b', appId: 'happ', appName: 'HAPP', minimized: false}];
    const chromeDone = [{appId: 'chrome', operation: 'minimize', outcome: 'minimized'}];
    const cases = [
      {name: 'compound-first', command: report.command, expected: 'chrome:minimize'},
      {name: 'compound-next', command: report.command, windows: [{...windows[0], minimized: true}, windows[1]], completed: chromeDone, expected: 'happ:close'},
      {name: 'compound-complete', command: report.command, windows: [{...windows[0], minimized: true}], completed: [...chromeDone, {appId: 'happ', operation: 'close', outcome: 'window_closed_process_running'}], expected: 'done'},
      {name: 'negation', command: 'Не закрывай HAPP, только сверни Хром.', expected: 'chrome:minimize'},
      {name: 'opposite-target', command: 'Сверни HAPP, а Хром не трогай.', expected: 'happ:minimize'},
      {name: 'close-not-minimize', command: 'Закрой окно Хрома.', expected: 'chrome:close'},
      {name: 'unsupported-tab', command: 'Открой новую вкладку в Хроме.', expected: 'unsupported'},
      {name: 'quoted-explanation', command: 'Объясни, что означает фраза «закрой HAPP». Ничего не делай.', expected: 'unsupported'},
      {name: 'minimized-close', command: 'Хром оставь как есть, а окно Хапп закрой.', windows: windows.map(w => ({...w, minimized: true})), expected: 'happ:close'},
      {name: 'ambiguous-windows', command: 'Сверни Хром.', windows: [...windows, {...windows[0], id: 'c'}], expected: 'unsupported'},
    ];
    // Sequential requests: a small latency sample, not a throughput benchmark.
    for (const fixture of cases) {
      const input = {command: fixture.command, windows: fixture.windows || windows, completed: fixture.completed || []};
      let result;
      let rawDecision;
      const started = performance.now();
      try {
        const decision = await chooseDesktopAction(input, {apiKey, fetchImpl: async (url, init) => {
          const response = await fetch(url, init);
          if (response.ok) {
            // Synthetic fixtures only. Retain the bounded model answer if validation rejects it.
            const raw = await response.clone().text();
            if (Buffer.byteLength(raw) <= 65536) {
              try {
                const parsed = JSON.parse(raw.replaceAll(apiKey, '[REDACTED]'));
                rawDecision = {model: parsed.model, answers: parsed.answers, usage: parsed.usage};
              } catch { }
            }
          }
          return response;
        }});
        const actual = decision.action ? `${decision.action.appId}:${decision.action.operation}` : decision.choice;
        result = {name: fixture.name, command: fixture.command, expected: fixture.expected, actual, passed: actual === fixture.expected, ...decision};
      } catch (error) {
        result = {name: fixture.name, expected: fixture.expected, passed: false, error: error.code || 'TEST_FAILED',
          latencyMs: Math.round(performance.now() - started), rawDecision};
      }
      report.benchmark.push(result); await save(); emit(result);
    }
    const timings = report.benchmark.map(x => x.latencyMs).sort((a,b) => a-b);
    const middle = Math.floor(timings.length / 2);
    report.summary = {passed: report.benchmark.filter(x => x.passed).length, total: report.benchmark.length,
      minMs: timings[0], medianMs: timings.length % 2 ? timings[middle] : (timings[middle - 1] + timings[middle]) / 2, maxMs: timings.at(-1)};
  }
  if (execute || !benchmark) {
    bridge = await new WindowsTestBridge().start();
    report.bridgeStartupMs = bridge.startupMs;
    let observation = await bridge.request('snapshot');
    report.initial = {windows: project(observation.result.windows), observationMs: observation.roundtripMs};
    emit({stage: 'initial', ...report.initial, bridgeStartupMs: bridge.startupMs});
    if (execute) {
      // Deliberately fixed authorization; a model selection cannot widen this experiment.
      const authorized = new Set(['chrome:minimize', 'happ:close']);
      const completed = [];
      if (['chrome', 'happ'].some(app => observation.result.windows.filter(w => w.appId === app).length !== 1)) {
        throw new Error('The experiment requires exactly one observed Chrome window and one HAPP window.');
      }
      const started = performance.now();
      for (let index = 0; index < 3; index++) {
        const localWindows = observation.result.windows;
        const windows = project(localWindows);
        const decision = await chooseDesktopAction({command: report.command, windows, completed}, {apiKey});
        const step = {index: index + 1, observation: windows, decision};
        report.steps.push(step); await save(); emit({stage: 'decision', ...step});
        if (!decision.action) { report.stopped = decision.choice; break; }
        const {appId, operation, windowId} = decision.action;
        const selected = localWindows.find(w => `${w.appId}-${w.handle}` === windowId && w.appId === appId);
        if (!selected || !authorized.has(`${appId}:${operation}`)) throw new Error('Selection is outside this experiment authorization.');
        const action = await bridge.request(operation, selected);
        step.execution = {outcome: action.result.outcome, nativeMs: action.nativeMs, roundtripMs: action.roundtripMs};
        completed.push({appId, operation, outcome: action.result.outcome});
        observation = {result: {windows: action.result.windows}};
        step.after = project(action.result.windows);
        await save(); emit({stage: 'executed', index: step.index, ...step.execution, windows: step.after});
        if (action.result.outcome === 'not_verified') { report.stopped = 'not_verified'; break; }
      }
      report.totalLoopMs = Math.round(performance.now() - started);
      report.completed = completed;
      const finalObservation = await bridge.request('snapshot');
      report.final = project(finalObservation.result.windows);
      report.verified = report.final.some(w => w.appId === 'chrome' && w.minimized)
        && !report.final.some(w => w.appId === 'happ')
        && completed.some(x => x.appId === 'happ' && ['window_closed_process_running', 'process_exited'].includes(x.outcome));
    }
  }
  await save(); emit({stage: 'summary', summary: report.summary, verified: report.verified, totalLoopMs: report.totalLoopMs, reportPath});
} catch (error) {
  report.error = error.code || 'TEST_FAILED';
  await save(); emit({error: report.error}); process.exitCode = 1;
} finally { bridge?.close(); }
