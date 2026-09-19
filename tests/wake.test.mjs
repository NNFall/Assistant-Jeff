import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WakeDetector, WAKE_WORDS, FRAME_SAMPLES } from '../desktop/audio/wake.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = path.join(root, 'models');

test('wake detector rejects invalid configuration before creating sessions', async () => {
  await assert.rejects(WakeDetector.create(), /modelsDir/);
  await assert.rejects(WakeDetector.create({ modelsDir, wakeWord: '../other' }), /Unsupported/);
  await assert.rejects(WakeDetector.create({ modelsDir, threshold: NaN }), /threshold/);
});

for (const wakeWord of WAKE_WORDS) {
  test(`native ${wakeWord}: silence, reset and lifecycle`, async () => {
    const detector = await WakeDetector.create({ modelsDir, wakeWord });
    try {
      await assert.rejects(detector.accept(new Float32Array(FRAME_SAMPLES)), /PCM16/);
      await assert.rejects(detector.accept(new Int16Array(400)), /1280/);
      const scores = [];
      for (let i = 0; i < 50; i++) {
        const result = await detector.accept(new Int16Array(FRAME_SAMPLES));
        assert.equal(result.triggered, false, 'silence must not activate');
        assert.ok(Number.isFinite(result.score));
        scores.push(result.score);
      }
      detector.reset();
      for (let i = 0; i < 50; i++) {
        assert.equal((await detector.accept(new Int16Array(FRAME_SAMPLES))).score, scores[i], 'reset must clear all history');
      }
    } finally { await detector.close(); }
    await detector.close();
    await assert.rejects(detector.accept(new Int16Array(FRAME_SAMPLES)), /closed/);
  });
}

// Optional development fixture generated from SAPI + Python openWakeWord. It
// lives in ignored work/, contains synthesized speech only and is not shipped.
test('native scores agree with Python oracle on synthesized Hey Jarvis', {
  skip: !process.env.WAKE_ORACLE,
}, async () => {
  const fixture = JSON.parse(await fs.readFile(process.env.WAKE_ORACLE, 'utf8'));
  const pcmBytes = await fs.readFile(path.resolve(path.dirname(process.env.WAKE_ORACLE), fixture.pcm));
  const pcm = new Int16Array(pcmBytes.buffer.slice(pcmBytes.byteOffset, pcmBytes.byteOffset + pcmBytes.byteLength));
  const detector = await WakeDetector.create({ modelsDir });
  let peak = 0;
  let triggers = 0;
  try {
    for (let i = 0; i < fixture.scores.length; i++) {
      const result = await detector.accept(pcm.subarray(i * FRAME_SAMPLES, (i + 1) * FRAME_SAMPLES));
      if (i >= 26) assert.ok(Math.abs(result.score - fixture.scores[i]) < 0.0002,
        `frame ${i}: JS=${result.score} Python=${fixture.scores[i]}`);
      peak = Math.max(peak, result.score);
      if (result.triggered) triggers++;
    }
    assert.ok(peak >= 0.5, 'synthetic Jarvis should score above threshold');
    assert.equal(triggers, 1, 'one utterance should generate one activation');
  } finally { await detector.close(); }
});
