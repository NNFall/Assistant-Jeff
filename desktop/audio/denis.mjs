import {spawn} from 'node:child_process';
import {access, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const MAX_TEXT_LENGTH = 2000;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

function voiceError(code) {
  return Object.assign(new Error(code), {code});
}

export function pcmToWav(pcm, sampleRate) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > MAX_AUDIO_BYTES ||
      !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
    throw voiceError('DENIS_AUDIO_INVALID');
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

/** Local-only Piper. The caller chooses truthful status text and decides whether to play audio. */
export class DenisVoice {
  constructor({
    executablePath = path.join(repositoryRoot, 'work/voice-runtime/piper/piper.exe'),
    modelPath = path.join(repositoryRoot, 'data/tts/piper/ru_RU-denis-medium.onnx'),
    configPath = `${modelPath}.json`,
    spawnImpl = spawn,
    timeoutMs = 60000,
    maxAudioBytes = MAX_AUDIO_BYTES,
  } = {}) {
    this.executablePath = path.resolve(executablePath);
    this.modelPath = path.resolve(modelPath);
    this.configPath = path.resolve(configPath);
    this.spawnImpl = spawnImpl;
    this.timeoutMs = Math.min(120000, Math.max(1, timeoutMs));
    this.maxAudioBytes = Math.min(MAX_AUDIO_BYTES, Math.max(2, maxAudioBytes));
    this.busy = false;
  }

  async status() {
    try {
      await Promise.all([this.executablePath, this.modelPath, this.configPath].map(file => access(file)));
      return {available: true, voice: 'Денис', engine: 'piper-native', busy: this.busy};
    } catch {
      return {available: false, voice: 'Денис', engine: 'piper-native', busy: this.busy, code: 'DENIS_NOT_INSTALLED'};
    }
  }

  async synthesize(text, {signal} = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
      throw voiceError('DENIS_TEXT_INVALID');
    }
    if (signal?.aborted) throw voiceError('DENIS_ABORTED');
    if (this.busy) throw voiceError('DENIS_BUSY');
    this.busy = true;
    try {
      if (!(await this.status()).available) throw voiceError('DENIS_NOT_INSTALLED');
      const configSize = (await stat(this.configPath)).size;
      if (configSize > 256 * 1024) throw voiceError('DENIS_MODEL_CONFIG');
      let sampleRate;
      try { sampleRate = JSON.parse(await readFile(this.configPath, 'utf8')).audio.sample_rate; }
      catch { throw voiceError('DENIS_MODEL_CONFIG'); }
      if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw voiceError('DENIS_MODEL_CONFIG');
      if (signal?.aborted) throw voiceError('DENIS_ABORTED');
      const pcm = await this.#generate(text.trim().replace(/\s+/gu, ' '), signal);
      if (signal?.aborted) throw voiceError('DENIS_ABORTED');
      return {wav: pcmToWav(pcm, sampleRate), mimeType: 'audio/wav', sampleRate, channels: 1,
        durationMs: Math.round(pcm.length / (sampleRate * 2) * 1000), voice: 'Денис'};
    } finally { this.busy = false; }
  }

  #generate(text, signal) {
    return new Promise((resolve, reject) => {
      let child, timer, settled = false, total = 0, diagnosticBytes = 0;
      const chunks = [];
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) {
          // Kill only this directly spawned synthesis process. Never a process name or process tree.
          try { child?.kill(); } catch {}
          chunks.length = 0;
          reject(error);
        } else resolve(result);
      };
      const abort = () => finish(voiceError('DENIS_ABORTED'));
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) { abort(); return; }
      try {
        child = this.spawnImpl(this.executablePath, [
          '--model', this.modelPath, '--config', this.configPath, '--output_raw', '--quiet',
        ], {cwd: path.dirname(this.executablePath), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
      } catch { finish(voiceError('DENIS_START_FAILED')); return; }
      child.once('error', () => finish(voiceError('DENIS_START_FAILED')));
      child.stdout.on('data', chunk => {
        if (settled) return;
        total += chunk.length;
        if (total > this.maxAudioBytes) { finish(voiceError('DENIS_AUDIO_LIMIT')); return; }
        chunks.push(Buffer.from(chunk));
      });
      // Consume diagnostics without retaining text, model paths or the phrase being synthesized.
      child.stderr.on('data', chunk => {
        diagnosticBytes += chunk.length;
        if (diagnosticBytes > 256 * 1024) finish(voiceError('DENIS_DIAGNOSTIC_LIMIT'));
      });
      child.stdin.on('error', () => finish(voiceError('DENIS_INPUT_FAILED')));
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) finish(voiceError('DENIS_SYNTHESIS_FAILED'));
        else if (!total || total % 2) finish(voiceError('DENIS_AUDIO_INVALID'));
        else finish(null, Buffer.concat(chunks, total));
      });
      timer = setTimeout(() => finish(voiceError('DENIS_TIMEOUT')), this.timeoutMs);
      try { child.stdin.end(`${text}\n`, 'utf8'); }
      catch { finish(voiceError('DENIS_INPUT_FAILED')); }
    });
  }
}
