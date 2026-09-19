export class Microphone {
  constructor(onChunk) { this.onChunk = onChunk; this.stream = null; this.context = null; this.node = null; this.mutedUntil = 0; this.generation = 0; }
  async start(deviceId) {
    await this.stop();
    const generation = this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false });
    if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); throw new Error('Запуск микрофона отменён.'); }
    this.stream = stream;
    try {
      this.context = new AudioContext({ sampleRate: 16000 });
      await this.context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
      if (generation !== this.generation || !this.context) throw new Error('Запуск микрофона отменён.');
      this.node = new AudioWorkletNode(this.context, 'jeff-pcm');
      this.node.port.onmessage = event => { if (performance.now() >= this.mutedUntil) this.onChunk(event.data); };
      this.source = this.context.createMediaStreamSource(stream);
      this.silent = this.context.createGain(); this.silent.gain.value = 0;
      this.source.connect(this.node); this.node.connect(this.silent); this.silent.connect(this.context.destination);
      await this.context.resume();
      stream.getTracks().forEach(track => track.addEventListener('ended', () => this.onEnded?.(), { once: true }));
    } catch (error) { await this.stop(); throw error; }
  }
  beep() {
    if (!this.context || this.context.state === 'closed') return;
    this.mutedUntil = performance.now() + 250;
    const oscillator = this.context.createOscillator(), gain = this.context.createGain(), now = this.context.currentTime;
    oscillator.frequency.value = 740; oscillator.type = 'sine';
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(.12, now + .015); gain.gain.exponentialRampToValueAtTime(.001, now + .13);
    oscillator.connect(gain); gain.connect(this.context.destination); oscillator.start(now); oscillator.stop(now + .15);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
  async stop() {
    this.generation++;
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = null; }
    this.source?.disconnect(); this.silent?.disconnect(); this.source = null; this.silent = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    const context = this.context; this.context = null; if (context && context.state !== 'closed') await context.close();
  }
}
