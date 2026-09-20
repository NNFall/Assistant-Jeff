import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceTokens, selectSourceSpan, buildTimeCandidates, buildVolumeCandidates } from '../desktop/core/natural-command.mjs';

const now = new Date(2026, 11, 31, 14, 30, 0).getTime();
function exactSources(text, candidates) {
  for (const candidate of candidates) assert.equal(candidate.text, text.slice(candidate.start, candidate.end));
}

test('source tokens preserve exact source offsets, whitespace and Unicode', () => {
  const text = '  Запиши: купить  чай, «Ёж» ☕😀 42!';
  const tokens = buildSourceTokens(text);
  exactSources(text, tokens);
  assert.deepEqual(tokens.map(token => token.text), ['Запиши', ':', 'купить', 'чай', ',', '«', 'Ёж', '»', '☕', '😀', '42', '!']);
  assert.equal(selectSourceSpan(text, tokens, 't2', 't4'), 'купить  чай,');
  assert.equal(selectSourceSpan(text, tokens, 't9', 't10'), '😀 42');
  assert.equal(buildSourceTokens('а '.repeat(254)).length, 254);
  assert.deepEqual(buildSourceTokens('а '.repeat(255)), []);
});

test('source selection fails closed for invalid IDs and altered source tables', () => {
  const text = 'заметка купить чай', tokens = buildSourceTokens(text);
  for (const ids of [['none', 't2'], ['t2', 't1'], ['t0', 't99'], ['t01', 't2'], [null, 't2']]) assert.equal(selectSourceSpan(text, tokens, ...ids), null);
  assert.equal(selectSourceSpan(text, [{ ...tokens[0], end: 12 }, ...tokens.slice(1)], 't0', 't2'), null);
  assert.equal(selectSourceSpan(text + '!', tokens, 't0', 't2'), null);
  assert.equal(selectSourceSpan(text, tokens.slice(1), 't1', 't2'), null);
});

test('relative candidates reuse duration validation and retain their exact source', () => {
  for (const [phrase, seconds] of [['через две минуты', 120], ['Через полтора часа', 5400], ['через час', 3600], ['через минуту', 60], ['через секунду', 1], ['через полчаса', 1800], ['через 1,5 минуты', 90]]) {
    const text = `Джефф, ${phrase} напомни проверить чай.`;
    const candidates = buildTimeCandidates(text, now);
    assert.equal(candidates.length, 1, phrase);
    assert.equal(candidates[0].text, phrase);
    assert.equal(candidates[0].dueAt, now / 1000 + seconds, phrase);
    exactSources(text, candidates);
  }
  // The original reminder body is never supplied to the legacy command parser.
  const [candidate] = buildTimeCandidates('напомни через две минуты записать два часа работы', now);
  assert.equal(candidate.dueAt, now / 1000 + 120);
  assert.equal(candidate.text, 'через две минуты');
});

test('timer candidates are independent of a reminder body', () => {
  for (const [text, source, seconds] of [['поставь таймер на две минуты', 'на две минуты', 120], ['Можешь поставить таймер на 10 минут?', 'на 10 минут', 600]]) {
    const candidates = buildTimeCandidates(text, now);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].dueAt, now / 1000 + seconds);
    assert.equal(candidates[0].text, source);
    exactSources(text, candidates);
  }
});

test('explicit local calendar times handle today and month/year rollover', () => {
  for (const [phrase, expected] of [['сегодня в 16:05', new Date(2026, 11, 31, 16, 5)], ['завтра в 09:15', new Date(2027, 0, 1, 9, 15)], ['послезавтра 10:00', new Date(2027, 0, 2, 10)]]) {
    const text = `Пожалуйста, ${phrase} напомни про чай`;
    const candidates = buildTimeCandidates(text, now);
    assert.equal(candidates[0].dueAt, expected.getTime() / 1000, phrase);
    assert.equal(candidates[0].text, phrase);
    exactSources(text, candidates);
  }
});

test('a bare day requires a time and a bare clock requires a date', () => {
  for (const day of ['сегодня', 'завтра', 'послезавтра']) {
    const [candidate] = buildTimeCandidates(`напомни ${day} купить чай`, now);
    assert.equal(candidate.needsTime, true); assert.equal(candidate.dayLabel, day); assert.equal(candidate.dueAt, undefined);
  }
  const [clock] = buildTimeCandidates('напомни в 10:30 проверить чай', now);
  assert.equal(clock.needsDate, true); assert.equal(clock.dueAt, undefined);
});

test('invalid, multiple and compound deadlines never expose a schedulable candidate', () => {
  for (const phrase of ['через -5 минут', 'через ноль минут', 'через два или три часа', 'через 999999 часов', 'через 2 дня', 'через час и 30 минут', 'через две минуты плюс десять секунд', 'через два часа с половиной', 'через две минуты, а лучше через три минуты', 'через час или два', 'через час либо полчаса', 'через две минуты выпить чай, а лучше три минуты', 'завтра или послезавтра', 'завтра в 24:00', 'завтра в 10:99', 'сегодня в 09:00', 'через час завтра', 'завтра в 10:00 или 11:00', 'таймер на 2 минуты и 30 секунд']) {
    const text = `Напомни ${phrase} проверить чай`;
    const candidates = buildTimeCandidates(text, now);
    assert.ok(candidates.length, phrase);
    assert.ok(candidates.every(candidate => candidate.error && candidate.dueAt === undefined), phrase);
    exactSources(text, candidates);
  }
  assert.deepEqual(buildTimeCandidates('напомни через две минуты чай', NaN), []);
  assert.deepEqual(buildTimeCandidates('перейди через дорогу', now), []);
});

test('absolute volume candidates support numeric and Russian cardinal values', () => {
  for (const [text, percent, source] of [['сделай громкость 75%', 75, '75%'], ['поставь звук на семьдесят пять процентов', 75, 'семьдесят пять процентов'], ['громкость ноль процентов', 0, 'ноль процентов'], ['громкость сто процентов', 100, 'сто процентов'], ['громкость на 50', 50, '50'], ['громкость до сорока', null, null], ['увеличь громкость до 70%', 70, '70%'], ['громкость на двадцать один, пожалуйста', 21, 'двадцать один']]) {
    const candidates = buildVolumeCandidates(text);
    if (percent === null) assert.deepEqual(candidates, []);
    else { assert.equal(candidates.length, 1, text); assert.equal(candidates[0].percent, percent, text); assert.equal(candidates[0].text, source); }
    exactSources(text, candidates);
  }
});

test('volume extraction never infers relative loudness or accepts malformed numbers', () => {
  for (const text of ['сделай погромче', 'уменьши громкость на 10%', 'сделай громче на двадцать процентов', 'громкость 101%', 'громкость минус пять процентов', 'громкость -5%', 'громкость 12.5%', 'громкость сто пятьдесят процентов', 'громкость один два процента', 'поставь 50', 'громкость 50 раз']) assert.deepEqual(buildVolumeCandidates(text), [], text);
});
