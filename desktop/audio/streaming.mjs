/** One utterance per connection. Audio is mono PCM16LE at 16 kHz.
 * Russian uses legacy whisper-rt, verified with synthetic speech on 2026-09-19.
 * Universal-3.5 Pro accepted Russian steering but failed that transcription check.
 */
export class AssemblyStream {
  constructor({ apiKey, model = 'whisper-rt', languageCodes = ['ru'],
    onTranscript = () => {}, onError = () => {},
    endpoint = 'wss://streaming.assemblyai.com/v3/ws', createSocket,
    connectTimeoutMs = 15_000, maxSessionMs = 30_000 } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.languageCodes = languageCodes;
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.endpoint = endpoint;
    this.createSocket = createSocket;
    this.connectTimeoutMs = Math.min(15_000, connectTimeoutMs);
    this.maxSessionMs = Math.min(30_000, maxSessionMs);
    this.state = 'idle';
    this.queue = [];
    this.queuedBytes = 0;
    this.finalEmitted = false;
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.state !== 'idle') return Promise.reject(new Error('Поток уже закрыт.'));
    this.state = 'connecting';
    this.startPromise = new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    this.connectTimer = setTimeout(() => this.fail('Не удалось подключиться к распознаванию речи за 15 секунд.'), this.connectTimeoutMs);
    this.sessionTimer = setTimeout(() => this.fail('Время голосовой команды истекло.'), this.maxSessionMs);
    this.openSocket();
    return this.startPromise;
  }

  async openSocket() {
    try {
      const url = new URL(this.endpoint);
      if (url.protocol !== 'wss:' || url.username || url.password) throw new Error('endpoint');
      if (!this.apiKey) throw new Error('key');
      url.searchParams.set('sample_rate', '16000');
      url.searchParams.set('encoding', 'pcm_s16le');
      url.searchParams.set('speech_model', this.model);
      if (this.model === 'whisper-rt') url.searchParams.delete('language_codes');
      else url.searchParams.set('language_codes', JSON.stringify(this.languageCodes));
      const factory = this.createSocket ?? ((await import('ws')).default);
      if (this.state !== 'connecting') return;
      this.socket = this.createSocket
        ? factory(url.toString(), { headers: { Authorization: this.apiKey } })
        : new factory(url.toString(), { headers: { Authorization: this.apiKey } });
      this.socket.on('message', data => this.handleMessage(data));
      this.socket.on('error', () => this.fail('Ошибка соединения с распознаванием речи.'));
      this.socket.on('close', () => {
        if (this.state !== 'closed') this.fail('Соединение с распознаванием речи закрыто до получения результата.');
      });
    } catch {
      this.fail('Не удалось открыть защищённое соединение с распознаванием речи.');
    }
  }

  handleMessage(data) {
    if (this.state === 'closed') return;
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.type === 'Begin' && this.state === 'connecting') {
      clearTimeout(this.connectTimer);
      this.state = 'listening';
      this.resolveStart?.();
      this.resolveStart = this.rejectStart = undefined;
      const queued = this.queue;
      this.queue = [];
      this.queuedBytes = 0;
      for (const frame of queued) if (!this.write(frame)) return;
      if (this.finishRequested) this.finish();
    } else if (message.type === 'Turn' && this.state === 'listening' && !this.finalEmitted) {
      if (typeof message.transcript !== 'string') return;
      const text = message.transcript.trim();
      if (message.end_of_turn === true) {
        this.finalEmitted = true;
        try { this.onTranscript({ text, final: true }); } finally { this.close(); }
      } else if (text && text !== this.lastPartial) {
        this.lastPartial = text;
        this.onTranscript({ text, final: false });
      }
    } else if (message.type === 'Error') {
      this.fail('Сервис распознавания отклонил запрос. Проверьте ключ, модель и язык.');
    } else if (message.type === 'Termination') {
      this.fail('Распознавание завершилось без окончательного текста.');
    }
  }

  send(audio) {
    if (this.state !== 'connecting' && this.state !== 'listening') return false;
    if (this.finishRequested) return false;
    let frame;
    if (Buffer.isBuffer(audio)) frame = Buffer.from(audio);
    else if (audio instanceof Int16Array) {
      frame = Buffer.alloc(audio.length * 2);
      for (let i = 0; i < audio.length; i++) frame.writeInt16LE(audio[i], i * 2);
    } else throw new TypeError('Expected PCM Buffer or Int16Array.');
    if (frame.length % 2) throw new TypeError('PCM16 frames must contain complete samples.');
    if (!frame.length) return true;
    // Two seconds of mono PCM16 at 16 kHz, never an unbounded audio backlog.
    if (this.state === 'connecting') {
      if (this.queuedBytes + frame.length > 64_000) return false;
      this.queue.push(frame);
      this.queuedBytes += frame.length;
      return true;
    }
    // Keep each message below the provider's 128 KiB limit.
    for (let offset = 0; offset < frame.length; offset += 32_000) {
      if (!this.write(frame.subarray(offset, offset + 32_000))) return false;
    }
    return true;
  }

  write(data) {
    if (!this.socket || this.socket.readyState !== 1) {
      this.fail('Соединение для передачи голоса недоступно.');
      return false;
    }
    if (this.socket.bufferedAmount > 64_000) {
      this.fail('Соединение слишком медленное для передачи голоса.');
      return false;
    }
    try { this.socket.send(data); return true; } catch {
      this.fail('Не удалось передать голосовую команду.');
      return false;
    }
  }

  finish() {
    if (this.state === 'closed') return;
    this.finishRequested = true;
    if (this.state === 'listening' && !this.endpointSent) {
      this.endpointSent = true;
      this.write(JSON.stringify({ type: 'ForceEndpoint' }));
    }
  }

  fail(message) {
    if (this.state === 'closed') return;
    this.close(message);
    this.onError(message);
  }

  close(reason = 'Распознавание остановлено.') {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this.connectTimer);
    clearTimeout(this.sessionTimer);
    this.queue = [];
    this.queuedBytes = 0;
    this.rejectStart?.(new Error(reason));
    this.resolveStart = this.rejectStart = undefined;
    if (this.socket) {
      try {
        if (this.socket.readyState === 1) {
          this.socket.send(JSON.stringify({ type: 'Terminate' }));
          this.socket.close();
        } else if (this.socket.readyState === 0) this.socket.terminate();
      } catch { /* Shutdown is best effort; never log provider messages or keys. */ }
    }
  }
}
