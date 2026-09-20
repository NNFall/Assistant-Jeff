import { SampleRing, UtteranceRecorder, WAKE_FRAME_SAMPLES, validPcm, rms,
  stripWakePrefix, voiceThreshold } from './utterance.mjs';

const MAX_PENDING_WAKE_FRAMES = 6;

/** Owns voice state, not a microphone. Cloud audio starts only after activation. */
export class BatchVoiceController {
  constructor({ createWake, encodeMp3, transcribe, createTranscriptionStream,
    onTranscript = async () => {}, onNotice = async () => {},
    emit = () => {}, getSettings = () => ({}), now = () => performance.now() } = {}) {
    if ((typeof encodeMp3 !== 'function' || typeof transcribe !== 'function') && typeof createTranscriptionStream !== 'function') {
      throw new TypeError('A transcription stream or encodeMp3 and transcribe are required');
    }
    this.createWake = createWake ?? (async options => (await import('./wake.mjs')).WakeDetector.create(options));
    Object.assign(this, { encodeMp3, transcribe, createTranscriptionStream, onTranscript, onNotice, emit, getSettings, now });
    this.state = 'stopped';
    this.generation = 0;
    this.ring = new SampleRing();
    this.wakeFrames = [];
    this.wakeTail = new Int16Array();
    this.noiseFloor = 0.003;
  }

  snapshot() {
    return { state: this.state, manual: this.config?.manual === true,
      recording: this.recorder?.metadata() ?? null };
  }

  status(state, message, metadata = {}) {
    this.state = state;
    this.emit({ type: 'status', state, message, ...metadata });
  }

  async notice(code, message, metadata = {}) {
    this.status('ready', message, { ...metadata, code });
    await this.onNotice(code, { ...metadata, signal: this.abort?.signal });
  }

  clearWaiting() {
    this.ring.clear();
    this.wakeFrames.length = 0;
    this.wakeTail = new Int16Array();
    this.waitingSamples = 0;
  }

  async start(config = {}) {
    if (this.stopping) await this.stopping;
    if (this.state === 'error') await this.stop();
    if (this.running) return this.starting ?? this.snapshot();
    const settings = this.getSettings() ?? {};
    this.config = { ...settings, ...config };
    this.config.manual = config.manual === true;
    this.running = true;
    const generation = ++this.generation;
    this.abort = new AbortController();
    this.clearWaiting();
    this.noiseFloor = 0.003;
    this.status('waiting', this.config.manual ? 'Готов к записи команды.' : 'Загружаю локальное распознавание имени.');
    const loading = (async () => {
      if (!this.config.manual) {
        try {
          const wake = await this.createWake({ modelsDir: this.config.modelsDir,
            wakeWord: this.config.wakeWord ?? 'hey_jarvis',
            threshold: this.config.wakeThreshold ?? 0.5 });
          if (generation !== this.generation) { await wake.close(); return this.snapshot(); }
          this.wake = wake;
        } catch {
          if (generation === this.generation) {
            this.running = false;
            this.recorder?.clear();
            this.recorder = null;
            this.clearWaiting();
            await this.notice('WAKE_LOAD_FAILED', 'Не удалось загрузить локальное распознавание имени.');
            if (generation === this.generation) this.status('error', 'Не удалось загрузить локальное распознавание имени.', { code: 'WAKE_LOAD_FAILED' });
          }
          return this.snapshot();
        }
      }
      if (generation === this.generation && this.state === 'waiting') {
        this.status('waiting', this.config.manual ? 'Готов к записи команды.' : 'Ожидаю имя Jarvis.');
      }
      return this.snapshot();
    })();
    this.starting = loading;
    try { return await loading; }
    finally { if (this.starting === loading) this.starting = null; }
  }

  stop({ message = 'Микрофон выключен.', metadata = {} } = {}) {
    if (this.stopping) return this.stopping;
    ++this.generation;
    this.running = false;
    this.abort?.abort();
    this.closeLive();
    this.clearWaiting();
    this.recorder?.clear();
    this.recorder = null;
    this.activePcm?.fill(0);
    this.activePcm = null;
    this.status('stopped', message, metadata);
    const wake = this.wake;
    this.wake = null;
    const pending = [this.inference, this.starting].filter(Boolean);
    const closing = (async () => {
      await Promise.allSettled(pending);
      if (wake) await wake.close();
      return this.snapshot();
    })();
    this.stopping = closing;
    closing.finally(() => { if (this.stopping === closing) this.stopping = null; }).catch(() => {});
    return closing;
  }

  /** Begin synchronously, before any notification sound or cloud initialization. */
  activate({ source = 'manual', detectedThroughSample } = {}) {
    if (!this.running || this.state !== 'waiting') return false;
    const preRoll = this.ring.snapshot();
    const capturedAfterWake = source === 'wake' && Number.isFinite(detectedThroughSample)
      ? Math.min(preRoll.length, Math.max(0, this.waitingSamples - detectedThroughSample)) : 0;
    const speechOffset = preRoll.length - capturedAfterWake;
    const settings = { ...this.config, ...(this.getSettings() ?? {}) };
    this.utteranceMode = settings.transcriptionMode === 'live' ? 'live' : 'batch';
    this.recorder = new UtteranceRecorder({ preRoll: preRoll.subarray(0, speechOffset),
      noiseFloor: this.noiseFloor, silenceMs: settings.silenceMs ?? settings.voiceSilenceMs });
    // Audio already captured while ONNX was busy is command audio, not just context.
    if (capturedAfterWake) this.recorder.accept(preRoll.subarray(speechOffset));
    this.clearWaiting();
    this.status('recording', 'Слушаю команду.');
    if (this.utteranceMode === 'live' && settings.cloudEnabled !== false) {
      this.beginLive();
      // Includes wake context and command audio captured during wake inference once.
      this.sendLive(this.recorder.data.subarray(0, this.recorder.length));
    }
    this.emit({ type: 'wake', source, beep: settings.voiceBeep ?? settings.wakeBeep ?? true,
      duckAudio: settings.duckAudio ?? true });
    return true;
  }

  beginLive() {
    const live = { generation: this.generation, startedAt: this.now(), firstPartialMs: null,
      sentSamples: 0, abort: new AbortController(), signal: this.abort.signal };
    this.live = live;
    const current = () => this.live === live && live.generation === this.generation &&
      !live.signal.aborted && !live.abort.signal.aborted && !live.error;
    live.cancel = () => this.closeLive(live);
    live.signal.addEventListener('abort', live.cancel, { once: true });
    this.emit({ type: 'stream_status', state: 'connecting' });
    try {
      if (typeof this.createTranscriptionStream !== 'function') {
        throw Object.assign(new Error(), { code: 'LIVE_TRANSCRIPTION_UNAVAILABLE' });
      }
      live.stream = this.createTranscriptionStream({ signal: live.abort.signal,
        onTranscript: transcript => {
          if (!current() || !['recording', 'transcribing'].includes(this.state)) return;
          const text = stripWakePrefix(typeof transcript === 'string' ? transcript : transcript?.text ?? transcript?.transcript).slice(0, 1024);
          if (!text || text === live.lastPartial) return;
          live.firstPartialMs ??= Math.max(0, Math.round(this.now() - live.startedAt));
          live.lastPartial = text;
          // Provider turn boundaries are not authorization to execute a command.
          this.emit({ type: 'transcript', text, final: false, autoExecute: false, mode: 'live' });
        },
        onMetrics: metrics => {
          if (current()) this.emit({ ...metrics, type: 'transcription_metrics', mode: 'live' });
        },
      });
      // Opening and recording run concurrently; send() owns its bounded connection queue.
      live.ready = Promise.resolve(live.stream.start()).then(() => {
        if (current()) {
          live.providerReadyMs = Math.max(0, Math.round(this.now() - live.startedAt));
          if (this.state === 'recording') this.emit({ type: 'stream_status', state: 'live' });
        }
      }).catch(error => this.failLive(live, error));
    } catch (error) { this.failLive(live, error); }
  }

  failLive(live, error) {
    if (this.live !== live || live.signal.aborted || live.error) return;
    live.error = error ?? Object.assign(new Error(), { code: 'LIVE_TRANSCRIPTION_FAILED' });
    live.closed = true;
    live.abort.abort();
    try { Promise.resolve(live.stream?.close()).catch(() => {}); } catch {}
  }

  sendLive(pcm) {
    const live = this.live;
    if (!pcm.length || !live || live.error || live.signal.aborted) return;
    if ((this.getSettings() ?? {}).cloudEnabled === false) {
      this.failLive(live, Object.assign(new Error(), { code: 'CLOUD_DISABLED' }));
      return;
    }
    try {
      if (live.stream.send(pcm.slice()) !== true) {
        throw Object.assign(new Error(), { code: 'LIVE_AUDIO_REJECTED' });
      }
      live.sentSamples += pcm.length;
    } catch (error) { this.failLive(live, error); }
  }

  closeLive(live = this.live) {
    if (!live) return;
    if (this.live === live) this.live = null;
    live.signal.removeEventListener('abort', live.cancel);
    if (live.closed) return;
    live.closed = true;
    live.abort.abort();
    try { Promise.resolve(live.stream?.close()).catch(() => {}); } catch {}
  }

  /** Returns immediately; inference queues are bounded and PCM is copied before returning. */
  accept(pcm) {
    if (!validPcm(pcm) || !this.running) return false;
    if (this.state === 'recording' && this.recorder) {
      const previousLength = this.recorder.length;
      this.recorder.accept(pcm);
      // Endpoint/max-duration may accept only part of the last microphone frame.
      this.sendLive(pcm.subarray(0, this.recorder.length - previousLength));
      if (this.recorder.complete) void this.finish();
      return true;
    }
    if (this.state !== 'waiting') return false;
    this.ring.push(pcm);
    this.waitingSamples += pcm.length;
    const level = rms(pcm);
    if (level < voiceThreshold(this.noiseFloor)) {
      this.noiseFloor = Math.max(0.001, Math.min(0.012, this.noiseFloor * 0.95 + level * 0.05));
    }
    if (!this.wake || this.config.manual) return true;
    const joined = new Int16Array(this.wakeTail.length + pcm.length);
    joined.set(this.wakeTail);
    joined.set(pcm, this.wakeTail.length);
    let offset = 0;
    for (; offset + WAKE_FRAME_SAMPLES <= joined.length; offset += WAKE_FRAME_SAMPLES) {
      if (this.wakeFrames.length === MAX_PENDING_WAKE_FRAMES) this.wakeFrames.shift();
      this.wakeFrames.push({ pcm: joined.slice(offset, offset + WAKE_FRAME_SAMPLES),
        endSample: this.waitingSamples - joined.length + offset + WAKE_FRAME_SAMPLES });
    }
    this.wakeTail = joined.slice(offset);
    this.drainWake();
    return true;
  }

  drainWake() {
    if (this.inference || !this.wake) return;
    const generation = this.generation;
    const detector = this.wake;
    const inference = (async () => {
      while (this.running && this.state === 'waiting' && generation === this.generation && this.wakeFrames.length) {
        const frame = this.wakeFrames.shift();
        const result = await detector.accept(frame.pcm);
        if (generation !== this.generation || this.state !== 'waiting') return;
        if (result?.triggered === true) {
          // A hung detector must not launch a command whose beginning has been lost.
          if (this.waitingSamples - frame.endSample > this.ring.length) continue;
          this.activate({ source: 'wake', detectedThroughSample: frame.endSample });
          return;
        }
      }
    })().catch(async () => {
      if (generation === this.generation) {
        this.clearWaiting();
        await this.notice('WAKE_INFERENCE_FAILED', 'Ошибка локального распознавания имени.');
        if (generation === this.generation) this.status('error', 'Ошибка локального распознавания имени.', { code: 'WAKE_INFERENCE_FAILED' });
      }
    });
    this.inference = inference;
    inference.finally(() => {
      if (this.inference === inference) {
        this.inference = null;
        if (generation === this.generation && this.state === 'waiting' && this.wakeFrames.length) this.drainWake();
      }
    }).catch(() => {});
  }

  async finish() {
    if (!this.running || this.state !== 'recording' || !this.recorder) return false;
    const generation = this.generation;
    const recorder = this.recorder;
    this.recorder = null;
    const live = this.live;
    const endpointAt = this.now();
    const metadata = recorder.end();
    const pcm = recorder.take();
    if (!pcm) {
      this.closeLive(live);
      await this.notice('NO_SPEECH', 'Речь не обнаружена.', metadata);
      await this.resume(generation);
      return false;
    }
    const signal = this.abort.signal;
    const settings = { ...this.config, ...(this.getSettings() ?? {}) };
    const autoExecute = settings.voiceAutoExecute ?? settings.autoExecute ?? true;
    if (settings.cloudEnabled === false) {
      this.closeLive(live);
      pcm.fill(0);
      await this.notice('CLOUD_DISABLED', 'Облачное распознавание выключено в настройках.', metadata);
      if (generation === this.generation) this.status('error', 'Облачное распознавание выключено в настройках.', { code: 'CLOUD_DISABLED', ...metadata });
      return false;
    }
    this.activePcm = pcm;
    this.status('transcribing', live ? 'Завершаю распознавание команды.' : 'Распознаю записанную команду.', metadata);
    try {
      if (generation !== this.generation || signal.aborted) return false;
      let result;
      if (this.utteranceMode === 'live') {
        if (!live) throw Object.assign(new Error(), { code: 'LIVE_TRANSCRIPTION_UNAVAILABLE' });
        this.emit({ type: 'stream_status', state: 'finalizing' });
        await live.ready;
        if (generation !== this.generation || signal.aborted) return false;
        if (live.error) throw live.error;
        result = await live.stream.finish();
        if (generation !== this.generation || signal.aborted) return false;
        this.emit({ type: 'transcription_metrics', mode: 'live', model: result?.model,
          latencyMs: result?.latencyMs, providerReadyMs: live.providerReadyMs ?? null,
          firstPartialMs: live.firstPartialMs, endToFinalMs: Math.max(0, Math.round(this.now() - endpointAt)),
          totalMs: Math.max(0, Math.round(this.now() - live.startedAt)), bytes: live.sentSamples * 2 });
        this.closeLive(live);
      } else {
        const mp3 = await this.encodeMp3(pcm, { signal, sampleRate: 16000 });
        if (generation !== this.generation || signal.aborted) return false;
        result = await this.transcribe(mp3, { signal });
      }
      if (generation !== this.generation || signal.aborted) return false;
      const text = stripWakePrefix(typeof result === 'string' ? result : result?.text ?? result?.transcript);
      if (!text || text.length > 1024) {
        await this.notice(!text ? 'EMPTY_TRANSCRIPT' : 'TRANSCRIPT_TOO_LONG',
          !text ? 'Команда не распознана.' : 'Команда слишком длинная. Максимум 1024 символа.', metadata);
        await this.resume(generation);
        return false;
      }
      this.emit({ type: 'transcript', text, final: true, autoExecute, ...metadata });
      if (generation !== this.generation || signal.aborted) return false;
      this.status('ready', autoExecute ? 'Команда распознана. Выполняю.' : 'Команда готова к проверке.',
        { text, autoExecute, ...metadata });
      if (generation !== this.generation || signal.aborted) return false;
      // Root may include execution and TTS in this promise. Waiting resumes only afterwards.
      await this.onTranscript(text, { signal, autoExecute, ...metadata });
      if (generation !== this.generation || signal.aborted) return false;
      if (!autoExecute) {
        // Review is deliberate user input time: release capture and the wake
        // detector so a second utterance cannot replace the text being edited.
        await this.stop({ message: 'Проверьте текст и нажмите «Выполнить». Микрофон выключен.',
          metadata: { review: true, autoExecute: false } });
        return true;
      }
      await this.resume(generation);
      return true;
    } catch (error) {
      if (generation === this.generation && !signal.aborted) {
        const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'VOICE_PROCESSING_FAILED';
        await this.notice(code, 'Не удалось обработать голосовую команду.', metadata);
        if (generation === this.generation) this.status('error', 'Не удалось обработать голосовую команду.', { code, ...metadata });
      }
      return false;
    } finally {
      this.closeLive(live);
      pcm.fill(0);
      if (this.activePcm === pcm) this.activePcm = null;
    }
  }

  async resume(generation) {
    if (this.inference) await this.inference;
    if (generation !== this.generation || !this.running) return;
    this.clearWaiting();
    try { this.wake?.reset(); }
    catch {
      await this.notice('WAKE_RESET_FAILED', 'Не удалось перезапустить распознавание имени.');
      if (generation === this.generation) this.status('error', 'Не удалось перезапустить распознавание имени.', { code: 'WAKE_RESET_FAILED' });
      return;
    }
    this.status('waiting', this.config.manual ? 'Готов к записи команды.' : 'Ожидаю имя Jarvis.');
  }
}
