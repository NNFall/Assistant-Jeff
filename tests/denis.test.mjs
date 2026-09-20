import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DenisVoice, pcmToWav} from '../desktop/audio/denis.mjs';

async function fixture(t, {config = {audio: {sample_rate: 22050}}, behavior} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jeff-denis-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const executablePath = path.join(directory, 'piper.exe');
  const modelPath = path.join(directory, 'denis.onnx');
  await Promise.all([writeFile(executablePath, ''), writeFile(modelPath, ''), writeFile(`${modelPath}.json`, JSON.stringify(config))]);
  const calls = [];
  const spawnImpl = (exe, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = 0; child.kill = () => { child.kills++; queueMicrotask(() => child.emit('close', null)); };
    child.text = '';
    child.stdin = new Writable({write(chunk, encoding, callback) { child.text += chunk.toString('utf8'); callback(); }});
    child.stdin.once('finish', () => queueMicrotask(() => {
      if (behavior) behavior(child);
      else { child.stdout.write(Buffer.from([1, 0, 2, 0])); child.emit('close', 0); }
    }));
    calls.push({exe, args, options, child});
    return child;
  };
  return {executablePath, modelPath, spawnImpl, calls};
}

test('Denis sends UTF-8 phrase via stdin to fixed native flags and returns PCM WAV', async t => {
  const setup = await fixture(t);
  const result = await new DenisVoice(setup).synthesize('  Готово.\nВыполнено! $(not-a-shell)  ');
  assert.equal(setup.calls.length, 1);
  const {exe, args, options, child} = setup.calls[0];
  assert.equal(exe, setup.executablePath);
  assert.deepEqual(args, ['--model', setup.modelPath, '--config', `${setup.modelPath}.json`, '--output_raw', '--quiet']);
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.equal(child.text, 'Готово. Выполнено! $(not-a-shell)\n');
  assert.equal(result.wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(result.wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(result.wav.readUInt32LE(24), 22050);
  assert.equal(result.wav.readUInt32LE(40), 4);
  assert.deepEqual(result.wav.subarray(44), Buffer.from([1, 0, 2, 0]));
  assert.equal(result.mimeType, 'audio/wav'); assert.equal(result.voice, 'Денис');
});

test('Denis rejects empty, oversized or control-character text before spawning', async t => {
  const setup = await fixture(t), voice = new DenisVoice(setup);
  for (const text of ['', ' ', null, 'a'.repeat(2001), 'hi\0there']) {
    await assert.rejects(voice.synthesize(text), {code: 'DENIS_TEXT_INVALID'});
  }
  assert.equal(setup.calls.length, 0);
});

test('Denis reports missing runtime and rejects invalid model metadata', async t => {
  const setup = await fixture(t, {config: {audio: {sample_rate: 0}}});
  await assert.rejects(new DenisVoice(setup).synthesize('Тест'), {code: 'DENIS_MODEL_CONFIG'});
  assert.equal(setup.calls.length, 0);
  await rm(setup.executablePath);
  const voice = new DenisVoice(setup);
  assert.equal((await voice.status()).available, false);
  await assert.rejects(voice.synthesize('Тест'), {code: 'DENIS_NOT_INSTALLED'});
});

test('cancellation kills only the directly spawned synthesis and permits a later call', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const setup = await fixture(t, {behavior: child => started(child)});
  const voice = new DenisVoice(setup), abort = new AbortController();
  const pending = voice.synthesize('Тест', {signal: abort.signal});
  const checked = assert.rejects(pending, {code: 'DENIS_ABORTED'});
  const child = await ready;
  await assert.rejects(voice.synthesize('Ещё'), {code: 'DENIS_BUSY'});
  abort.abort(); await checked;
  assert.equal(child.kills, 1); assert.equal(voice.busy, false);
  await assert.rejects(voice.synthesize('Снова', {signal: abort.signal}), {code: 'DENIS_ABORTED'});
  assert.equal(setup.calls.length, 1);
});

test('native audio output is bounded and incomplete sample data is rejected', async t => {
  const limited = await fixture(t, {behavior: child => child.stdout.write(Buffer.alloc(20))});
  await assert.rejects(new DenisVoice({...limited, maxAudioBytes: 10}).synthesize('Тест'), {code: 'DENIS_AUDIO_LIMIT'});
  assert.equal(limited.calls[0].child.kills, 1);
  const odd = await fixture(t, {behavior: child => { child.stdout.write(Buffer.alloc(3)); child.emit('close', 0); }});
  await assert.rejects(new DenisVoice(odd).synthesize('Тест'), {code: 'DENIS_AUDIO_INVALID'});
});

test('native synthesis timeout and nonzero exit expose only stable error codes', async t => {
  const hanging = await fixture(t, {behavior: () => {}});
  await assert.rejects(new DenisVoice({...hanging, timeoutMs: 5}).synthesize('Тест'), {code: 'DENIS_TIMEOUT'});
  assert.equal(hanging.calls[0].child.kills, 1);
  const failed = await fixture(t, {behavior: child => { child.stderr.write('private path or phrase'); child.emit('close', 2); }});
  await assert.rejects(new DenisVoice(failed).synthesize('Тест'), error => error.code === 'DENIS_SYNTHESIS_FAILED' && !error.message.includes('private'));
});

test('WAV header lengths and duration use mono signed 16-bit samples', () => {
  const wav = pcmToWav(Buffer.alloc(44100), 22050);
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt16LE(20), 1); assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  for (const [bytes, rate] of [[0, 22050], [3, 22050], [4, 1], [4, 48001]]) {
    assert.throws(() => pcmToWav(Buffer.alloc(bytes), rate), {code: 'DENIS_AUDIO_INVALID'});
  }
});
