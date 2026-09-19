import queue
import threading
import unittest
from unittest.mock import MagicMock, PropertyMock, patch

from audio_engine import AudioEngine, Ducking, Speaker


class FakeVad:
    def is_speech(self, data, rate):
        return data[0] == 1


class AudioTests(unittest.TestCase):
    def setUp(self):
        self.audio_utilities = MagicMock()
        self.sd = MagicMock()
        self.sd.CallbackAbort = type('CallbackAbort', (Exception,), {})
        self.modules = {
            'numpy': MagicMock(), 'pythoncom': MagicMock(),
            'sounddevice': self.sd, 'webrtcvad': MagicMock(), 'winsound': MagicMock(),
            'pycaw': MagicMock(), 'pycaw.pycaw': MagicMock(AudioUtilities=self.audio_utilities),
        }
        modules = patch.dict('sys.modules', self.modules)
        modules.start()
        self.addCleanup(modules.stop)
        self.config = {'wake_name': 'Hey Jarvis', 'device': None, 'threshold': 0.5,
                       'tts': True, 'duck': False}

    def make_engine(self):
        engine = AudioEngine(queue.Queue(), MagicMock())
        engine.config = dict(self.config)
        return engine

    def finish_thread(self, engine, release):
        release.set()
        engine.stop()
        engine.thread.join(timeout=3)
        self.assertFalse(engine.running, 'Audio worker did not finish')

    def test_record_until_silence(self):
        engine = AudioEngine(queue.Queue(), None)
        frames = queue.Queue()
        for _ in range(5):
            frames.put(bytes(2560))
        for _ in range(10):
            frames.put(b'\x01' * 2560)
        for _ in range(16):
            frames.put(bytes(2560))
        audio = engine._record(frames, FakeVad(), engine.stop_event)
        self.assertIsNotNone(audio)
        self.assertIn(b'\x01' * 2560, audio)

    def test_silence_is_not_command(self):
        engine = AudioEngine(queue.Queue(), None)
        frames = queue.Queue()
        for _ in range(110):
            frames.put(bytes(2560))
        self.assertIsNone(engine._record(frames, FakeVad(), engine.stop_event))

    def test_cancel_discards_recording(self):
        engine = AudioEngine(queue.Queue(), None)
        engine.stop_event.set()
        self.assertIsNone(engine._record(queue.Queue(), FakeVad(), engine.stop_event))

    def test_long_command_not_truncated_and_executed(self):
        engine = AudioEngine(queue.Queue(), None)
        frames = queue.Queue()
        for _ in range(400):
            frames.put(b'\x01' * 2560)
        self.assertIsNone(engine._record(frames, FakeVad(), engine.stop_event))

    def test_duck_restore_even_on_exception(self):
        from pycaw.pycaw import AudioUtilities
        volume = MagicMock()
        volume.GetMasterVolume.side_effect = [0.8, 0.12]
        session = MagicMock(ProcessId=999999, SimpleAudioVolume=volume)
        with patch.object(AudioUtilities, 'GetAllSessions', return_value=[session]):
            with self.assertRaises(ValueError):
                with Ducking(True):
                    raise ValueError('test')
        self.assertEqual(volume.SetMasterVolume.call_args_list[-1].args, (0.8, None))

    def test_duck_respects_user_volume_change(self):
        from pycaw.pycaw import AudioUtilities
        volume = MagicMock()
        volume.GetMasterVolume.side_effect = [0.8, 0.4]
        session = MagicMock(ProcessId=999999, SimpleAudioVolume=volume)
        with patch.object(AudioUtilities, 'GetAllSessions', return_value=[session]):
            with Ducking(True):
                pass
        self.assertEqual(volume.SetMasterVolume.call_count, 1)

    def test_duck_ignores_session_property_failures_and_restores_earlier_sessions(self):
        for attribute in ('ProcessId', 'SimpleAudioVolume'):
            with self.subTest(attribute=attribute):
                volume = MagicMock()
                volume.GetMasterVolume.side_effect = [0.8, 0.12]
                good = MagicMock(ProcessId=999999, SimpleAudioVolume=volume)
                broken = MagicMock(ProcessId=999998)
                setattr(type(broken), attribute, PropertyMock(side_effect=RuntimeError('session gone')))
                self.audio_utilities.GetAllSessions.return_value = [good, broken]
                with Ducking(True):
                    self.assertEqual(volume.SetMasterVolume.call_count, 1)
                self.assertEqual(volume.SetMasterVolume.call_args_list[-1].args, (0.8, None))

    def test_duck_rolls_back_when_enter_iteration_fails(self):
        volume = MagicMock()
        volume.GetMasterVolume.side_effect = [0.8, 0.12]

        def sessions():
            yield MagicMock(ProcessId=999999, SimpleAudioVolume=volume)
            raise RuntimeError('enumeration failed')

        self.audio_utilities.GetAllSessions.return_value = sessions()
        ducking = Ducking(True)
        with self.assertRaisesRegex(RuntimeError, 'enumeration failed'):
            with ducking:
                self.fail('Context body must not run after enter fails')
        self.assertEqual(volume.SetMasterVolume.call_args_list[-1].args, (0.8, None))
        self.assertEqual(ducking.volumes, [])

    def test_duck_restores_setter_that_changed_volume_before_raising(self):
        volume = MagicMock()
        volume.GetMasterVolume.side_effect = [0.8, 0.12]
        volume.SetMasterVolume.side_effect = [RuntimeError('partial COM failure'), None]
        self.audio_utilities.GetAllSessions.return_value = [
            MagicMock(ProcessId=999999, SimpleAudioVolume=volume),
        ]
        with Ducking(True):
            pass
        self.assertEqual(volume.SetMasterVolume.call_args_list[-1].args, (0.8, None))

    def test_cancel_during_model_loading_never_opens_microphone(self):
        for loader in ('load_wake', 'load_stt'):
            with self.subTest(loader=loader):
                self.sd.reset_mock()
                engine = self.make_engine()
                entered, release = threading.Event(), threading.Event()

                def blocked_load(*args):
                    entered.set()
                    if not release.wait(3):
                        raise RuntimeError('Test timed out')
                    return MagicMock()

                with patch('audio_engine.load_wake'), patch('audio_engine.load_stt'), \
                        patch('audio_engine.Speaker') as speaker, \
                        patch('audio_engine.' + loader, side_effect=blocked_load):
                    engine.start(self.config)
                    try:
                        self.assertTrue(entered.wait(2))
                        engine.stop()
                        self.assertTrue(engine.running)
                        self.sd.RawInputStream.assert_not_called()
                        speaker.assert_not_called()
                    finally:
                        self.finish_thread(engine, release)
                    self.sd.RawInputStream.assert_not_called()
                    engine.commands.execute.assert_not_called()

    def test_cancel_during_stt_closes_microphone_before_cpu_finishes(self):
        engine = self.make_engine()
        entered, release = threading.Event(), threading.Event()
        stream = self.sd.RawInputStream.return_value

        def start_capture():
            callback = self.sd.RawInputStream.call_args.kwargs['callback']
            callback(bytes(2560), 1280, None, None)

        def blocked_transcribe(*args):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('Test timed out')
            return 'заметка не сохранять'

        stream.start.side_effect = start_capture
        wake = MagicMock()
        wake.predict.return_value = {'wake': 1.0}
        with patch('audio_engine.load_wake', return_value=wake), \
                patch('audio_engine.load_stt'), patch('audio_engine.Speaker'), \
                patch.object(engine, '_record', return_value=bytes(2560)), \
                patch('audio_engine.transcribe', side_effect=blocked_transcribe):
            engine.start(self.config)
            try:
                self.assertTrue(entered.wait(2))
                engine.stop()
                self.assertTrue(engine.running, 'CPU inference should still be blocked')
                stream.abort.assert_called_once()
                stream.close.assert_called_once()
                self.assertIsNone(engine._stream)
                indata = MagicMock()
                indata.__bytes__ = MagicMock(return_value=bytes(2560))
                callback = self.sd.RawInputStream.call_args.kwargs['callback']
                with self.assertRaises(self.sd.CallbackAbort):
                    callback(indata, 1280, None, None)
                indata.__bytes__.assert_not_called()
                engine.stop()
                stream.close.assert_called_once()
            finally:
                self.finish_thread(engine, release)
            engine.commands.execute.assert_not_called()
            stream.close.assert_called_once()

    def test_cancel_after_setup_before_open(self):
        engine = self.make_engine()
        with patch('audio_engine.load_wake'), patch('audio_engine.load_stt'), \
                patch('audio_engine.Speaker') as speaker:
            speaker.return_value.setup.side_effect = engine.stop
            engine.start(self.config)
            engine.thread.join(timeout=3)
            self.assertFalse(engine.running)
            self.sd.RawInputStream.assert_not_called()

    def test_cancel_during_stream_creation_does_not_start_capture(self):
        engine = self.make_engine()
        entered, release = threading.Event(), threading.Event()
        stream = MagicMock()

        def create_stream(**kwargs):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('Test timed out')
            return stream

        self.sd.RawInputStream.side_effect = create_stream
        with patch('audio_engine.load_wake'), patch('audio_engine.load_stt'), \
                patch('audio_engine.Speaker'):
            engine.start(self.config)
            stopper = threading.Thread(target=engine.stop)
            try:
                self.assertTrue(entered.wait(2))
                stopper.start()
                self.assertTrue(engine.stop_event.wait(2))
            finally:
                release.set()
                if stopper.ident is not None:
                    stopper.join(timeout=3)
                    self.assertFalse(stopper.is_alive())
                self.finish_thread(engine, release)
            stream.start.assert_not_called()
            stream.close.assert_called_once()

    def test_output_checks_pending_ids_and_never_acknowledges(self):
        engine = self.make_engine()
        speaker = MagicMock()
        engine.commands.store.pending.return_value = [{'id': 2}]
        engine.output.put((1, 'Уже доставлено или удалено'))
        self.assertFalse(engine._speak_pending(speaker, True))
        speaker.say.assert_not_called()
        engine.output.put((2, 'Чай готов'))
        self.assertTrue(engine._speak_pending(speaker, True))
        speaker.say.assert_called_once_with('Чай готов', engine.stop_event)
        engine.commands.store.mark_delivered.assert_not_called()

    def test_stop_and_start_clear_stale_output(self):
        engine = self.make_engine()
        engine.output.put((1, 'До остановки'))
        engine.stop()
        self.assertTrue(engine.output.empty())
        engine.output.put((2, 'После остановки'))
        with patch.object(engine, '_run'):
            engine.start(self.config)
            engine.thread.join(timeout=3)
        self.assertTrue(engine.output.empty())

    def test_speech_failure_does_not_escape_or_requeue(self):
        engine = self.make_engine()
        speaker = MagicMock()
        speaker.say.side_effect = RuntimeError('SAPI failure')
        engine.commands.store.pending.return_value = [{'id': 1}]
        engine.output.put((1, 'Чай'))
        self.assertFalse(engine._speak_pending(speaker, True))
        self.assertTrue(engine.output.empty())
        self.assertTrue(any(kind == 'warning' for kind, _ in engine.events.queue))
        speaker.say.side_effect = None
        engine.output.put((1, 'Чай'))
        self.assertTrue(engine._speak_pending(speaker, True))

    def test_invalid_output_pending_failure_and_cancellation_do_not_speak(self):
        engine = self.make_engine()
        speaker = MagicMock()
        for item in ('old string', (1,), (True, 'Чай'), (1, ''), (1, None)):
            engine.output.put(item)
            self.assertFalse(engine._speak_pending(speaker, True))
        engine.commands.store.pending.side_effect = RuntimeError('database locked')
        engine.output.put((1, 'Чай'))
        self.assertFalse(engine._speak_pending(speaker, True))

        def cancel_pending():
            engine.stop()
            return [{'id': 1}]

        engine.commands.store.pending.side_effect = cancel_pending
        engine.output.put((1, 'Чай'))
        self.assertFalse(engine._speak_pending(speaker, True))
        speaker.say.assert_not_called()

    def test_close_attempted_even_if_abort_fails(self):
        engine = self.make_engine()
        stream = MagicMock()
        stream.abort.side_effect = RuntimeError('device disconnected')
        engine._stream = stream
        engine.stop()
        stream.close.assert_called_once()
        self.assertIsNone(engine._stream)

    def test_concurrent_stops_close_stream_only_once(self):
        engine = self.make_engine()
        stream = MagicMock()
        engine._stream = stream
        ready = threading.Barrier(5)

        def stop_together():
            ready.wait(timeout=3)
            engine.stop()

        threads = [threading.Thread(target=stop_together) for _ in range(4)]
        for thread in threads:
            thread.start()
        ready.wait(timeout=3)
        for thread in threads:
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
        stream.abort.assert_called_once()
        stream.close.assert_called_once()
        self.assertIsNone(engine._stream)

    def test_speaker_does_not_start_after_cancellation(self):
        speaker = Speaker()
        speaker.voice = MagicMock()
        stop = threading.Event()
        stop.set()
        speaker.say('Не произносить', stop)
        speaker.voice.Speak.assert_not_called()


if __name__ == '__main__':
    unittest.main()
