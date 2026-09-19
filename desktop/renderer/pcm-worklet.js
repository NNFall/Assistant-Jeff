// Resample the browser input to 16 kHz and emit bounded 80 ms PCM frames.
class JeffPcmProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.position = 0; this.pending = []; this.frame = new Int16Array(1280); this.used = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    this.pending.push(...input);
    while (this.position + 1 < this.pending.length) {
      const index = Math.floor(this.position), fraction = this.position - index;
      const value = Math.max(-1, Math.min(1, this.pending[index] * (1 - fraction) + this.pending[index + 1] * fraction));
      this.frame[this.used++] = value < 0 ? value * 32768 : value * 32767;
      if (this.used === this.frame.length) { this.port.postMessage(this.frame); this.frame = new Int16Array(1280); this.used = 0; }
      this.position += this.ratio;
    }
    const consumed = Math.floor(this.position); this.pending.splice(0, consumed); this.position -= consumed;
    return true;
  }
}
registerProcessor('jeff-pcm', JeffPcmProcessor);
