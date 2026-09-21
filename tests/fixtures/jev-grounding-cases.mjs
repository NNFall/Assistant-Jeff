/**
 * Prepared, synthetic Russian cases for the Jev candidate-grounding
 * evaluation. These records are an offline test fixture: they do not measure
 * automatic scope extraction from a live Windows snapshot.
 */

export const SYNTHETIC_SCOPE_NOTE =
  'Synthetic cases; candidate scope is externally/prepared supplied by the current subtask and is not evidence of automatic scope extraction.';

const candidate = (id, label, operation) => ({ id, label, operation });

const fixture = ({ id, command, summary, phase = 'controls', candidates, completed = [], expected, scopeOperation, tags }) => ({
  id,
  synthetic: true,
  scopeSource: 'externally/prepared supplied current subtask',
  scopeOperation,
  expected,
  tags,
  input: {
    command,
    observation: { app: 'Windows desktop', summary },
    phase,
    candidates,
    completed,
  },
});

export const JEV_GROUNDING_CASES = Object.freeze([
  fixture({
    id: 'chrome_minimize_simple',
    command: 'Сверни окно Chrome.',
    summary: 'Chrome — «Документация» выбран, видим и не свёрнут; Edge — «Новости» и Slack — «Команда» видимы рядом.',
    candidates: [
      candidate('chrome_minimize_docs', 'Chrome — «Документация»: свернуть выбранное окно', 'minimize'),
      candidate('edge_minimize_news', 'Edge — «Новости»: свернуть окно', 'minimize'),
      candidate('chrome_activate_docs', 'Chrome — «Документация»: активировать окно', 'activate'),
      candidate('chrome_inspect_docs', 'Chrome — «Документация»: осмотреть окно', 'inspect'),
      candidate('edge_inspect_news', 'Edge — «Новости»: осмотреть окно', 'inspect'),
      candidate('chrome_close_docs', 'Chrome — «Документация»: закрыть окно', 'close'),
    ],
    expected: 'chrome_minimize_docs',
    scopeOperation: 'minimize',
    tags: ['chrome', 'minimize', 'simple'],
  }),
  fixture({
    id: 'chrome_open_existing',
    command: 'Открой Chrome с документацией.',
    summary: 'Chrome — «Документация» существует, видно, но окно неактивно; активен Edge — «Новости».',
    candidates: [
      candidate('chrome_activate_docs', 'Chrome — «Документация»: активировать существующее окно', 'activate'),
      candidate('edge_activate_news', 'Edge — «Новости»: активировать существующее окно', 'activate'),
      candidate('chrome_inspect_docs', 'Chrome — «Документация»: осмотреть окно', 'inspect'),
      candidate('edge_inspect_news', 'Edge — «Новости»: осмотреть окно', 'inspect'),
      candidate('chrome_minimize_docs', 'Chrome — «Документация»: свернуть окно', 'minimize'),
    ],
    expected: 'chrome_activate_docs',
    scopeOperation: 'activate',
    tags: ['chrome', 'open', 'simple'],
  }),
  fixture({
    id: 'unfamiliar_observed_app',
    command: 'Открой Obsidian.',
    summary: 'Наблюдаются два существующих окна: Obsidian — «Рабочее хранилище» и Блокнот — «черновик».',
    candidates: [
      candidate('obsidian_activate_vault', 'Obsidian — «Рабочее хранилище»: активировать окно', 'activate'),
      candidate('notepad_activate_draft', 'Блокнот — «черновик»: активировать окно', 'activate'),
      candidate('obsidian_inspect_vault', 'Obsidian — «Рабочее хранилище»: осмотреть окно', 'inspect'),
      candidate('notepad_inspect_draft', 'Блокнот — «черновик»: осмотреть окно', 'inspect'),
      candidate('obsidian_close_vault', 'Obsidian — «Рабочее хранилище»: закрыть окно', 'close'),
    ],
    expected: 'obsidian_activate_vault',
    scopeOperation: 'activate',
    tags: ['unfamiliar-app', 'open'],
  }),
  fixture({
    id: 'near_identical_titles_ambiguous',
    command: 'Открой окно «Проект».',
    summary: 'Есть два разных существующих окна с одинаковым отображаемым заголовком «Проект»: одно в Chrome и одно в Edge. Дополнительного признака выбора нет.',
    candidates: [
      candidate('project_chrome_activate', 'Chrome — «Проект»: активировать окно', 'activate'),
      candidate('project_edge_activate', 'Edge — «Проект»: активировать окно', 'activate'),
      candidate('project_chrome_inspect', 'Chrome — «Проект»: осмотреть окно', 'inspect'),
      candidate('project_edge_inspect', 'Edge — «Проект»: осмотреть окно', 'inspect'),
      candidate('settings_activate', 'Параметры — «Система»: активировать окно', 'activate'),
    ],
    expected: 'unsupported',
    scopeOperation: 'activate',
    tags: ['ambiguity', 'near-identical-titles'],
  }),
  fixture({
    id: 'missing_target',
    command: 'Сверни Chrome.',
    summary: 'В наблюдении есть только Edge — «Новости» и Slack — «Команда»; окна Chrome нет.',
    candidates: [
      candidate('edge_minimize_news', 'Edge — «Новости»: свернуть окно', 'minimize'),
      candidate('slack_minimize_team', 'Slack — «Команда»: свернуть окно', 'minimize'),
      candidate('edge_inspect_news', 'Edge — «Новости»: осмотреть окно', 'inspect'),
      candidate('slack_inspect_team', 'Slack — «Команда»: осмотреть окно', 'inspect'),
      candidate('edge_activate_news', 'Edge — «Новости»: активировать окно', 'activate'),
    ],
    expected: 'unsupported',
    scopeOperation: 'minimize',
    tags: ['missing-target', 'minimize'],
  }),
  fixture({
    id: 'quoted_command_no_request',
    command: 'Объясни, что означает команда «сверни Chrome».',
    summary: 'Chrome — «Документация» наблюдается, окно не свёрнуто.',
    candidates: [
      candidate('chrome_minimize_docs', 'Chrome — «Документация»: свернуть окно', 'minimize'),
      candidate('chrome_activate_docs', 'Chrome — «Документация»: активировать окно', 'activate'),
      candidate('chrome_inspect_docs', 'Chrome — «Документация»: осмотреть окно', 'inspect'),
      candidate('edge_minimize_news', 'Edge — «Новости»: свернуть окно', 'minimize'),
    ],
    expected: 'no_request',
    scopeOperation: 'all',
    tags: ['quoted-command', 'no-request'],
  }),
  fixture({
    id: 'negated_command_no_request',
    command: 'Не сворачивай Chrome.',
    summary: 'Chrome — «Документация» виден и не свёрнут.',
    candidates: [
      candidate('chrome_minimize_docs', 'Chrome — «Документация»: свернуть окно', 'minimize'),
      candidate('chrome_activate_docs', 'Chrome — «Документация»: активировать окно', 'activate'),
      candidate('chrome_inspect_docs', 'Chrome — «Документация»: осмотреть окно', 'inspect'),
      candidate('edge_minimize_news', 'Edge — «Новости»: свернуть окно', 'minimize'),
    ],
    expected: 'no_request',
    scopeOperation: 'all',
    tags: ['negation', 'no-request'],
  }),
  fixture({
    id: 'already_done_chrome_minimized',
    command: 'Сверни Chrome.',
    summary: 'Chrome — «Документация» уже находится в состоянии Minimized; Edge — «Новости» развёрнут.',
    candidates: [
      candidate('chrome_minimize_docs', 'Chrome — «Документация»: свернуть окно', 'minimize'),
      candidate('edge_minimize_news', 'Edge — «Новости»: свернуть окно', 'minimize'),
      candidate('chrome_inspect_docs', 'Chrome — «Документация»: осмотреть окно', 'inspect'),
      candidate('edge_inspect_news', 'Edge — «Новости»: осмотреть окно', 'inspect'),
      candidate('chrome_activate_docs', 'Chrome — «Документация»: активировать окно', 'activate'),
    ],
    expected: 'done',
    scopeOperation: 'minimize',
    tags: ['already-done', 'minimize'],
  }),
  fixture({
    id: 'compound_history_next_minimize',
    command: 'Открой Chrome, затем сверни его.',
    summary: 'Chrome — «Документация» сейчас виден и не свёрнут. В completed есть подтверждённый native window_active для Chrome.',
    completed: [
      { id: 'chrome_activate_docs', label: 'Chrome — «Документация»: активировать окно', outcome: 'verified', evidence: 'native window_active for the selected Chrome window' },
    ],
    candidates: [
      candidate('chrome_minimize_docs', 'Chrome — «Документация»: свернуть окно', 'minimize'),
      candidate('edge_minimize_news', 'Edge — «Новости»: свернуть окно', 'minimize'),
      candidate('chrome_inspect_docs', 'Chrome — «Документация»: осмотреть окно', 'inspect'),
      candidate('chrome_activate_docs', 'Chrome — «Документация»: активировать окно повторно', 'activate'),
      candidate('edge_inspect_news', 'Edge — «Новости»: осмотреть окно', 'inspect'),
    ],
    expected: 'chrome_minimize_docs',
    scopeOperation: 'minimize',
    tags: ['compound', 'history', 'minimize'],
  }),
  fixture({
    id: 'partial_tab_coverage',
    command: 'Выбери первую вкладку ВКонтакте.',
    summary: 'Текущий UI Automation snapshot Chrome возвращает две вкладки ВКонтакте; у tab order стоит partial coverage, а дополнительной страницы или продолжения перечисления в этом snapshot нет.',
    candidates: [
      candidate('vk_tab_news', 'Chrome: выбрать вкладку ВКонтакте — Новости (наблюдаемый порядок 1, покрытие неполное)', 'select'),
      candidate('vk_tab_feed', 'Chrome: выбрать вкладку ВКонтакте — Лента (наблюдаемый порядок 2, покрытие неполное)', 'select'),
      candidate('chrome_inspect_tabs', 'Chrome — панель вкладок: осмотреть окно', 'inspect'),
      candidate('chrome_activate_tabs', 'Chrome — панель вкладок: активировать окно', 'activate'),
      candidate('edge_inspect_news', 'Edge — «Новости»: осмотреть окно', 'inspect'),
    ],
    expected: 'unsupported',
    scopeOperation: 'select',
    tags: ['tabs', 'partial-coverage', 'unsupported'],
  }),
  fixture({
    id: 'full_tab_coverage',
    command: 'Выбери первую вкладку ВКонтакте.',
    summary: 'В Chrome наблюдаются ровно две вкладки ВКонтакте в полном визуальном порядке: Новости — 1, Лента — 2; покрытие панели вкладок полное.',
    candidates: [
      candidate('vk_tab_first', 'Chrome: выбрать вкладку ВКонтакте — Новости (полный наблюдаемый порядок 1)', 'select'),
      candidate('vk_tab_second', 'Chrome: выбрать вкладку ВКонтакте — Лента (полный наблюдаемый порядок 2)', 'select'),
      candidate('chrome_inspect_tabs', 'Chrome — панель вкладок: осмотреть окно', 'inspect'),
      candidate('chrome_export', 'Chrome — кнопка «Экспорт»: нажать', 'invoke'),
      candidate('edge_inspect_news', 'Edge — «Новости»: осмотреть окно', 'inspect'),
    ],
    expected: 'vk_tab_first',
    scopeOperation: 'select',
    tags: ['tabs', 'full-coverage'],
  }),
  fixture({
    id: 'compound_history_done',
    command: 'Покажи Chrome, затем сверни его.',
    summary: 'Chrome — «Документация» сейчас свёрнут. В completed записаны подряд native window_active и native window_minimized для Chrome с исходом verified.',
    completed: [
      { id: 'chrome_activate_docs', label: 'Chrome — «Документация»: активировать окно', outcome: 'verified', evidence: 'native window_active for Chrome' },
      { id: 'chrome_minimize_docs', label: 'Chrome — «Документация»: свернуть окно', outcome: 'verified', evidence: 'native window_minimized for Chrome' },
    ],
    candidates: [
      candidate('chrome_activate_docs', 'Chrome — «Документация»: активировать окно повторно', 'activate'),
      candidate('chrome_minimize_docs', 'Chrome — «Документация»: свернуть окно повторно', 'minimize'),
      candidate('chrome_inspect_docs', 'Chrome — «Документация»: осмотреть окно', 'inspect'),
      candidate('edge_inspect_news', 'Edge — «Новости»: осмотреть окно', 'inspect'),
    ],
    expected: 'done',
    scopeOperation: 'minimize',
    tags: ['compound', 'history', 'already-done'],
  }),
  fixture({
    id: 'already_done_open_unfamiliar',
    command: 'Открой Obsidian.',
    summary: 'Obsidian — «Рабочее хранилище» уже виден, не свёрнут и находится на переднем плане; окно Edge также существует.',
    candidates: [
      candidate('obsidian_activate_vault', 'Obsidian — «Рабочее хранилище»: активировать существующее окно', 'activate'),
      candidate('edge_activate_news', 'Edge — «Новости»: активировать существующее окно', 'activate'),
      candidate('obsidian_inspect_vault', 'Obsidian — «Рабочее хранилище»: осмотреть окно', 'inspect'),
      candidate('edge_inspect_news', 'Edge — «Новости»: осмотреть окно', 'inspect'),
      candidate('obsidian_close_vault', 'Obsidian — «Рабочее хранилище»: закрыть окно', 'close'),
    ],
    expected: 'done',
    scopeOperation: 'activate',
    tags: ['unfamiliar-app', 'already-done', 'open'],
  }),
  fixture({
    id: 'missing_control_export',
    command: 'Нажми кнопку «Экспорт».',
    summary: 'Текущее дерево контролов Chrome прочитано полностью для этой поверхности: присутствуют кнопки «Настройки» и «Сохранить», кнопка «Экспорт» отсутствует.',
    candidates: [
      candidate('settings_invoke', 'Chrome — кнопка «Настройки»: нажать', 'invoke'),
      candidate('save_invoke', 'Chrome — кнопка «Сохранить»: нажать', 'invoke'),
      candidate('chrome_inspect_controls', 'Chrome — текущий экран: осмотреть окно', 'inspect'),
      candidate('edge_inspect_news', 'Edge — «Новости»: осмотреть окно', 'inspect'),
      candidate('chrome_activate_controls', 'Chrome — текущий экран: активировать окно', 'activate'),
    ],
    expected: 'unsupported',
    scopeOperation: 'invoke',
    tags: ['missing-target', 'control'],
  }),
]);

export const CASE_IDS = Object.freeze(JEV_GROUNDING_CASES.map(item => item.id));
