import { MAX_COMMAND_LENGTH, MAX_DELAY_SECONDS, validateText, validateTimestamp } from './store.mjs';

const SMALL = { один: 1, одна: 1, одну: 1, одной: 1, два: 2, две: 2, двух: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19 };
const TENS = Object.fromEntries('двадцать тридцать сорок пятьдесят шестьдесят семьдесят восемьдесят девяносто'.split(' ').map((word, i) => [word, (i + 2) * 10]));
const HUNDREDS = Object.fromEntries('сто двести триста четыреста пятьсот шестьсот семьсот восемьсот девятьсот'.split(' ').map((word, i) => [word, (i + 1) * 100]));
const UNITS = { секунда: 1, секунду: 1, секунды: 1, секунд: 1, секунде: 1, минута: 60, минуту: 60, минуты: 60, минут: 60, минуте: 60, час: 3600, часа: 3600, часов: 3600 };
const unitPattern = Object.keys(UNITS).join('|');
const durationPattern = new RegExp(`^(.+?)\\s+(${unitPattern})(?=$|[\\s,])(?:(?:\\s*,\\s*|\\s+)(.*))?$`, 'iu');
const durationStart = new RegExp(`^(.+?)\\s+(?:${unitPattern})(?=$|[\\s,.;:!?…])`, 'iu');
const correction = /(?<![\p{L}\p{N}_])(?:а\s+лучше|а\s+нет|нет|точнее|вернее|лучше|то\s+есть)(?![\p{L}\p{N}_])[\s,.:;!?]*(?:(?:через|на)\s+)?/giu;
export const ALLOWED_APPS = Object.freeze(['calculator', 'notepad', 'browser', 'explorer']);
const apps = { калькулятор: 'calculator', блокнот: 'notepad', браузер: 'browser', проводник: 'explorer' };
export const HELP = 'Команды: «запиши заметку купить хлеб», «поставь таймер на две минуты», «напомни через полтора часа проверить чай», «открой калькулятор». Можно открыть блокнот, браузер и проводник. Поддерживаются секунды, минуты и часы, до 365 дней. Календарные даты и составные интервалы пока не поддерживаются.';

function number(text) {
  let value = 0;
  if (/^[0-9]+(?:[.,][0-9]+)?$/u.test(text)) value = Number(text.replace(',', '.'));
  else if (['полтора', 'полторы'].includes(text)) value = 1.5;
  else {
    const words = text.split(/\s+/u);
    if (Object.hasOwn(HUNDREDS, words[0])) value += HUNDREDS[words.shift()];
    if (Object.hasOwn(TENS, words[0])) {
      value += TENS[words.shift()];
      if (SMALL[words[0]] > 0 && SMALL[words[0]] < 10) value += SMALL[words.shift()];
    } else if (Object.hasOwn(SMALL, words[0])) value += SMALL[words.shift()];
    if (words.length) throw new TypeError('Не удалось распознать число. Укажите положительное число цифрами или словами.');
  }
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('Длительность должна быть конечным положительным числом.');
  return value;
}
function startsWithDuration(text) {
  const remainder = text.toLowerCase().replace(/^(?:и(?: ещё| еще)?|плюс)(?![\p{L}\p{N}_])[\s,]*/u, '');
  const match = durationStart.exec(remainder);
  if (!match) return false;
  try { number(match[1]); return true; } catch { return false; }
}
function ambiguousDuration(text) {
  return startsWithDuration(text) || [...text.matchAll(correction)].some(match => startsWithDuration(text.slice(match.index + match[0].length)));
}

export function parseCommand(text, now = Date.now() / 1000) {
  try {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('Введите команду.');
    if ([...text].length > MAX_COMMAND_LENGTH) throw new TypeError(`Команда не должна превышать ${MAX_COMMAND_LENGTH} символов.`);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)) throw new TypeError('Команда содержит недопустимые управляющие символы.');
    const command = text.trim().replace(/\s+/gu, ' ');
    if (['помощь', 'справка', 'что ты умеешь'].includes(command.toLowerCase())) return { kind: 'help', message: HELP };
    const note = /^(?:запиши заметку|сохрани заметку|создай заметку|заметка)(?=$|[\s:,])\s*[:,]?\s*(.*)$/iu.exec(command);
    if (note) return { kind: 'note', text: validateText(note[1]) };
    const app = /^(?:открой|запусти) (калькулятор|блокнот|браузер|проводник)[.!?…]*$/iu.exec(command);
    if (app) return { kind: 'open_app', appId: apps[app[1].toLowerCase()] };
    const timer = /^(?:поставь таймер|таймер) на\s+(.+)$/iu.exec(command);
    const reminder = /^(?:напомни|поставь напоминание) через\s+(.+)$/iu.exec(command);
    const match = timer || reminder;
    if (!match) {
      if (/^(?:напомни|поставь напоминание|таймер|поставь таймер)(?=$|\s)/iu.test(command)) throw new TypeError('Укажите срок: «напомни через 10 минут проверить чай». Календарные даты пока не поддерживаются.');
      return { kind: 'chat', text: command };
    }
    const interval = timer ? match[1].replace(/[.!?…]+$/u, '').trimEnd() : match[1];
    const duration = durationPattern.exec(interval);
    if (!duration) throw new TypeError('Укажите длительность числом и единицей: секунды, минуты или часы.');
    const delay = number(duration[1].toLowerCase()) * UNITS[duration[2].toLowerCase()];
    if (delay > MAX_DELAY_SECONDS) throw new TypeError('Максимальный интервал: 365 дней.');
    const body = duration[3] || '';
    if (timer && duration[3] !== undefined) throw new TypeError('После длительности таймера не должно быть других команд или текста.');
    if (body && ambiguousDuration(body)) throw new TypeError('Составные интервалы и исправления срока не поддерживаются. Укажите одно число и единицу.');
    if (!timer && !/[\p{L}\p{N}]/u.test(body)) throw new TypeError('Укажите текст напоминания после длительности.');
    const payload = validateText(timer ? `Таймер на ${interval}` : body);
    const current = validateTimestamp(now);
    const dueAt = validateTimestamp(current + delay);
    if (dueAt <= current) throw new TypeError('Слишком малая длительность для указанного времени.');
    return { kind: 'reminder', text: payload, dueAt, message: `${timer ? 'Таймер установлен' : 'Напоминание установлено'}: через ${String(delay).replace('.', ',')} с.` };
  } catch (error) { return { kind: 'error', message: error.message }; }
}

/** Only validated intents reach local tools; no shell text is accepted. */
export async function executeIntent(intent, store, { openApp } = {}) {
  if (!intent || typeof intent !== 'object') return { ok: false, kind: 'error', message: 'Некорректная команда.' };
  try {
    switch (intent.kind) {
      case 'note': return { ok: true, kind: 'note', message: 'Заметка сохранена.', id: store.addNote(validateText(intent.text)) };
      case 'reminder': return { ok: true, kind: 'reminder', message: intent.message || 'Напоминание установлено.', id: store.addReminder(validateText(intent.text), validateTimestamp(intent.dueAt)) };
      case 'open_app':
        if (!ALLOWED_APPS.includes(intent.appId)) return { ok: false, kind: 'error', message: 'Это приложение не входит в список разрешённых.' };
        if (typeof openApp !== 'function') return { ok: false, kind: 'error', message: 'Открытие приложений сейчас недоступно.' };
        await openApp(intent.appId);
        return { ok: true, kind: 'open_app', message: 'Приложение открыто.' };
      case 'help': return { ok: true, kind: 'help', message: HELP };
      case 'error': return { ok: false, kind: 'error', message: intent.message || 'Не удалось распознать команду.' };
      case 'chat': return { ok: false, kind: 'chat', message: 'Для этого запроса нужен облачный помощник.' };
      default: return { ok: false, kind: 'error', message: 'Неизвестный тип команды.' };
    }
  } catch (error) {
    return { ok: false, kind: 'error', message: error instanceof TypeError ? error.message : 'Не удалось выполнить действие. Проверьте доступность локальных данных или приложения.' };
  }
}
