// Fixed fixture goals, deliberately not a natural-language goal parser.
export const LAB_SCENARIOS = Object.freeze({
  tabs: Object.freeze({ command: 'Открой первую вкладку ВКонтакте в тестовом окне.' }),
  music: Object.freeze({ command: 'Включи воспроизведение музыки в тестовом окне.' }),
});

export function validateScenarioCommand(scenario, command) {
  if (!Object.hasOwn(LAB_SCENARIOS, scenario) || command !== LAB_SCENARIOS[scenario].command) throw Object.assign(new Error('INVALID_COMMAND'), { code: 'INVALID_COMMAND' });
  return LAB_SCENARIOS[scenario];
}

const nameOf = element => element?.name ?? element?.label;
const TABS = ['Documentation', 'VK feed', 'Music', 'VK video'];
const LANGUAGES = ['English', 'Russian'];
const BUTTONS = ['Play music', 'Pause music', 'Reset lab'];
const hasFacts = snapshot => snapshot?.facts && typeof snapshot.facts.playing === 'boolean' && TABS.includes(snapshot.facts.selectedTab) && LANGUAGES.includes(snapshot.facts.language);

export function isSupportedLabCandidate(snapshot, candidate) {
  const element = snapshot?.elements?.find(item => item.id === candidate?.targetId);
  if (!element?.capabilities?.includes(candidate.operation)) return false;
  const name = nameOf(element);
  return candidate.operation === 'select' ? TABS.includes(name) || LANGUAGES.includes(name)
    : candidate.operation === 'click' && BUTTONS.includes(name);
}

export function firstVkTarget(snapshot) {
  const matches = snapshot?.elements?.filter(element => (element.role === 'TabItem' || element.capabilities?.includes('select')) && /ВКонтакте|\bVK\b/iu.test(nameOf(element))) ?? [];
  // Prefer the native observer's UIA geometry order, not incidental tree traversal.
  if (matches.every(element => Number.isFinite(element.order))) matches.sort((a,b) => a.order - b.order);
  return matches[0]?.id ?? null;
}

export function isLabGoalSatisfied(scenario, snapshot, firstVkId) {
  if (!hasFacts(snapshot)) return false;
  if (scenario === 'music') return snapshot.facts.playing === true;
  const target = snapshot.elements?.find(element => element.id === firstVkId);
  return scenario === 'tabs' && Boolean(target && TABS.includes(nameOf(target)) && snapshot.facts.selectedTab === nameOf(target) && target.selected !== false);
}

export function verifyLabAction({ before, after, candidate }) {
  const reject = { outcome: 'not_verified', evidence: 'UIA не подтвердил ожидаемое изменение выбранного контрола.' };
  if (!hasFacts(before) || !hasFacts(after) || !isSupportedLabCandidate(before, candidate)) return reject;
  const element = before.elements.find(item => item.id === candidate.targetId);
  const name = nameOf(element);
  const old = before.facts, fresh = after.facts;
  let observed = false;
  if (candidate.operation === 'select') {
    const target = after.elements?.find(item => item.id === candidate.targetId);
    if (!target || nameOf(target) !== name || target.selected === false) return reject;
    observed = TABS.includes(name)
      ? fresh.selectedTab === name && old.playing === fresh.playing && old.language === fresh.language
      : fresh.language === name && old.playing === fresh.playing && old.selectedTab === fresh.selectedTab;
  } else if (name === 'Play music' || name === 'Pause music') {
    const playing = name === 'Play music';
    observed = old.playing !== playing && fresh.playing === playing && old.selectedTab === fresh.selectedTab && old.language === fresh.language;
  } else if (name === 'Reset lab') {
    observed = fresh.playing === false && fresh.selectedTab === 'Documentation' && fresh.language === 'English'
      && (old.playing !== fresh.playing || old.selectedTab !== fresh.selectedTab || old.language !== fresh.language);
  }
  return observed ? { outcome: 'verified', evidence: `UIA подтвердил ожидаемый результат контрола «${name}».` } : reject;
}
