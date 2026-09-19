"""Local audio pipeline. Raw microphone audio lives in memory only."""
import collections
import os
from pathlib import Path
import queue
import threading
import time

os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ.setdefault('OMP_NUM_THREADS', '2')

ROOT = Path(__file__).resolve().parent
MODELS = ROOT / 'models'
NAMES = {'Hey Jarvis': 'hey_jarvis_v0.1.onnx', 'Alexa': 'alexa_v0.1.onnx',
         'Hey Mycroft': 'hey_mycroft_v0.1.onnx', 'Hey Rhasspy': 'hey_rhasspy_v0.1.onnx'}
RATE = 16000
FRAME = 1280


class Speaker:
    def __init__(self):
        self.voice = None

    def setup(self):
        import win32com.client
        self.voice = win32com.client.Dispatch('SAPI.SpVoice')
        for voice in self.voice.GetVoices():
            if '419' in voice.GetAttribute('Language').lower().split(';'):
                self.voice.Voice = voice
                return True
        return False

    def say(self, text, stop=None):
        if not self.voice or (stop and stop.is_set()):
            return
        self.voice.Speak(text, 1)
        while not self.voice.WaitUntilDone(50):
            if stop and stop.is_set():
                self.voice.Speak('', 3)
                break


class Ducking:
    """Temporarily lower other app sessions, never the master volume."""
    def __init__(self, enabled):
        self.enabled = enabled
        self.volumes = []

    def __enter__(self):
        try:
            if self.enabled:
                from pycaw.pycaw import AudioUtilities
                for session in AudioUtilities.GetAllSessions():
                    try:
                        if session.ProcessId in (0, os.getpid()):
                            continue
                        volume = session.SimpleAudioVolume
                        original = volume.GetMasterVolume()
                        lowered = original * 0.15
                        # Record first: a COM setter can change volume and then fail.
                        self.volumes.append((volume, original, lowered))
                        volume.SetMasterVolume(lowered, None)
                    except Exception:
                        continue
        except BaseException:
            # Context manager exit is not called when enter itself fails.
            self.__exit__()
            raise
        return self

    def __exit__(self, *_):
        for volume, original, lowered in self.volumes:
            try:
                # Respect a volume change the user made while dictating.
                if abs(volume.GetMasterVolume() - lowered) < 0.001:
                    volume.SetMasterVolume(original, None)
            except Exception:
                pass
        self.volumes.clear()


def load_wake(name):
    from openwakeword.model import Model
    return Model(wakeword_models=[str(MODELS / NAMES[name])], inference_framework='onnx',
                 melspec_model_path=str(MODELS / 'melspectrogram.onnx'),
                 embedding_model_path=str(MODELS / 'embedding_model.onnx'))


def load_stt():
    from faster_whisper import WhisperModel
    return WhisperModel(str(MODELS / 'whisper-small'), device='cpu', compute_type='int8',
                        cpu_threads=4, num_workers=1, local_files_only=True)


def transcribe(model, audio):
    segments, _ = model.transcribe(audio, language='ru', beam_size=3,
                                  condition_on_previous_text=False, vad_filter=True)
    return ' '.join(s.text.strip() for s in segments if s.no_speech_prob < 0.65).strip()


class AudioEngine:
    def __init__(self, events, command_service):
        self.events = events
        self.commands = command_service
        self.stop_event = threading.Event()
        self.manual = threading.Event()
        self.thread = None
        self.config = None
        self.stt = None
        self.wake = None
        self.loaded_name = None
        self.output = queue.Queue()
        self._state_lock = threading.RLock()
        self._stream = None

    @property
    def running(self):
        with self._state_lock:
            return self.thread is not None and self.thread.is_alive()

    def start(self, config):
        with self._state_lock:
            if self.running:
                return
            self._clear_output()
            self.config = dict(config)
            self.stop_event.clear()
            self.manual.clear()
            self.thread = threading.Thread(target=self._run, name='voice-audio', daemon=True)
            self.thread.start()

    def stop(self):
        # The callback must see cancellation even while stream creation holds the lock.
        self.stop_event.set()
        with self._state_lock:
            self.stop_event.set()
            self.manual.clear()
            self._clear_output()
            self._close_capture()

    def _clear_output(self):
        while True:
            try:
                self.output.get_nowait()
            except queue.Empty:
                return

    def _close_capture(self):
        with self._state_lock:
            stream, self._stream = self._stream, None
            if stream is None:
                return
            try:
                stream.abort()
            except Exception as exc:
                self.emit('warning', f'Не удалось остановить микрофон: {exc}')
            finally:
                try:
                    stream.close()
                except Exception as exc:
                    self.emit('warning', f'Не удалось закрыть микрофон: {exc}')

    def _open_capture(self, sd, capture):
        with self._state_lock:
            if self.stop_event.is_set():
                return False
            self._stream = sd.RawInputStream(
                samplerate=RATE, blocksize=FRAME, dtype='int16', channels=1,
                device=self.config['device'], callback=capture,
            )
            if self.stop_event.is_set():
                self._close_capture()
                return False
            self._stream.start()
            return True

    def _say(self, speaker, text):
        if self.stop_event.is_set():
            return False
        try:
            speaker.say(text, self.stop_event)
            return True
        except Exception as exc:
            if not self.stop_event.is_set():
                self.emit('warning', f'Не удалось озвучить сообщение: {exc}')
            return False

    def _speak_pending(self, speaker, russian_voice):
        if self.stop_event.is_set():
            return False
        try:
            item = self.output.get_nowait()
        except queue.Empty:
            return False
        if (not isinstance(item, tuple) or len(item) != 2
                or type(item[0]) is not int or item[0] <= 0
                or not isinstance(item[1], str) or not item[1].strip()):
            self.emit('warning', 'Неверный формат напоминания для озвучивания.')
            return False
        if not self.config['tts'] or not russian_voice:
            return False
        id, text = item
        try:
            pending = self.commands.store.pending()
        except Exception as exc:
            self.emit('warning', f'Не удалось проверить напоминание: {exc}')
            return False
        if not any(row['id'] == id for row in pending) or self.stop_event.is_set():
            return False
        self.emit('state', 'Напоминание')
        return self._say(speaker, text)

    def emit(self, kind, value):
        self.events.put((kind, value))

    def _run(self):
        import numpy as np
        import pythoncom
        import sounddevice as sd
        import webrtcvad
        import winsound

        pythoncom.CoInitialize()
        frames = queue.Queue(maxsize=200)
        overflow = threading.Event()

        def capture(indata, count, timing, status):
            if self.stop_event.is_set():
                raise sd.CallbackAbort
            if status:
                overflow.set()
            data = bytes(indata)
            if self.stop_event.is_set():
                raise sd.CallbackAbort
            try:
                frames.put_nowait(data)
            except queue.Full:
                overflow.set()

        def drain():
            while True:
                try:
                    frames.get_nowait()
                except queue.Empty:
                    break
            overflow.clear()

        try:
            if self.stop_event.is_set():
                return
            self.emit('state', 'Загрузка локальных моделей…')
            if self.loaded_name != self.config['wake_name']:
                self.wake = load_wake(self.config['wake_name'])
                self.loaded_name = self.config['wake_name']
            if self.stop_event.is_set():
                return
            if self.stt is None:
                self.stt = load_stt()
            if self.stop_event.is_set():
                return
            speaker = Speaker()
            russian_voice = speaker.setup()
            self.emit('voice', russian_voice)
            vad = webrtcvad.Vad(2)
            if self._open_capture(sd, capture):
                self.wake.reset()
                self.emit('state', 'Ожидание: ' + self.config['wake_name'])
                while not self.stop_event.is_set():
                    if self._speak_pending(speaker, russian_voice):
                        drain()
                        self.wake.reset()
                        self.emit('state', 'Ожидание: ' + self.config['wake_name'])
                    try:
                        data = frames.get(timeout=0.1)
                    except queue.Empty:
                        continue
                    if self.stop_event.is_set():
                        break
                    if overflow.is_set():
                        drain()
                        self.wake.reset()
                        self.emit('warning', 'Переполнение аудиобуфера. Повторите активацию.')
                        continue
                    score = max(self.wake.predict(np.frombuffer(data, dtype=np.int16)).values())
                    self.emit('score', float(score))
                    if score < self.config['threshold'] and not self.manual.is_set():
                        continue
                    self.manual.clear()
                    self.emit('state', 'Говорите после сигнала')
                    with Ducking(self.config['duck']):
                        winsound.Beep(880, 100)
                        drain()
                        recording = self._record(frames, vad, overflow)
                        if self.stop_event.is_set():
                            break
                        if recording:
                            self.emit('state', 'Распознавание на CPU…')
                            start = time.perf_counter()
                            audio = np.frombuffer(recording, dtype=np.int16).astype(np.float32) / 32768
                            text = transcribe(self.stt, audio)
                            if self.stop_event.is_set():
                                break
                            self.emit('transcript', text)
                            self.emit('latency', round(time.perf_counter() - start, 2))
                            result = self.commands.execute(text)
                            self.emit('result', result)
                            if self.config['tts'] and russian_voice:
                                self._say(speaker, result['message'])
                        else:
                            self.emit('warning', 'Команда не записана. Повторите после сигнала.')
                    drain()
                    self.wake.reset()
                    self.emit('state', 'Ожидание: ' + self.config['wake_name'])
        except Exception as exc:
            self.emit('error', f'{type(exc).__name__}: {exc}')
        finally:
            self._close_capture()
            pythoncom.CoUninitialize()
            self.emit('stopped', None)

    def _record(self, frames, vad, overflow):
        before = collections.deque(maxlen=4)
        blocks = []
        elapsed = 0.0
        silence = 0.0
        voiced = 0.0
        while not self.stop_event.is_set() and elapsed < 30:
            try:
                data = frames.get(timeout=0.25)
            except queue.Empty:
                self.emit('warning', 'Нет данных микрофона.')
                return None
            if overflow.is_set():
                self.emit('warning', 'Запись прервана: аудиобуфер переполнен.')
                return None
            elapsed += 0.08
            speech = sum(vad.is_speech(data[i:i + 640], RATE)
                         for i in range(0, len(data), 640)) >= 2
            if speech:
                if not blocks:
                    blocks.extend(before)
                voiced += 0.08
                silence = 0
            elif blocks:
                silence += 0.08
            if blocks or speech:
                blocks.append(data)
            else:
                before.append(data)
            if voiced >= 0.24 and silence >= 1.2:
                return b''.join(blocks)
            if not blocks and elapsed >= 8:
                return None
        if elapsed >= 30:
            self.emit('warning', 'Команда длиннее 30 секунд: не выполнена, чтобы не обрезать смысл.')
        return None
