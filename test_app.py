import queue
import sqlite3
import threading
import unittest
from unittest.mock import MagicMock, patch

from app import App


class AppTests(unittest.TestCase):
    def bare_app(self):
        app = App.__new__(App)
        app.root = MagicMock()
        app.closing = False
        app.want_listen = False
        app.status = MagicMock()
        app.engine = MagicMock()
        app.speech_busy = threading.Event()
        app.speech_queue = queue.Queue()
        app.log = MagicMock()
        app.last_poll_error = None
        return app

    def test_poll_reschedules_after_database_error(self):
        app = self.bare_app()
        app.poll_events = MagicMock(side_effect=sqlite3.OperationalError('database is locked'))
        app.poll()
        app.root.after.assert_called_once()
        app.log.assert_called_once()
        app.poll()
        self.assertEqual(app.log.call_count, 1)
        self.assertEqual(app.root.after.call_count, 2)

    def test_stop_cancels_queued_restart(self):
        app = self.bare_app()
        app.engine.running = True
        app.engine.stop_event = threading.Event()
        app.engine.stop_event.set()
        app.start()
        app.root.after.assert_called_once()
        app.stop()
        callback = app.root.after.call_args.args[1]
        callback()
        app.engine.start.assert_not_called()

    def test_no_start_during_external_tts(self):
        app = self.bare_app()
        app.speech_busy.set()
        app.start()
        app.root.after.assert_called_once()
        app.engine.start.assert_not_called()

    def test_reminder_speaks_without_enabling_microphone(self):
        app = self.bare_app()
        app.events = queue.Queue()
        app.last_due_check = 0
        app.announced = set()
        app.store = MagicMock()
        app.store.due.return_value = [{'id': 9, 'text': 'Проверить чай'}]
        app.foot = MagicMock()
        app.tray = MagicMock()
        app.tts = MagicMock()
        app.tts.get.return_value = True
        app.engine.running = False
        app.speak_without_microphone = MagicMock()
        with patch('winsound.MessageBeep'):
            app.poll_events()
        app.speak_without_microphone.assert_called_once_with((9, 'Напоминание. Проверить чай'))
        app.engine.start.assert_not_called()
        app.store.mark_delivered.assert_not_called()
        self.assertIn(9, app.announced)


if __name__ == '__main__':
    unittest.main()
