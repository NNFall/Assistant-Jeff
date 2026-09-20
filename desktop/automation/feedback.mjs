// Shared, side-effect-free copy for the interface and spoken replies. Provider
// errors, native error details and model explanations are never user-facing copy.
const effectOutcomes = new Set(['verified', 'local_saved']);
const launchRejected = new Set(['APP_LAUNCH_FAILED', 'APP_ELEVATION_REQUIRED', 'APP_NOT_OBSERVED', 'APP_TARGET_CHANGED', 'APP_TARGET_MISSING']);
const bounded = (value, limit) => value.length <= limit ? value : value.slice(0, limit - 1).trimEnd() + '…';
const text = value => typeof value === 'string' && value.trim() ? value.trim() : '';
const list = value => Array.isArray(value) ? value : [];
const effect = item => typeof item?.operation === 'string' && item.operation !== 'inspect';
const make = (tone, title, message, retryable = false, spoken) => ({
  tone, title, message, spoken: spoken ?? bounded(`${title}. ${message}`.trim(), 350), retryable,
});

/** Accepts a stable code, never an Error.message or a provider response body. */
export function describeError(code) {
  switch (code) {
    case 'APP_LAUNCH_FAILED': return make('error', 'Не получилось открыть приложение', 'Windows не смогла запустить программу. Попробуйте открыть её вручную.', true);
    case 'APP_ELEVATION_REQUIRED': return make('error', 'Не получилось открыть приложение', 'Программа требует прав администратора. Откройте её вручную.', false);
    case 'APP_TARGET_CHANGED':
    case 'APP_TARGET_MISSING': return make('error', 'Приложение недоступно', 'Программа была перемещена или удалена. Проверьте, открывается ли она вручную.', true);
    case 'APP_NOT_OBSERVED': return make('error', 'Приложение не найдено', 'Уточните название или откройте программу вручную, затем повторите команду.', true);
    case 'TYPESAFE_KEY_MISSING':
    case 'WINDOWS_CHOICE_KEY': return make('error', 'Jev не подключён', 'Не настроен ключ модели для управления компьютером. Проверьте подключение в настройках.', false);
    case 'WINDOWS_CHOICE_NETWORK':
    case 'WINDOWS_CHOICE_HTTP':
    case 'WINDOWS_CHOICE_TIMEOUT': return make('error', 'Нет ответа от Jev', 'Проверьте подключение к интернету и повторите команду немного позже.', true);
    case 'WINDOWS_CHOICE_RESPONSE':
    case 'WINDOWS_CHOICE_INPUT': return make('error', 'Не удалось выбрать действие', 'Ответ модели не прошёл проверку. Попробуйте короткую команду с названием приложения.', true);
    case 'WINDOWS_HELPER_MISSING':
    case 'WINDOWS_BRIDGE_UNAVAILABLE':
    case 'WINDOWS_BRIDGE_STOPPED':
    case 'WINDOWS_BRIDGE_CLOSED': return make('error', 'Связь с Windows недоступна', 'Перезапустите Jeff и повторите команду.', true);
    case 'WINDOWS_TIMEOUT': return make('error', 'Windows не ответила вовремя', 'Проверьте нужное приложение и повторите команду.', true);
    case 'WINDOWS_INVALID_RESPONSE':
    case 'WINDOWS_INVALID_SNAPSHOT':
    case 'WINDOWS_RESPONSE_TOO_LARGE': return make('error', 'Не удалось прочитать окно', 'Откройте нужное приложение и повторите короткую команду.', true);
    case 'KEYBOARD_LANGUAGE_NOT_INSTALLED': return make('error', 'Эта раскладка не установлена', 'Добавьте нужный язык в настройках Windows и повторите команду.', false);
    case 'KEYBOARD_LANGUAGE_REQUEST_FAILED': return make('error', 'Не получилось сменить раскладку', 'Выберите нужное окно и попробуйте ещё раз.', true);
    case 'TASK_ALREADY_RUNNING': return make('neutral', 'Уже выполняю задачу', 'Дождитесь результата или нажмите «Остановить».', false);
    case 'INVALID_COMMAND': return make('warning', 'Уточните команду', 'Напишите коротко, что нужно сделать, и укажите название приложения.', true);
    case 'ABORTED':
    case 'WINDOWS_CHOICE_ABORTED': return make('neutral', 'Выполнение остановлено', 'Можно ввести новую команду.', true);
    case 'CHAT_UNAVAILABLE': return make('error', 'Gemini не подключён', 'Проверьте подключение Gemini в настройках.', false);
    case 'CHAT_INVALID_RESPONSE': return make('error', 'Ответ Gemini не получен', 'Сервис вернул неполный ответ. Попробуйте спросить ещё раз.', true);
    case 'NO_SPEECH': return make('neutral', 'Не услышал команду', 'Нажмите «Сказать команду» и говорите после начала записи. Проверьте, выбран ли нужный микрофон.', true);
    case 'EMPTY_TRANSCRIPT': return make('warning', 'Не удалось разобрать речь', 'Повторите короткую команду или напишите её в поле ввода.', true);
    case 'TRANSCRIPT_TOO_LONG': return make('warning', 'Команда слишком длинная', 'Разделите её на несколько коротких задач. За один раз можно распознать до 1024 символов.', true);
    case 'VOICE_PROCESSING_FAILED': return make('error', 'Не удалось обработать голосовую команду', 'Проверьте подключение к интернету и повторите запись. Команду также можно ввести текстом.', true);
    case 'GEMINI_UNAVAILABLE': return make('error', 'Распознавание речи не подключено', 'Доступ к Gemini пока не настроен. Команду можно ввести текстом.', false);
    case 'VOICE_MODE_INVALID': return make('warning', 'Не удалось выбрать режим записи', 'Нажмите «Сказать команду» или включите ожидание Jarvis.', true);
    case 'VOICE_BUSY': return make('neutral', 'Голосовой ввод уже занят', 'Дождитесь результата или нажмите «Остановить» перед новой записью.', false);
    case 'CLOUD_DISABLED': return make('warning', 'Распознавание речи выключено', 'Включите облачное распознавание в настройках или введите команду текстом.', false);
    case 'WAKE_LOAD_FAILED': return make('error', 'Не удалось включить ожидание Jarvis', 'Перезапустите Jeff. Пока можно нажать «Сказать команду» и записать фразу вручную.', true);
    case 'WAKE_INFERENCE_FAILED':
    case 'WAKE_RESET_FAILED': return make('error', 'Ожидание Jarvis остановлено', 'Включите его снова или нажмите «Сказать команду», чтобы записать фразу вручную.', true);
    case 'NotAllowedError':
    case 'MICROPHONE_PERMISSION_DENIED': return make('error', 'Нет доступа к микрофону', 'Разрешите доступ к микрофону для Jeff в настройках Windows и попробуйте снова.', false);
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'MICROPHONE_NOT_FOUND': return make('error', 'Микрофон не найден', 'Подключите микрофон и выберите его в настройках Windows.', true);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'MICROPHONE_UNAVAILABLE': return make('error', 'Микрофон недоступен', 'Проверьте подключение микрофона и не занят ли он другим приложением.', true);
    case 'OverconstrainedError': return make('error', 'Не удалось выбрать микрофон', 'Выберите доступный микрофон в настройках Windows и попробуйте снова.', true);
    case 'ENCODER_MISSING': return make('error', 'Запись речи недоступна', 'В приложении отсутствует обработчик аудио. Переустановите Jeff или введите команду текстом.', false);
    case 'ENCODER_TIMEOUT':
    case 'ENCODER_FAILED':
    case 'AUDIO_INVALID': return make('error', 'Не удалось подготовить запись', 'Попробуйте записать короткую команду ещё раз или введите её текстом.', true);
    case 'AUDIO_TOO_LARGE': return make('warning', 'Запись слишком длинная', 'Повторите задачу короткой фразой или введите её текстом.', true);
    case 'VOICE_PLAYBACK_FAILED':
    case 'DENIS_NOT_INSTALLED':
    case 'DENIS_AUDIO_INVALID':
    case 'DENIS_TEXT_INVALID':
    case 'DENIS_BUSY':
    case 'DENIS_START_FAILED':
    case 'DENIS_AUDIO_LIMIT':
    case 'DENIS_DIAGNOSTIC_LIMIT':
    case 'DENIS_INPUT_FAILED':
    case 'DENIS_SYNTHESIS_FAILED':
    case 'DENIS_TIMEOUT':
    case 'DENIS_MODEL_CONFIG': return make('warning', 'Не удалось озвучить ответ', 'Прочитайте результат на экране. Не нужно повторять команду только из-за отсутствия звука.', false);
    case 'LOG_WRITE_FAILED': return make('error', 'Не удалось сохранить журнал', 'Проверьте свободное место на диске. Перед повтором проверьте результат в приложении.', false);
    default: return make('error', 'Не получилось завершить задачу', 'Проверьте нужное приложение и уточните команду. Подробности — в истории.', true);
  }
}

function execution(report) {
  const completed = list(report.completed).filter(effect);
  const events = list(report.events).length ? report.events : list(report.trace);
  const results = events.filter(event => event?.phase === 'execute_result' && effect(event.receipt));
  const receipts = results.map(event => event.receipt);
  const lastReceipt = receipts.at(-1);
  const lastRequest = events.findLastIndex(event => event?.phase === 'execute_request' && effect(event));
  const lastResult = events.findLastIndex(event => event?.phase === 'execute_result' && effect(event.receipt));
  const known = completed.some(step => effectOutcomes.has(step.outcome)) || receipts.some(receipt => receipt.verified === true);
  const observed = completed.some(step => step.outcome === 'observed_change') || receipts.some(receipt => receipt.stateChanged === true && receipt.verified !== true);
  // A launch rejection is reported before the process starts even though the
  // controller conservatively marks the surrounding launch call as in flight.
  const rejectedLaunch = launchRejected.has(report.reason);
  const uncertain = !rejectedLaunch && (report.executionUncertain === true || report.reason === 'execution_uncertain'
    || lastRequest > lastResult || receipts.some(receipt => receipt.verified !== true && receipt.stateChanged !== true)
    || completed.some(step => !effectOutcomes.has(step.outcome) && step.outcome !== 'observed_change'));
  return {known, observed, uncertain, lastReceipt};
}

function withEffects(description, state) {
  if (!state.known && !state.observed && !state.uncertain) return description;
  const prefix = state.uncertain
    ? 'Действие могло выполниться, но его результат не подтверждён.'
    : state.known ? 'Часть действий выполнена, но завершение задачи не подтверждено.'
      : 'Интерфейс изменился, но завершение задачи не подтверждено.';
  return make('warning', description.title, `${prefix} ${description.message} Перед повтором проверьте результат в приложении.`, false);
}

/** Describes the executor's evidence; a truthy ok or an old message is not proof. */
export function describeResult(value) {
  const report = value && typeof value === 'object' ? value : {};
  const state = execution(report);
  const reason = report.reason;
  if (reason === 'LOG_WRITE_FAILED') {
    return make(state.known || state.observed || state.uncertain ? 'warning' : 'error', 'Не удалось сохранить журнал',
      `${state.known || state.observed || state.uncertain ? 'Действия могли уже выполниться. ' : ''}Проверьте результат в приложении и свободное место на диске. Не повторяйте задачу, пока не убедитесь, что она не выполнена.`, false);
  }
  if (reason === 'aborted' || reason === 'ABORTED' || reason === 'WINDOWS_CHOICE_ABORTED' || reason === 'interrupted') {
    return withEffects(make('neutral', reason === 'interrupted' ? 'Выполнение прервано' : 'Выполнение остановлено', 'Можно ввести новую команду.', true), state);
  }
  if (reason === 'running' || report.status === 'running') return make('neutral', 'Выполняю задачу', 'Текущий шаг появится здесь. При необходимости нажмите «Остановить».');
  // Local and chat messages originate from successful routes only. Failure
  // branches below deliberately ignore a stale success or raw provider message.
  if (report.ok === true && reason === 'chat_answer' && text(report.message)) {
    return make('success', 'Ответ готов', report.message, false, bounded(report.message, 2000));
  }
  if (report.ok === true && reason === 'local_completed') {
    const kind = report.result?.kind ?? report.intent?.kind;
    const message = bounded(text(report.message) || 'Локальная команда выполнена.', 2000);
    return make(kind === 'help' ? 'neutral' : 'success', kind === 'help' ? 'Что умеет Jeff' : 'Готово', message, false, bounded(message, 350));
  }
  if (report.ok === true && (reason === 'goal_observed' || reason === 'goal_verified' && state.observed)) return make('warning', 'Проверьте результат', 'Интерфейс изменился согласно задаче, но не все действия удалось подтвердить средствами Windows.', false);
  if (report.ok === true && reason === 'goal_verified' && !state.uncertain) return make('success', 'Готово', 'Задача выполнена.', false, 'Готово. Задача выполнена.');
  // These matching native receipts explain the uncertainty more precisely. A
  // mismatched/invalid receipt (execution_uncertain) must not gain their trust.
  if (reason === 'not_verified' && state.lastReceipt?.evidence === 'text_set_unverified' && state.lastReceipt.operation === 'replace_text') {
    return make('warning', 'Текст передан приложению', 'Команда замены отправлена, но содержимое поля не проверялось. Проверьте текст перед повтором.', false);
  }
  if (reason === 'not_verified' && state.lastReceipt?.evidence === 'process_started_window_not_observed' && state.lastReceipt.operation === 'launch') {
    return make('warning', 'Программа запущена, окно не найдено', 'Процесс запустился, но его окно пока не удалось увидеть. Проверьте панель задач перед повтором.', false);
  }
  if (reason === 'execution_uncertain' || report.executionUncertain === true && !launchRejected.has(reason)) {
    return make('warning', 'Результат не подтверждён', 'Действие могло выполниться. Проверьте приложение перед повтором команды.', false);
  }
  if (state.lastReceipt?.evidence === 'foreground_not_granted') {
    return withEffects(make('error', 'Не получилось показать окно', 'Windows не разрешила вывести окно вперёд. Выберите приложение на панели задач.', false), {...state, uncertain: false});
  }
  let description;
  switch (reason) {
    case 'low_confidence': description = make('warning', 'Не уверен, что выбрал нужное действие', 'Уточните название приложения и одно действие, например: «Сверни Google Chrome».', true); break;
    case 'unsupported': description = make('error', 'Не нашёл подходящее действие', 'Нужное окно или элемент пока недоступны. Откройте приложение и уточните команду.', true); break;
    case 'no_request': description = make('neutral', 'Уточните, что нужно сделать', 'Для действия укажите приложение. Для вопроса начните с «Расскажи» или «Объясни».', true); break;
    case 'goal_not_verified':
    case 'not_verified': description = make('warning', 'Результат не подтверждён', 'Проверьте нужное приложение. Если задача не выполнена, уточните команду.', false); break;
    case 'time_limit': description = make('warning', 'Выполнение заняло слишком много времени', 'Разделите задачу на короткие команды и проверьте приложение.', true); break;
    case 'step_limit':
    case 'repeated_action': description = make('warning', 'Не удалось завершить задачу по шагам', 'Разделите задачу на отдельные действия с названием приложения.', true); break;
    case 'unknown_action': description = make('error', 'Не удалось выбрать действие', 'Модель выбрала недоступное действие. Уточните команду и попробуйте ещё раз.', true); break;
    case 'chat_failed': description = describeError(report.error === 'CHAT_UNAVAILABLE' || report.error === 'CHAT_INVALID_RESPONSE' ? report.error : 'CHAT_INVALID_RESPONSE');
      if (!['CHAT_UNAVAILABLE', 'CHAT_INVALID_RESPONSE'].includes(report.error)) description = make('error', 'Не получилось получить ответ Gemini', 'Проверьте подключение к интернету и попробуйте немного позже.', true);
      break;
    case 'local_rejected': {
      const validation = report.result?.ok === false && report.intent?.kind === 'error' ? text(report.intent.message) : '';
      description = make('error', 'Не получилось выполнить команду', validation || 'Проверьте текст команды и доступность локальных данных.', true);
      break;
    }
    default: description = describeError(reason);
  }
  return withEffects(description, state);
}
