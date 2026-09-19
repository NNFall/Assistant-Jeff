import { parseCommand, executeIntent, ALLOWED_APPS, validateText } from './core/index.mjs';
import { routeCommand } from './providers/typesafe.mjs';

const clarify = () => ({ ok: false, kind: 'unknown', message: 'Уточните одну команду: сохранить заметку, поставить напоминание или открыть приложение.' });
const offline = () => ({ ok: false, kind: 'chat', message: 'Облачный помощник выключен или не подключён. Доступны заметки, таймеры, напоминания и открытие приложений. Напишите «помощь», чтобы увидеть примеры.' });

/** Extract only verbatim source spans. Jev never supplies note text or a due date. */
function semanticNote(command) {
  const match = /^(?:пожалуйста,?\s+)?(?:запомни(?:\s+это)?|запиши|сохрани)\s*[, :]?\s*(?:что\s+)?(.+)$/iu.exec(command);
  if (!match) return null;
  try { return { kind: 'note', text: validateText(match[1]) }; } catch { return null; }
}

function semanticApp(command, appId) {
  if (!ALLOWED_APPS.includes(appId)) return null;
  // Negations, corrections and compound instructions cannot become a launch.
  if (/(?<![\p{L}\p{N}_])(?:не|нет|нельзя|отмена|отмени|передумал|лучше|вместо|кроме|никогда|don't|do not)(?![\p{L}\p{N}_])/iu.test(command)) return null;
  const normalized = command.replace(/^(?:пожалуйста,?\s+|можешь\s+(?:пожалуйста\s+)?)/iu, '').replace(/,?\s+пожалуйста[.!?…]*$/iu, '').replace(/^открыть(?=\s)/iu, 'открой').replace(/^запустить(?=\s)/iu, 'запусти');
  const parsed = parseCommand(normalized);
  return parsed.kind === 'open_app' && parsed.appId === appId ? parsed : null;
}

export class AssistantService {
  constructor({ store, settings = () => ({}), keys = () => ({}), chat, openApp, route = routeCommand }) {
    this.store = store;
    this.settings = settings;
    this.keys = keys;
    this.chat = chat;
    this.openApp = openApp;
    this.route = route;
  }

  async execute(text, { signal } = {}) {
    const started = performance.now();
    let routeName = 'local';
    const finish = result => ({ ...result, route: routeName, latencyMs: Math.round(performance.now() - started) });
    const cancelled = () => finish({ ok: false, kind: 'error', message: 'Команда отменена.' });
    try {
      if (signal?.aborted) return cancelled();
      const parsed = parseCommand(text);
      if (parsed.kind === 'error') return finish(await executeIntent(parsed, this.store));
      const command = text.trim().replace(/\s+/gu, ' ');
      if (/^(?:покажи|показать|список)(?: мои)? напоминания[.!?…]*$/iu.test(command) || /^мои напоминания[.!?…]*$/iu.test(command)) {
        const count = this.store.pending().length;
        return finish({ ok: true, kind: 'help', message: count ? `Активных напоминаний: ${count}. Они показаны во вкладке «Напоминания».` : 'Активных напоминаний пока нет.' });
      }
      if (parsed.kind === 'help') return finish(await executeIntent(parsed, this.store));
      const cloudEnabled = this.settings()?.cloudEnabled === true;
      const apiKey = this.keys()?.typesafe;
      let intent = parsed;
      if (cloudEnabled && apiKey) {
        let judgment;
        try {
          judgment = await this.route(command, { apiKey, ...(signal ? { signal } : {}) });
          routeName = 'jev';
        } catch {
          if (signal?.aborted) return cancelled();
          routeName = 'local-fallback';
          // Provider failure is the sole case that permits a local fallback.
          if (parsed.kind === 'chat') return finish({ ok: false, kind: 'error', message: 'Jev сейчас недоступен. Попробуйте ещё раз или используйте точную локальную команду из справки.' });
          return finish(await executeIntent(parsed, this.store, { openApp: this.openApp }));
        }
        if (signal?.aborted) return cancelled();
        const kind = judgment?.route;
        if (kind === 'unknown' || !['note', 'reminder', 'open_app', 'chat'].includes(kind)) return finish(clarify());
        if (kind === 'note') intent = parsed.kind === 'note' ? parsed : semanticNote(command);
        else if (kind === 'reminder') intent = parsed.kind === 'reminder' ? parsed : null;
        else if (kind === 'open_app') intent = semanticApp(command, judgment.appId);
        else {
          // A model disagreement cannot silently turn a tool request into chat.
          if (parsed.kind !== 'chat') return finish(clarify());
          intent = { kind: 'chat', text: command };
        }
        if (!intent) return finish(clarify());
      }
      if (intent.kind === 'chat') {
        if (signal?.aborted) return cancelled();
        if (!cloudEnabled || typeof this.chat !== 'function') return finish(offline());
        try {
          const answer = await this.chat(command, { signal });
          if (signal?.aborted) return cancelled();
          if (!answer || typeof answer.text !== 'string' || !answer.text.trim()) throw new Error('Empty chat result');
          routeName = routeName === 'jev' ? 'jev → gemini' : 'gemini';
          return finish({ ok: true, kind: 'chat', message: answer.text });
        } catch {
          if (signal?.aborted) return cancelled();
          return finish({ ok: false, kind: 'error', message: 'Облачный помощник сейчас недоступен. Попробуйте позже; локальные команды продолжают работать.' });
        }
      }
      if (signal?.aborted) return cancelled();
      return finish(await executeIntent(intent, this.store, { openApp: this.openApp }));
    } catch { return finish({ ok: false, kind: 'error', message: 'Не удалось выполнить команду. Проверьте настройки и попробуйте ещё раз.' }); }
  }
}
