export const SAMPLE_RATE = 16000;
export const WAKE_FRAME_SAMPLES = 1280;
export const PRE_ROLL_SAMPLES = Math.round(SAMPLE_RATE * 0.7);
export const MAX_CHUNK_SAMPLES = SAMPLE_RATE;
export const MAX_UTTERANCE_SAMPLES = SAMPLE_RATE * 30;
export const DEFAULT_SILENCE_MS = 2000;

export function silenceDurationMs(value) {
  return Math.max(2000, Math.min(3000, Number.isFinite(value) ? value : DEFAULT_SILENCE_MS));
}

export function validPcm(chunk) {
  return chunk instanceof Int16Array && chunk.length > 0 && chunk.length <= MAX_CHUNK_SAMPLES;
}

export function rms(pcm) {
  if (!pcm.length) return 0;
  let sum = 0;
  for (const value of pcm) sum += value * value;
  return Math.sqrt(sum / pcm.length) / 32768;
}

export function voiceThreshold(noiseFloor = 0.003) {
  return Math.max(0.006, Math.min(0.035, noiseFloor * 3));
}

/** Remove a wake name only at the beginning; never alter names inside a command. */
export function stripWakePrefix(text) {
  if (typeof text !== 'string') return '';
  return text.trim().replace(/^(?:(?:hey|эй|хей)[\s,.:;!?—–-]*)?(?:jarvis|джарвис)(?=$|[\s,.:;!?—–-])[\s,.:;!?—–-]*/iu, '').trim();
}

/** A fixed-size PCM ring. It holds no references to caller-owned microphone frames. */
export class SampleRing {
  constructor(capacity = PRE_ROLL_SAMPLES) {
    this.data = new Int16Array(capacity);
    this.clear();
  }

  clear() {
    this.data.fill(0);
    this.cursor = 0;
    this.length = 0;
  }

  push(pcm) {
    const source = pcm.length > this.data.length ? pcm.subarray(pcm.length - this.data.length) : pcm;
    const first = Math.min(source.length, this.data.length - this.cursor);
    this.data.set(source.subarray(0, first), this.cursor);
    if (first < source.length) this.data.set(source.subarray(first), 0);
    this.cursor = (this.cursor + source.length) % this.data.length;
    this.length = Math.min(this.data.length, this.length + source.length);
  }

  snapshot() {
    const result = new Int16Array(this.length);
    const start = (this.cursor - this.length + this.data.length) % this.data.length;
    const first = Math.min(this.length, this.data.length - start);
    result.set(this.data.subarray(start, start + first));
    if (first < this.length) result.set(this.data.subarray(0, this.length - first), first);
    return result;
  }
}

/** Locally retains one bounded utterance; pre-roll does not count as command speech. */
export class UtteranceRecorder {
  constructor({ preRoll = new Int16Array(), noiseFloor, silenceMs = DEFAULT_SILENCE_MS } = {}) {
    this.data = new Int16Array(MAX_UTTERANCE_SAMPLES);
    const prefix = preRoll.subarray(Math.max(0, preRoll.length - PRE_ROLL_SAMPLES));
    this.data.set(prefix);
    this.length = prefix.length;
    this.preRollSamples = prefix.length;
    this.elapsedSamples = 0;
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.threshold = voiceThreshold(noiseFloor);
    this.silenceLimit = Math.round(SAMPLE_RATE * silenceDurationMs(silenceMs) / 1000);
    this.complete = false;
    this.reason = null;
  }

  get hasSpeech() { return this.speechSamples >= SAMPLE_RATE * 0.2; }

  accept(pcm) {
    if (!validPcm(pcm) || this.complete) return false;
    for (let offset = 0; offset < pcm.length && !this.complete; offset += WAKE_FRAME_SAMPLES) {
      const block = pcm.subarray(offset, offset + WAKE_FRAME_SAMPLES);
      const speech = rms(block) >= this.threshold;
      let count = Math.min(block.length, this.data.length - this.length);
      if (!speech && this.hasSpeech) count = Math.min(count, this.silenceLimit - this.silenceSamples);
      if (!this.hasSpeech && !speech) count = Math.min(count, SAMPLE_RATE * 8 - this.elapsedSamples);
      count = Math.max(0, count);
      this.data.set(block.subarray(0, count), this.length);
      this.length += count;
      this.elapsedSamples += count;
      if (speech) {
        this.speechSamples += count;
        this.silenceSamples = 0;
      } else this.silenceSamples += count;

      if (this.hasSpeech && this.silenceSamples >= this.silenceLimit) this.end('silence');
      else if (!this.hasSpeech && this.elapsedSamples >= SAMPLE_RATE * 8) this.end('no_speech');
      else if (this.length >= this.data.length) this.end('max_duration');
    }
    return true;
  }

  end(reason = 'manual') {
    if (!this.complete) {
      this.complete = true;
      this.reason = this.hasSpeech ? reason : 'no_speech';
    }
    return this.metadata();
  }

  metadata() {
    return {
      reason: this.reason,
      durationMs: Math.round(this.length / SAMPLE_RATE * 1000),
      speechMs: Math.round(this.speechSamples / SAMPLE_RATE * 1000),
      preRollMs: Math.round(this.preRollSamples / SAMPLE_RATE * 1000),
      hasSpeech: this.hasSpeech,
    };
  }

  take() {
    this.end();
    const pcm = this.hasSpeech ? this.data.slice(0, this.length) : null;
    this.clear();
    return pcm;
  }

  clear() { this.data.fill(0); }
}
