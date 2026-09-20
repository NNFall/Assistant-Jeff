import { Microphone } from '../../desktop/renderer/audio.js';

const BUSY_STATES = new Set(['loading', 'recording', 'transcribing', 'ready', 'processing', 'speaking']);
const OFF_STATES = new Set(['off', 'idle', 'stopped', 'error']);
const defaults = { activationBeep: true, denisReply: true, voiceAutoExecute: true };

function checked(result) {
  if (result?.ok === false || result?.error) {
    const error = new Error(result?.message || result?.error || 'Не удалось выполнить голосовую операцию.');
    error.code = result?.error ?? result?.code;
    throw error;
  }
  return result ?? {};
}

/** Owns local capture and playback. Inference and command execution remain in main. */
export class VoiceClient {
  constructor(api, { onState = () => {}, onEvent = () => {}, onError = () => {}, MicrophoneClass = Microphone, createAudio = url => new Audio(url), createUrl = blob => URL.createObjectURL(blob), revokeUrl = url => URL.revokeObjectURL(url) } = {}) {
    Object.assign(this, { api, onState, onEvent, onError, createAudio, createUrl, revokeUrl });
    this.settings = { ...defaults }; this.providers = {}; this.state = 'off'; this.silenceMs = 2500;
    this.generation = 0; this.ready = false; this.starting = false; this.enabled = false; this.acceptEvents = false; this.playback = null;
    this.typedOperation = null; this.voiceOperation = null; this.cancelledTyped = new Set();
    this.microphone = new MicrophoneClass(chunk => {
      if (!this.enabled) return;
      try { this.api.audioChunk(chunk); } catch (error) { void this.fail(error); }
    });
    this.microphone.onEnded = () => { if (this.enabled) void this.fail(new Error('Микрофон отключён или недоступен.')); };
    this.unsubscribe = api.onVoiceEvent(event => { void this.handleEvent(event).catch(error => this.fail(error)); });
  }
  get busy() { return this.starting || BUSY_STATES.has(this.state); }
  notify(message) {
    if (typeof message === 'string') this.message = message;
    this.onState({ state: this.starting ? 'loading' : this.state, enabled: this.enabled, busy: this.busy, ready: this.ready, settings: { ...this.settings }, providers: { ...this.providers }, silenceMs: this.silenceMs, message: this.message ?? '', review: this.review === true, source: this.eventSource ?? 'voice', operationId: this.typedOperation ?? this.voiceOperation });
  }
  applyStatus(result) {
    for (const key of Object.keys(defaults)) if (typeof result?.settings?.[key] === 'boolean') this.settings[key] = result.settings[key];
    if (result?.providers) this.providers = { ...result.providers };
    if (Number.isFinite(result?.silenceMs)) this.silenceMs = result.silenceMs;
  }
  async initialize() {
    const generation = this.generation;
    try {
      const result = checked(await this.api.voiceStatus());
      if (generation !== this.generation) return;
      this.applyStatus(result);
      // Loading this page never grants microphone capture or resumes an old session.
      if (result.state && !OFF_STATES.has(result.state)) checked(await this.api.voiceStop());
    } catch (error) { this.onError(error); }
    finally { this.ready = true; this.notify(); }
  }
  async start(mode = 'wake') {
    if (!this.ready || this.starting || this.busy) return;
    if (this.enabled) { if (mode === 'manual') await this.activate(); return; }
    const generation = ++this.generation;
    this.eventSource = 'voice'; this.voiceOperation = null; this.review = false; this.message = '';
    this.starting = true; this.enabled = true; this.acceptEvents = true; this.state = 'loading'; this.notify();
    try {
      const result = checked(await this.api.voiceStart({ mode }));
      if (generation !== this.generation) return;
      this.applyStatus(result);
      await this.microphone.start();
      if (generation !== this.generation) { await this.microphone.stop(); return; }
      this.starting = false;
      if (this.state === 'loading') this.state = result.state ?? (mode === 'wake' ? 'waiting' : 'recording');
      if (this.beepPending) { this.beepPending = false; this.beep(); }
      this.notify(result.message);
    } catch (error) { if (generation === this.generation) await this.fail(error); }
  }
  async activate() {
    if (!this.enabled) return this.start('manual');
    if (this.busy) return;
    try { const result = checked(await this.api.voiceActivate()); if (result.state) this.state = result.state; this.notify(result.message); }
    catch (error) { await this.fail(error); }
  }
  async finish() {
    if (this.state !== 'recording' || this.starting) return;
    try { checked(await this.api.voiceFinish()); }
    catch (error) { await this.fail(error); }
  }
  async setSettings(patch) {
    try { const result = checked(await this.api.voiceSettings(patch)); this.applyStatus(result); this.notify(); }
    catch (error) { this.onError(error); this.notify(); }
  }
  async stop() {
    ++this.generation; this.enabled = false; this.acceptEvents = false; this.starting = false; this.state = 'off'; this.beepPending = false;
    this.review = false; this.message = 'Микрофон выключен.';
    if (this.typedOperation) {
      this.cancelledTyped.add(this.typedOperation);
      if (this.cancelledTyped.size > 32) this.cancelledTyped.delete(this.cancelledTyped.values().next().value);
      this.typedOperation = null;
    }
    this.cancelPlayback(); this.notify();
    const results = await Promise.allSettled([this.microphone.stop(), this.api.voiceStop()]);
    for (const result of results) {
      if (result.status === 'rejected') this.onError(result.reason);
      else if (result.value?.ok === false || result.value?.error) this.onError(new Error(result.value.message || result.value.error));
    }
  }
  async fail(error) { await this.stop(); this.onError(error); }
  beep() {
    const context = this.microphone.context;
    if (!context || context.state === 'closed') { this.beepPending = true; return; }
    // The activation cue does not mute or discard the beginning of the command.
    const oscillator = context.createOscillator(), gain = context.createGain(), now = context.currentTime;
    oscillator.type = 'sine'; oscillator.frequency.value = 740;
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(.07, now + .01); gain.gain.exponentialRampToValueAtTime(.001, now + .10);
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start(now); oscillator.stop(now + .12);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }
  acknowledge(id) {
    if (id === undefined) return;
    try { Promise.resolve(this.api.speechEnded({ id })).catch(error => this.onError(error)); }
    catch (error) { this.onError(error); }
  }
  cancelPlayback() {
    const playback = this.playback; this.playback = null;
    if (!playback) return;
    playback.audio.onended = null; playback.audio.onerror = null; playback.audio.pause();
    this.revokeUrl(playback.url); this.acknowledge(playback.id);
  }
  async play(event) {
    if (!this.accepts(event) || !this.settings.denisReply) { this.acknowledge(event.id); return; }
    this.cancelPlayback();
    const bytes = event.wav instanceof Uint8Array ? event.wav : Array.isArray(event.wav) ? new Uint8Array(event.wav) : null;
    if (!bytes?.length) { this.acknowledge(event.id); throw new Error('Не удалось прочитать голосовой ответ.'); }
    let url, audio;
    try {
      url = this.createUrl(new Blob([bytes], { type: event.mimeType || 'audio/wav' }));
      audio = this.createAudio(url);
    } catch (error) { if (url) this.revokeUrl(url); this.acknowledge(event.id); throw error; }
    const playback = { id: event.id, audio, url };
    this.playback = playback;
    const complete = () => { if (this.playback === playback) this.cancelPlayback(); };
    audio.onended = complete;
    audio.onerror = () => { complete(); this.onError(Object.assign(new Error('Не удалось воспроизвести голосовой ответ.'), { code: 'VOICE_PLAYBACK_FAILED' })); };
    try { await audio.play(); }
    catch { if (this.playback === playback) { complete(); this.onError(Object.assign(new Error('Не удалось воспроизвести голосовой ответ.'), { code: 'VOICE_PLAYBACK_FAILED' })); } }
  }
  accepts(event) {
    return event.source === 'typed'
      ? typeof event.operationId === 'string' && event.operationId === this.typedOperation && !this.cancelledTyped.has(event.operationId)
      : this.acceptEvents && (typeof event.operationId !== 'string' || event.operationId === this.voiceOperation);
  }
  async handleEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.source === 'typed' && event.type === 'status' && event.state === 'processing'
        && typeof event.operationId === 'string' && !this.cancelledTyped.has(event.operationId)) { this.typedOperation = event.operationId; this.voiceOperation = null; }
    if (event.source === 'voice' && event.type === 'status' && event.state === 'processing'
        && typeof event.operationId === 'string' && this.acceptEvents) this.voiceOperation = event.operationId;
    if (event.source === 'voice' && event.type === 'status' && event.state === 'recording' && this.acceptEvents) this.voiceOperation = null;
    // Voice cancellation still needs one terminal receipt after Stop. A newer
    // operation supersedes it; typed callers also receive their IPC promise.
    if (event.type === 'result') {
      if (event.source === 'typed' && !this.accepts(event)) return;
      if (event.source === 'voice' && typeof event.operationId === 'string' && event.operationId !== this.voiceOperation) return;
      this.onEvent(event); return;
    }
    if (event.type === 'reminder') { this.onEvent(event); return; }
    if (event.type === 'speech') { await this.play(event); return; }
    if (!this.accepts(event)) return;
    if (event.type === 'status') {
      this.eventSource = event.source ?? 'voice';
      this.review = event.review === true;
      if (typeof event.state === 'string') this.state = event.state;
      this.applyStatus(event);
      if (event.source === 'typed') {
        if (OFF_STATES.has(this.state)) { this.typedOperation = null; this.cancelPlayback(); }
        this.notify(event.message); return;
      }
      // Backend failures already carry a persistent notice. Release capture, but
      // do not send Stop back: a local explanation may still be playing.
      if (this.state === 'error') {
        this.enabled = false; this.starting = false; this.beepPending = false;
        await this.microphone.stop(); this.notify(event.message); return;
      }
      if (OFF_STATES.has(this.state)) {
        ++this.generation; this.enabled = false; this.acceptEvents = false; this.starting = false; this.beepPending = false;
        this.cancelPlayback(); await this.microphone.stop();
      }
      this.notify(event.message);
    } else if (event.type === 'wake') {
      if (this.settings.activationBeep && event.beep !== false) this.beep();
      this.onEvent(event);
    } else if (event.type === 'error') {
      this.enabled = false; this.starting = false; this.state = 'error';
      await this.microphone.stop(); this.notify(event.message);
      this.onEvent({ ...event, type: 'voice_notice', code: event.code ?? event.error ?? 'VOICE_PROCESSING_FAILED' });
    } else this.onEvent(event);
  }
  async dispose() { this.unsubscribe?.(); await this.stop(); }
}
