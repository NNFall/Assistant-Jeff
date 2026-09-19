"""Download public models only; never capture or transmit microphone audio."""
import hashlib
import json
import os
from pathlib import Path

os.environ.setdefault('HF_HUB_DISABLE_XET', '1')

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / 'models'
WAKE_FILES = {
    'melspectrogram.onnx': 'v0.5.1',
    'embedding_model.onnx': 'v0.5.1',
    'hey_jarvis_v0.1.onnx': 'v0.5.1',
    'alexa_v0.1.onnx': 'v0.5.1',
    'hey_mycroft_v0.1.onnx': 'v0.5.1',
    'hey_rhasspy_v0.1.onnx': 'v0.5.1',
}


def main():
    import requests
    from huggingface_hub import snapshot_download

    MODEL_DIR.mkdir(exist_ok=True)
    manifest = {}
    for name, release in WAKE_FILES.items():
        url = f'https://github.com/dscripka/openWakeWord/releases/download/{release}/{name}'
        target = MODEL_DIR / name
        if not target.exists():
            print(f'Download {name}', flush=True)
            with requests.get(url, stream=True, timeout=(15, 180)) as response:
                response.raise_for_status()
                partial = target.with_suffix('.partial')
                with partial.open('wb') as handle:
                    for chunk in response.iter_content(1024 * 1024):
                        handle.write(chunk)
                partial.replace(target)
        manifest[name] = {'url': url, 'bytes': target.stat().st_size,
                          'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
    print('Download multilingual Whisper small (CPU INT8 runtime)', flush=True)
    snapshot_download('Systran/faster-whisper-small', local_dir=MODEL_DIR / 'whisper-small',
                      allow_patterns=['config.json', 'model.bin', 'tokenizer.json',
                                      'vocabulary.*', 'preprocessor_config.json'])
    (MODEL_DIR / 'download-manifest.json').write_text(
        json.dumps(manifest, indent=2), encoding='utf-8')
    print('MODELS_READY', flush=True)


if __name__ == '__main__':
    main()
