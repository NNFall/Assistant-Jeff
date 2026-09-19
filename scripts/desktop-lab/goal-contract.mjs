export const SUPPORTED_TABS = Object.freeze(['Documentation', 'VK feed', 'Music', 'VK video']);
export const SUPPORTED_LANGUAGES = Object.freeze(['English', 'Russian']);
export const DEFAULT_FACTS = Object.freeze({ selectedTab: 'Documentation', playing: false, language: 'English' });
export const SUPPORTED_WORLD = Object.freeze({
  app: 'Jeff Desktop Lab Target: isolated local test window, not real browsers or music services',
  tabs: SUPPORTED_TABS,
  playing: 'Boolean mock playback state. No real audio. Play/Pause controls are reachable via Music tab even if currently invisible.',
  language: 'In-app MOCK language only: English or Russian. Never Windows keyboard layout.',
  reset: DEFAULT_FACTS,
  bounds: 'Only final tab/playback/mock-language states; no URLs, real apps, shell, timing, conditional or repeated same-field transitions.',
});
export function validateCommand(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(command)) throw Object.assign(new Error('Некорректная команда стенда.'), { code: 'LAB_GOAL_INPUT' });
  return command.trim();
}
export function validateCurrentFacts(facts) {
  if (!facts || !SUPPORTED_TABS.includes(facts.selectedTab) || typeof facts.playing !== 'boolean' || !SUPPORTED_LANGUAGES.includes(facts.language)) throw Object.assign(new Error('Некорректные факты стенда.'), { code: 'LAB_GOAL_INPUT' });
  return { selectedTab: facts.selectedTab, playing: facts.playing, language: facts.language };
}
function validGoal(goal) {
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return false;
  const keys = Object.keys(goal);
  return keys.length > 0 && keys.every(key => ['selectedTab', 'playing', 'language'].includes(key))
    && (!Object.hasOwn(goal, 'selectedTab') || SUPPORTED_TABS.includes(goal.selectedTab))
    && (!Object.hasOwn(goal, 'playing') || typeof goal.playing === 'boolean')
    && (!Object.hasOwn(goal, 'language') || SUPPORTED_LANGUAGES.includes(goal.language));
}
export function goalSatisfied(goal, snapshot) {
  if (!validGoal(goal)) return false;
  let facts; try { facts = validateCurrentFacts(snapshot?.facts); } catch { return false; }
  return Object.entries(goal).every(([key, value]) => facts[key] === value);
}
export function describeGoal(goal) {
  if (!validGoal(goal)) return 'Нет подтверждённой цели.';
  return [Object.hasOwn(goal, 'selectedTab') ? `Вкладка: ${goal.selectedTab}` : '', Object.hasOwn(goal, 'playing') ? `Воспроизведение: ${goal.playing ? 'включено' : 'выключено'}` : '', Object.hasOwn(goal, 'language') ? `Язык внутри стенда: ${goal.language}` : ''].filter(Boolean).join('; ');
}
