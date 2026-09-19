"""Brief real-microphone lifecycle test against a temporary, not user, database."""
from pathlib import Path
import queue
import tempfile
import time

from audio_engine import AudioEngine
from core import Store, CommandService


def main():
    with tempfile.TemporaryDirectory(prefix='jarvis-lifecycle-') as tmp:
        events = queue.Queue()
        engine = AudioEngine(events, CommandService(Store(Path(tmp) / 'test.sqlite')))
        engine.start({'wake_name': 'Hey Jarvis', 'threshold': 0.95, 'device': None,
                      'duck': False, 'tts': False})
        deadline = time.monotonic() + 90
        ready = False
        ready_at = None
        errors = []
        try:
            while time.monotonic() < deadline:
                try:
                    kind, value = events.get(timeout=0.2)
                except queue.Empty:
                    if not engine.running:
                        break
                    continue
                if kind == 'error':
                    errors.append(value)
                    break
                if kind == 'state' and value.startswith('Ожидание'):
                    ready = True
                    ready_at = time.monotonic()
                if ready and time.monotonic() - ready_at > 3:
                    break
        finally:
            engine.stop()
            engine.thread.join(timeout=30)
        assert ready, f'Audio engine did not become ready: {errors}'
        assert not engine.running, 'Audio engine failed to stop'
        assert not errors, errors
        print('LIVE_MIC_START_STOP_OK; no audio saved; temporary database only')


if __name__ == '__main__':
    main()
