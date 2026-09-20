import { parseCommand } from './commands.mjs';

const WORD_EDGE = '[\\p{L}\\p{N}_]';
const TOKEN_PATTERN = /[\p{L}\p{M}]+|[\p{N}]+|[^\s]/gu;
const TIME_ERROR = 'Укажите один точный срок: составные интервалы, варианты и исправления требуют уточнения.';
const CLOCK_ERROR = 'Укажите существующее местное время в формате ЧЧ:ММ.';
const UNITS = 'секунда|секунду|секунды|секунд|секунде|минута|минуту|минуты|минут|минуте|час|часа|часов|день|дня|дней|неделю|недели|недель';
// A bounded lexical match is intentionally separate from reminder/note content.
const DURATION = `(?:полчаса|(?:[^\\s,;:!?]+(?:[.,][0-9]+)?[ \\t]+){0,5}?(?:${UNITS}))`;
const DURATION_NUMBER_WORD = 'ноль|один|одна|одну|одной|два|две|двух|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать|двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто|сто|двести|триста|четыреста|пятьсот|шестьсот|семьсот|восемьсот|девятьсот|полтора|полторы';
const DURATION_NUMBER = `(?:[+−-]?[0-9]+(?:[.,][0-9]+)?|(?:${DURATION_NUMBER_WORD})(?:[ \\t]+(?:${DURATION_NUMBER_WORD})){0,3})`;
const ADDED_DURATION = `(?:полчаса|(?:${DURATION_NUMBER}[ \\t]+)?(?:${UNITS}))`;
const CORRECTION = 'а[ \\t]+лучше|а[ \\t]+нет|нет|точнее|вернее|лучше|то[ \\t]+есть';
const DAY_OFFSETS = { сегодня: 0, завтра: 1, послезавтра: 2 };

/** A pending time slot accepts only a complete, explicit clock, never free text. */
export function parseReminderTimeFollowup(text) {
  if (typeof text !== 'string') return null;
  const match = /^(?:(сегодня|завтра|послезавтра)[ \t,]+(?:в[ \t]*)?([0-9]{1,2}:[0-9]{2})|(?:в[ \t]*)?([0-9]{1,2}:[0-9]{2})(?:[ \t,]+(сегодня|завтра|послезавтра))?)[.!?]?$/iu.exec(text.trim());
  return match ? { clock: match[2] ?? match[3], ...(match[1] || match[4] ? { day: (match[1] ?? match[4]).toLowerCase() } : {}) } : null;
}

/** Stable, source-bound UTF-16 offsets; IDs are model choices, never generated text. */
export function buildSourceTokens(text) {
  if (typeof text !== 'string') return [];
  const tokens = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    if (tokens.length === 254) return [];
    tokens.push({ id: `t${tokens.length}`, start: match.index, end: match.index + match[0].length, text: match[0] });
  }
  return tokens;
}

/** Reject stale, forged, incomplete or reordered token tables before taking a slice. */
export function selectSourceSpan(text, tokens, startId, endId) {
  if (typeof text !== 'string' || !Array.isArray(tokens) || typeof startId !== 'string' || typeof endId !== 'string' || !/^t(?:0|[1-9]\d*)$/u.test(startId) || !/^t(?:0|[1-9]\d*)$/u.test(endId)) return null;
  const canonical = buildSourceTokens(text);
  if (!canonical.length || tokens.length !== canonical.length || tokens.some((token, index) => !token || ['id', 'start', 'end', 'text'].some(key => token[key] !== canonical[index][key]))) return null;
  const start = Number(startId.slice(1)), end = Number(endId.slice(1));
  if (start > end || !canonical[start] || !canonical[end]) return null;
  return text.slice(canonical[start].start, canonical[end].end).trim() || null;
}

function sourceCandidate(text, start, end, properties) {
  return { start, end, text: text.slice(start, end), ...properties };
}

function relativeCandidates(text, nowMs) {
  const candidates = [];
  const pattern = new RegExp(`(?<!${WORD_EDGE})(через|таймер[ \\t]+на)[ \\t]+(${DURATION})(?!${WORD_EDGE})`, 'giu');
  for (const match of text.matchAll(pattern)) {
    const start = match.index + (match[1].toLowerCase().startsWith('таймер') ? match[1].length - 2 : 0);
    let end = match.index + match[0].length;
    let duration = match[2].toLowerCase().replace(/\s+/gu, ' ');
    const continuation = new RegExp(`^[ \\t,;]*(?:(?:и(?:[ \\t]+ещ[её])?|или|либо|плюс|ещ[её]|${CORRECTION})[ \\t,;:]*)?(?:через[ \\t]+)?(${ADDED_DURATION})(?!${WORD_EDGE})`, 'iu').exec(text.slice(end));
    const half = /^[ \t]+с[ \t]+половиной(?![\p{L}\p{N}_])/iu.exec(text.slice(end));
    const alternative = new RegExp(`^[ \\t,;]*(?:или|либо)[ \\t]+${DURATION_NUMBER}(?!${WORD_EDGE})`, 'iu').exec(text.slice(end));
    const correction = new RegExp(`(?<!${WORD_EDGE})(?:${CORRECTION})[ \\t,;:]*(?:(?:через|на)[ \\t]+)?${ADDED_DURATION}(?!${WORD_EDGE})`, 'iu').exec(text.slice(end));
    if (continuation || half || alternative || correction) {
      const ambiguous = continuation || half || alternative || correction;
      end += ambiguous.index + ambiguous[0].length;
      candidates.push(sourceCandidate(text, start, end, { error: TIME_ERROR }));
      continue;
    }
    if (duration === 'полчаса') duration = '30 минут';
    else if (/^(?:час|минуту|минута|секунду|секунда)$/u.test(duration)) duration = `1 ${duration}`;
    const parsed = parseCommand(`напомни через ${duration} candidate`, nowMs / 1000);
    candidates.push(sourceCandidate(text, start, end, parsed.kind === 'reminder' ? { dueAt: parsed.dueAt } : { error: parsed.message || TIME_ERROR }));
  }
  return candidates;
}

function calendarTime(day, hours, minutes, nowMs) {
  if (hours > 23 || minutes > 59) return { error: CLOCK_ERROR };
  const date = new Date(nowMs);
  date.setDate(date.getDate() + DAY_OFFSETS[day]);
  date.setHours(hours, minutes, 0, 0);
  // A missing DST hour must not silently move to a different clock time.
  if (date.getHours() !== hours || date.getMinutes() !== minutes) return { error: CLOCK_ERROR };
  if (date.getTime() <= nowMs) return { error: 'Это время уже прошло. Укажите будущие дату и время.' };
  return { dueAt: date.getTime() / 1000 };
}

/** Local-time candidates only. A bare clock never implies today or tomorrow. */
export function buildTimeCandidates(text, nowMs = Date.now()) {
  if (typeof text !== 'string' || !Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime()) || nowMs < 0) return [];
  const candidates = relativeCandidates(text, nowMs);
  const days = new RegExp(`(?<!${WORD_EDGE})(послезавтра|завтра|сегодня)(?!${WORD_EDGE})(?:[ \\t]+(?:в[ \\t]+|к[ \\t]+)?([0-9]{1,3}):([0-9]{2})(?![\\p{L}\\p{N}_:]))?`, 'giu');
  for (const match of text.matchAll(days)) {
    const dayLabel = match[1].toLowerCase();
    const properties = match[2] === undefined ? { needsTime: true, dayLabel } : calendarTime(dayLabel, Number(match[2]), Number(match[3]), nowMs);
    candidates.push(sourceCandidate(text, match.index, match.index + match[0].length, properties));
  }
  const clocks = new RegExp(`(?<![\\p{L}\\p{N}_:])(?:в[ \\t]+|к[ \\t]+)?([0-9]{1,3}):([0-9]{2})(?![\\p{L}\\p{N}_:])`, 'giu');
  for (const match of text.matchAll(clocks)) {
    const start = match.index, end = start + match[0].length;
    if (candidates.some(candidate => candidate.start <= start && candidate.end >= end)) continue;
    const properties = Number(match[1]) > 23 || Number(match[2]) > 59 ? { error: CLOCK_ERROR } : { needsDate: true };
    candidates.push(sourceCandidate(text, start, end, properties));
  }
  candidates.sort((left, right) => left.start - right.start || right.end - left.end);
  // One reminder cannot safely choose one half of a compound or corrected deadline.
  if (candidates.length > 1) {
    const start = candidates[0].start, end = Math.max(...candidates.map(candidate => candidate.end));
    return [{ id: 'time0', ...sourceCandidate(text, start, end, { error: TIME_ERROR }) }];
  }
  return candidates.map((candidate, index) => ({ id: `time${index}`, ...candidate }));
}

const SMALL = { ноль: 0, нуль: 0, один: 1, одна: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19 };
const TENS = { двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90 };
const NUMBER_WORDS = [...Object.keys(SMALL), ...Object.keys(TENS), 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот', 'тысяча', 'тысячи', 'тысяч', 'минус', 'плюс'];
const NUMBER = `(?:[+−-]?[0-9]+(?:[.,][0-9]+)?|(?:${NUMBER_WORDS.join('|')})(?:[ \\t]+(?:${NUMBER_WORDS.join('|')})){0,5})`;

function cardinal(text) {
  const normalized = text.toLowerCase().replace(/\s+/gu, ' ');
  if (/^[0-9]+$/u.test(normalized)) {
    const value = Number(normalized);
    return value <= 100 ? value : null;
  }
  if (normalized === 'сто') return 100;
  if (Object.hasOwn(SMALL, normalized)) return SMALL[normalized];
  const words = normalized.split(' ');
  if (Object.hasOwn(TENS, words[0]) && (words.length === 1 || (words.length === 2 && SMALL[words[1]] > 0 && SMALL[words[1]] < 10))) return TENS[words[0]] + (SMALL[words[1]] || 0);
  return null;
}

function isRelativeVolume(text, start) {
  const prefix = text.slice(0, start).split(/[.!?;\n]/u).at(-1);
  if (/(?:^|\s)до\s*$/iu.test(prefix)) return false;
  return /(?<![\p{L}\p{N}_])(?:повысь|повысить|увеличь|увеличить|понизь|понизить|уменьши|уменьшить|прибавь|прибавить|убавь|убавить|подними|поднять|снизь|снизить|громче|погромче|тише|потише)(?![\p{L}\p{N}_])/iu.test(prefix);
}

/** Only absolute percentages, with a tightly scoped fallback for a bare number. */
export function buildVolumeCandidates(text) {
  if (typeof text !== 'string') return [];
  const candidates = [];
  const explicit = new RegExp(`(?<![\\p{L}\\p{N}_,.+−-])(${NUMBER})[ \\t]*(?:%|процент(?:а|ов|ы)?)(?!${WORD_EDGE})`, 'giu');
  for (const match of text.matchAll(explicit)) {
    const percent = cardinal(match[1]);
    if (percent === null || isRelativeVolume(text, match.index)) continue;
    candidates.push(sourceCandidate(text, match.index, match.index + match[0].length, { percent }));
  }
  const scoped = new RegExp(`(?<!${WORD_EDGE})(?:громкость|звук)[ \\t]+(?:(?:на|до)[ \\t]+)?(${NUMBER})(?![\\p{L}\\p{N}_]|[.,][0-9])(?=[ \\t]*(?:$|[.!?,;]|пожалуйста(?!${WORD_EDGE})))`, 'giu');
  for (const match of text.matchAll(scoped)) {
    const start = match.index + match[0].length - match[1].length, end = match.index + match[0].length;
    const percent = cardinal(match[1]);
    if (percent === null || isRelativeVolume(text, start) || candidates.some(candidate => candidate.start === start)) continue;
    candidates.push(sourceCandidate(text, start, end, { percent }));
  }
  return candidates.sort((left, right) => left.start - right.start).map((candidate, index) => ({ id: `volume${index}`, ...candidate }));
}
