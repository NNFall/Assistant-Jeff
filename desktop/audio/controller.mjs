import { AssemblyStream } from './streaming.mjs';

/** Owns voice state, never opens the microphone. accept receives 80 ms PCM frames. */
export class VoiceController {
  constructor({ modelsDir, getSettings, getAssemblyKey, emit = () => {},
    onCommand, speak = async () => {}, createWake, createStream } = {}) {
    Object.assign(this, { modelsDir, getSettings, getAssemblyKey, emit, onCommand, speak });
    this.createWake = createWake ?? (async options => (await import('./wake.mjs')).WakeDetector.create(options));
    this.createStream = createStream ?? (options => new AssemblyStream(options));
    this.state = 'off';
    this.generation = 0;
  }

  status(state, message) {
    this.state = state;
    this.emit({ type: 'status', state, message });
  }

  async start() {
    if (this.stopping) await this.stopping;
    if (this.state !== 'off' && this.state !== 'error') return;
    if (this.wake) { this.status('waiting', 'Ожидаю имя.'); return; }
    const generation = ++this.generation;
    this.commandAbort = new AbortController();
    this.status('loading', 'Загружаю локальное распознавание имени.');
    const settings = this.getSettings();
    const loading = Promise.resolve().then(() => this.createWake({
      modelsDir: this.modelsDir, wakeWord: settings.wakeWord,
      threshold: settings.wakeThreshold,
    })).then(async wake => {
      if (generation !== this.generation) { await wake.close(); return; }
      this.wake = wake;
      this.status('waiting', 'Ожидаю имя.');
    }).catch(() => {
      if (generation === this.generation) this.status('error', 'Не удалось загрузить локальное распознавание имени.');
    });
    this.loading = loading;
    try { await loading; } finally {
      if (this.loading === loading) this.loading = undefined;
    }
  }

  stop() {
    if (this.stopping) return this.stopping;
    ++this.generation;
    // Signals prevent later local effects; an already submitted remote request
    // cannot be recalled by the controller and needs provider-side cancellation.
    this.commandAbort?.abort();
    this.stream?.close();
    this.stream = undefined;
    this.status('off', 'Микрофон выключен.');
    const wake = this.wake;
    this.wake = undefined;
    const pending = [this.inference, this.loading].filter(Boolean);
    this.stopping = (async () => {
      await Promise.allSettled(pending);
      if (wake) await wake.close();
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  async accept(pcm) {
    if (!(pcm instanceof Int16Array) || pcm.length !== 1280) return false;
    if (this.state === 'listening') {
      if (Date.now() < this.mutedUntil) return false;
      return this.stream?.send(pcm) ?? false;
    }
    // Drop frames while inference is busy: no accumulating promises/audio backlog.
    if (this.state !== 'waiting' || !this.wake || this.inference) return false;
    const generation = this.generation;
    let triggered = false;
    const frame = pcm.slice();
    const detector = this.wake;
    const inference = Promise.resolve().then(() => detector.accept(frame));
    this.inference = inference;
    try { triggered = (await inference)?.triggered === true; } catch {
      if (generation === this.generation) this.status('error', 'Ошибка локального распознавания имени.');
    } finally {
      if (this.inference === inference) this.inference = undefined;
    }
    if (triggered && generation === this.generation && this.state === 'waiting') void this.activate();
    return true;
  }

  async activate() {
    if (!this.wake || !['waiting', 'error'].includes(this.state)) return false;
    const generation = this.generation;
    this.status('connecting', 'Подключаю распознавание речи.');
    try {
      if (this.inference) await this.inference;
      if (generation !== this.generation) return false;
      if (!this.getSettings().cloudEnabled) {
        this.status('error', 'Включите облачные модели в настройках.');
        return false;
      }
      const apiKey = await this.getAssemblyKey();
      if (generation !== this.generation) return false;
      if (!apiKey) {
        this.status('error', 'Добавьте ключ AssemblyAI в настройках.');
        return false;
      }
      let finalized = false;
      const stream = this.createStream({
        apiKey,
        model: this.getSettings().streamingModel || 'whisper-rt',
        onTranscript: ({ text, final }) => {
          if (generation !== this.generation || this.stream !== stream || finalized) return;
          this.emit({ type: 'transcript', text, final });
          if (final) {
            finalized = true;
            this.stream = undefined;
            stream.close();
            void this.processCommand(text, generation);
          }
        },
        onError: () => {
          if (generation !== this.generation || this.stream !== stream) return;
          this.stream = undefined;
          stream.close();
          this.status('error', 'Не удалось распознать речь. Проверьте подключение и настройки.');
        },
      });
      this.stream = stream;
      await stream.start();
      if (generation !== this.generation || this.stream !== stream) { stream.close(); return false; }
      this.mutedUntil = Date.now() + 250;
      this.status('listening', 'Слушаю команду.');
      this.emit({ type: 'wake' });
      return true;
    } catch {
      if (generation === this.generation) {
        this.stream?.close();
        this.stream = undefined;
        this.status('error', 'Не удалось подключить распознавание речи.');
      }
      return false;
    }
  }

  finish() { if (this.state === 'listening') this.stream?.finish(); }

  /** Speak a queued reminder only when idle; never opens a microphone/stream. */
  async announce(text) {
    if (!['waiting', 'off'].includes(this.state) || this.stopping) return false;
    if (!this.getSettings().speakReplies || !text?.trim()) return true;
    const previous = this.state;
    const generation = this.generation;
    this.status('speaking', 'Напоминание.');
    try {
      if (this.inference) await this.inference;
      if (generation !== this.generation) return true;
      this.wake?.reset();
      await this.speak(text);
      if (generation !== this.generation) return true;
      await new Promise(resolve => setTimeout(resolve, 350));
      if (generation !== this.generation) return true;
      this.wake?.reset();
      this.status(previous, previous === 'waiting' ? 'Ожидаю имя.' : 'Микрофон выключен.');
    } catch {
      if (generation === this.generation) {
        this.status(previous, 'Не удалось озвучить напоминание.');
      }
    }
    return true;
  }

  async processCommand(text, generation) {
    if (generation !== this.generation) return;
    try {
      if (text.trim()) {
        this.status('thinking', 'Выполняю команду.');
        const result = await this.onCommand(text, { signal: this.commandAbort?.signal });
        if (generation !== this.generation) return;
        const reply = typeof result === 'string' ? result : result?.reply ?? result?.text ?? result?.message;
        if (this.getSettings().speakReplies && reply) {
          this.status('speaking', 'Отвечаю.');
          await this.speak(reply);
          if (generation !== this.generation) return;
          // Let the loudspeaker tail decay before re-enabling wake detection.
          await new Promise(resolve => setTimeout(resolve, 350));
        }
      }
      if (generation !== this.generation) return;
      this.wake?.reset();
      this.status('waiting', text.trim() ? 'Ожидаю имя.' : 'Речь не обнаружена. Ожидаю имя.');
    } catch {
      if (generation === this.generation) this.status('error', 'Не удалось выполнить голосовую команду.');
    }
  }
}
