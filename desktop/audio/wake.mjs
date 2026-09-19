import path from 'node:path';
import * as ort from 'onnxruntime-node';

export const WAKE_WORDS = Object.freeze(['hey_jarvis', 'alexa', 'hey_mycroft', 'hey_rhasspy']);
export const FRAME_SAMPLES = 1280; // mono PCM16, 16 kHz, 80 ms
const MEL_BINS = 32;
const MEL_FRAMES = 76;
const FEATURE_SIZE = 96;
const FEATURE_FRAMES = 16;
// A complete real mel window, then a complete classifier window. No randomized
// startup features: ignore the first 2.08 seconds after startup/reset.
const WARMUP_FRAMES = 26;

/** Local openWakeWord ONNX inference. Call accept sequentially, never concurrently.
 * Streaming math follows openWakeWord 0.6 AudioFeatures (Apache-2.0), by
 * David Scripka: https://github.com/dscripka/openWakeWord/blob/v0.6.0/openwakeword/utils.py
 * Model files retain their separate upstream licenses.
 */
export class WakeDetector {
  static async create({ modelsDir, wakeWord = 'hey_jarvis', threshold = 0.5 } = {}) {
    if (!modelsDir || typeof modelsDir !== 'string') throw new TypeError('modelsDir is required');
    if (!WAKE_WORDS.includes(wakeWord)) throw new RangeError('Unsupported wake word');
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new RangeError('Invalid wake threshold');
    const options = { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1 };
    const sessions = [];
    try {
      for (const file of ['melspectrogram.onnx', 'embedding_model.onnx', `${wakeWord}_v0.1.onnx`]) {
        sessions.push(await ort.InferenceSession.create(path.join(modelsDir, file), options));
      }
      return new WakeDetector(sessions, threshold);
    } catch (error) {
      await Promise.allSettled(sessions.map(session => session.release()));
      throw error;
    }
  }

  constructor(sessions, threshold) {
    [this.melSession, this.embeddingSession, this.wakeSession] = sessions;
    this.threshold = threshold;
    this.closed = false;
    this.busy = false;
    this.reset();
  }

  reset() {
    if (this.busy) throw new Error('Cannot reset while wake inference is running');
    this.tail = new Int16Array(0);
    this.mel = new Float32Array(MEL_FRAMES * MEL_BINS).fill(1);
    this.features = new Float32Array(FEATURE_FRAMES * FEATURE_SIZE);
    this.frames = 0;
    this.streak = 0;
    this.cooldown = 0;
  }

  async accept(pcm) {
    if (this.closed) throw new Error('Wake detector is closed');
    if (!(pcm instanceof Int16Array) || pcm.length !== FRAME_SAMPLES) {
      throw new TypeError('Expected exactly 1280 mono PCM16 samples at 16000 Hz');
    }
    if (this.busy) throw new Error('Wake inference must be sequential');
    this.busy = true;
    try {
      // Preserve PCM16 amplitude, do NOT normalize to [-1, 1]. The first
      // block has no overlap, matching the upstream raw-data deque.
      const audio = new Float32Array(this.tail.length + pcm.length);
      audio.set(this.tail);
      audio.set(pcm, this.tail.length);
      this.tail = pcm.slice(-480);
      const melResult = await this.melSession.run({
        [this.melSession.inputNames[0]]: new ort.Tensor('float32', audio, [1, audio.length]),
      });
      const melOutput = melResult[this.melSession.outputNames[0]].data;
      if (melOutput.length % MEL_BINS !== 0 || melOutput.length > this.mel.length) {
        throw new Error('Unexpected melspectrogram model output');
      }
      this.mel.copyWithin(0, melOutput.length);
      for (let i = 0; i < melOutput.length; i++) {
        this.mel[this.mel.length - melOutput.length + i] = melOutput[i] / 10 + 2;
      }
      const embeddingResult = await this.embeddingSession.run({
        [this.embeddingSession.inputNames[0]]: new ort.Tensor('float32', this.mel, [1, MEL_FRAMES, MEL_BINS, 1]),
      });
      const embedding = embeddingResult[this.embeddingSession.outputNames[0]].data;
      if (embedding.length !== FEATURE_SIZE) throw new Error('Unexpected embedding model output');
      this.features.copyWithin(0, FEATURE_SIZE);
      this.features.set(embedding, this.features.length - FEATURE_SIZE);
      const wakeResult = await this.wakeSession.run({
        [this.wakeSession.inputNames[0]]: new ort.Tensor('float32', this.features, [1, FEATURE_FRAMES, FEATURE_SIZE]),
      });
      const rawScore = Number(wakeResult[this.wakeSession.outputNames[0]].data[0]);
      if (!Number.isFinite(rawScore)) throw new Error('Non-finite wake score');
      const score = ++this.frames <= WARMUP_FRAMES ? 0 : Math.max(0, Math.min(1, rawScore));
      if (this.cooldown > 0) this.cooldown--;
      this.streak = score >= this.threshold ? this.streak + 1 : 0;
      const triggered = this.streak >= 2 && this.cooldown === 0;
      if (triggered) {
        this.cooldown = 25; // 2 seconds of captured audio, independent of CPU speed
        this.streak = 0;
      }
      return { score, triggered };
    } finally {
      this.busy = false;
    }
  }

  async close() {
    if (this.busy) throw new Error('Cannot close while wake inference is running');
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([this.melSession, this.embeddingSession, this.wakeSession].map(session => session.release()));
  }
}
