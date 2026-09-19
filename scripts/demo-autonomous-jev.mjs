import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readProtected} from '../desktop/secrets.mjs';
import {chooseUiAction} from '../desktop/providers/ui-choice.mjs';
import {runObservedTask} from '../desktop/automation/observed-task.mjs';

// Real Jev, simulated desktop. This does not inspect or control the user's PC.
// Candidates are derived by the runner from capabilities, not written per step.
const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = path.join(root, 'work', 'autonomous-jev-demo.json');
const command = 'Найди первую вкладку ВКонтакте в Яндекс Браузере и открой её.';
const state = {version: 1, foreground: 'desktop', activeTab: 't31'};
const windows = [
  {id: 'w17', label: 'Яндекс Браузер, монитор 2', capabilities: ['activate']},
  {id: 'w19', label: 'Google Chrome, монитор 1', capabilities: ['activate']},
  {id: 'w22', label: 'Яндекс Музыка, монитор 1', capabilities: ['activate']},
];
const tabs = [
  {id: 't31', label: 'Вкладка 1 слева: Документация, example.org', capabilities: ['select']},
  {id: 't32', label: 'Вкладка 2 слева: ВКонтакте — Лента, vk.ru', capabilities: ['select']},
  {id: 't33', label: 'Вкладка 3 слева: Музыка, music.yandex.ru', capabilities: ['select']},
  {id: 't34', label: 'Вкладка 4 слева: ВКонтакте — Видео, vk.ru', capabilities: ['select']},
];
const adapter = {
  async observe() {
    return {version: String(state.version),
      app: state.foreground === 'w17' ? 'Яндекс Браузер' : 'Windows (simulated)',
      summary: state.foreground === 'w17'
        ? `На переднем плане Яндекс Браузер на мониторе 2. Открытые вкладки перечислены слева направо; активна ${state.activeTab}.`
        : 'Два монитора. На переднем плане рабочий стол. Доступны три окна; вкладки ещё не прочитаны.',
      elements: structuredClone(state.foreground === 'w17' ? tabs : windows)};
  },
  async execute(candidate, {expectedVersion, signal}) {
    if (signal.aborted || expectedVersion !== String(state.version)) throw new Error('Stale or cancelled fixture operation');
    if (candidate.operation === 'activate' && windows.some(w => w.id === candidate.targetId)) state.foreground = candidate.targetId;
    else if (candidate.operation === 'select' && state.foreground === 'w17' && tabs.some(t => t.id === candidate.targetId)) state.activeTab = candidate.targetId;
    else throw new Error('Unsupported fixture operation');
    state.version++;
    return {sent: true};
  },
  async verify({before, after, candidate}) {
    const observed = before.version !== after.version && (candidate.operation === 'activate'
      ? state.foreground === candidate.targetId : state.activeTab === candidate.targetId);
    return {outcome: observed ? 'verified' : 'not_verified',
      evidence: observed ? `Состояние симулятора подтверждает ${candidate.operation}(${candidate.targetId}).` : 'Состояние не изменилось.'};
  },
  async isGoalSatisfied() {
    // Test oracle for this fixture, not a general natural-language goal parser.
    const firstVk = tabs.find(t => /vk\.ru/.test(t.label));
    return state.foreground === 'w17' && state.activeTab === firstVk.id;
  },
};
const report = {createdAt: new Date().toISOString(), mode: 'REAL_API_SIMULATED_DESKTOP',
  command, observer: 'Deterministic synthetic fixture, NOT the real computer',
  executor: 'In-memory fixture, no OS effects', candidateSource: 'Generic mapping of observed capabilities',
  goalVerifier: 'Fixture-specific test oracle, NOT a universal goal evaluator', calls: []};
try {
  const apiKey = process.env.TYPESAFE_API_KEY || await readProtected(path.join(root, 'data', 'secrets', 'typesafe.dpapi'));
  if (!apiKey) throw new Error('Missing credential');
  report.result = await runObservedTask({command, adapter, maxSteps: 6, maxDurationMs: 40000,
    choose: (input, {signal}) => chooseUiAction(input, {apiKey, signal,
      fetchImpl: async (url, options) => {
        const call = {request: JSON.parse(options.body), startedAt: new Date().toISOString()};
        report.calls.push(call);
        const start = performance.now();
        const response = await fetch(url, options);
        call.httpStatus = response.status;
        if (response.ok) call.response = await response.clone().json();
        call.roundtripMs = Math.round(performance.now() - start);
        return response;
      }})});
  if (!report.result.ok) process.exitCode = 1;
} catch (error) {
  report.error = /^UI_|^OBSERVED_/.test(error.code) ? error.code : 'DEMO_FAILED';
  process.exitCode = 1;
} finally {
  await fs.mkdir(path.dirname(reportPath), {recursive: true});
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({mode: report.mode, ok: report.result?.ok, reason: report.result?.reason,
    calls: report.calls.map(call => { const answer = call.response?.answers?.next_action;
      return {choice: answer?.choice, probability: answer?.probabilities?.[answer?.choice], confidence: answer?.confidence, apiMs: call.roundtripMs}; }),
    elapsedMs: report.result?.elapsedMs, error: report.error, reportPath}));
}
