"""Bounded local checks. Synthesized fixtures only; mic check saves no audio."""
import argparse
import json
from pathlib import Path
import tempfile
import time
import wave

import numpy as np
import psutil
from scipy.signal import resample_poly

from audio_engine import NAMES, RATE, FRAME, load_wake, load_stt, transcribe
from core import Store, CommandService

ROOT = Path(__file__).resolve().parent


def synthesize(text, language, path):
    import win32com.client
    voice = win32com.client.Dispatch('SAPI.SpVoice')
    voices = [v for v in voice.GetVoices() if language in v.GetAttribute('Language').split(';')]
    if not voices:
        raise RuntimeError('Missing SAPI voice: ' + language)
    voice.Voice = voices[0]
    stream = win32com.client.Dispatch('SAPI.SpFileStream')
    stream.Format.Type = 22
    stream.Open(str(path), 3)
    try:
        voice.AudioOutputStream = stream
        voice.Speak(text)
    finally:
        stream.Close()
    with wave.open(str(path), 'rb') as wav:
        rate = wav.getframerate()
        assert wav.getsampwidth() == 2 and wav.getnchannels() == 1
        audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32)
    import math
    factor = math.gcd(rate, RATE)
    audio = resample_poly(audio, RATE // factor, rate // factor)
    return np.clip(audio, -32768, 32767).astype(np.int16)


def run(mic=False):
    import sounddevice as sd
    report = {'time': time.strftime('%Y-%m-%d %H:%M:%S'), 'wake': {}, 'stt': []}
    process = psutil.Process()
    with tempfile.TemporaryDirectory(prefix='jarvis-check-') as tmp:
        tmp = Path(tmp)
        for name in NAMES:
            model = load_wake(name)
            clip = synthesize(name, '409', tmp / 'wake.wav')
            clip = np.concatenate([np.zeros(RATE, dtype=np.int16), clip, np.zeros(RATE, dtype=np.int16)])
            started = time.perf_counter()
            scores = [float(max(model.predict(clip[i:i + FRAME]).values()))
                      for i in range(0, len(clip) - FRAME, FRAME)]
            report['wake'][name] = {'synthetic_peak': max(scores), 'threshold_pass': max(scores) >= 0.5,
                                    'elapsed_seconds': round(time.perf_counter() - started, 3)}
        model = load_wake('Hey Jarvis')
        started = time.perf_counter()
        for _ in range(100):
            model.predict(np.zeros(FRAME, dtype=np.int16))
        report['wake_8seconds_compute_seconds'] = round(time.perf_counter() - started, 3)
        started = time.perf_counter()
        stt = load_stt()
        report['stt_load_seconds'] = round(time.perf_counter() - started, 3)
        service = CommandService(Store(tmp / 'test.sqlite'))
        for source in ['Запиши заметку: купить молоко и хлеб.', 'Поставь таймер на две минуты.',
                       'Напомни через десять минут проверить чай.']:
            clip = synthesize(source, '419', tmp / 'command.wav')
            started = time.perf_counter()
            text = transcribe(stt, clip.astype(np.float32) / 32768)
            elapsed = time.perf_counter() - started
            report['stt'].append({'source': source, 'transcript': text,
                                  'elapsed_seconds': round(elapsed, 3), 'result': service.execute(text)})
        report['rss_mib'] = round(process.memory_info().rss / 1024**2, 1)
        if mic:
            sd.check_input_settings(channels=1, dtype='int16', samplerate=RATE)
            started = time.perf_counter()
            with sd.RawInputStream(samplerate=RATE, blocksize=FRAME, channels=1, dtype='int16') as stream:
                peaks = []
                for _ in range(25):
                    block, overflow = stream.read(FRAME)
                    peaks.append(int(np.max(np.abs(np.frombuffer(block, dtype=np.int16).astype(np.int32)))))
            report['microphone'] = {'device': sd.query_devices(kind='input')['name'],
                                    'seconds': round(time.perf_counter() - started, 2),
                                    'peak': max(peaks), 'audio_saved': False, 'transcribed': False}
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--mic', action='store_true')
    args = parser.parse_args()
    result = run(args.mic)
    (ROOT / 'data').mkdir(exist_ok=True)
    (ROOT / 'data/diagnostics.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=True, indent=2))
