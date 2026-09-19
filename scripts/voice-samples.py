"""Generate local Piper listening samples. No microphone, API, or auto playback.

Run with the isolated work/tts/venv interpreter after installing piper-tts==1.8.0.
Model downloads must already exist in data/tts/piper. Output directory is explicit.
"""
import argparse
import hashlib
import json
import math
import struct
import time
import wave
from pathlib import Path

TEXT = ('Привет! Я Джефф, твой личный помощник. Поставь будильник на 23:30, '
        'открой Chrome и сохрани заметку: завтра нужно купить молоко, проверить почту '
        'и закончить небольшой проект. Хорошо, давай спокойно разберёмся по порядку. '
        'Сегодня можно немного отдохнуть, а потом вернуться к делам. '
        'Если я что-то не расслышал, просто повтори фразу. '
        'Мне важно говорить понятно, без спешки и лишних слов. '
        'Как тебе этот голос? Удобно ли слушать длинные ответы и короткие напоминания?')


def inspect_audio(file):
    with wave.open(str(file), 'rb') as audio:
        frames, rate, width, channels = audio.getnframes(), audio.getframerate(), audio.getsampwidth(), audio.getnchannels()
        raw = audio.readframes(frames)
    assert width == 2 and frames > 0, 'Expected nonempty PCM16 audio'
    samples = struct.unpack(f'<{len(raw)//2}h', raw)
    peak = max(abs(x) for x in samples)
    rms = math.sqrt(sum(x*x for x in samples) / len(samples))
    assert peak > 100 and rms > 10, 'Audio is empty or effectively silent'
    return dict(duration_seconds=round(frames/rate, 3), sample_rate=rate, channels=channels,
                bytes=file.stat().st_size, peak=peak, rms=round(rms, 2),
                sha256=hashlib.sha256(file.read_bytes()).hexdigest())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    from piper import PiperVoice
    root = Path(__file__).resolve().parents[1]
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out/'sample-text.txt').write_text(TEXT+'\n', encoding='utf-8')
    metrics = []
    for name in ('denis', 'dmitri'):
        model = root/'data'/'tts'/'piper'/f'ru_RU-{name}-medium.onnx'
        started = time.perf_counter()
        voice = PiperVoice.load(str(model), use_cuda=False)
        loaded = time.perf_counter()
        dest = args.out/f'piper-{name}.wav'
        with wave.open(str(dest), 'wb') as wav:
            voice.synthesize_wav(TEXT, wav)
        ended = time.perf_counter()
        item = dict(voice=name, model_bytes=model.stat().st_size,
                    model_load_seconds=round(loaded-started, 3),
                    synthesis_seconds=round(ended-loaded, 3), **inspect_audio(dest))
        item['realtime_factor'] = round(item['synthesis_seconds']/item['duration_seconds'], 3)
        metrics.append(item)
        print(json.dumps(item, ensure_ascii=False), flush=True)
        del voice
    (args.out/'piper-metrics.json').write_text(json.dumps(metrics, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')


if __name__ == '__main__':
    main()
