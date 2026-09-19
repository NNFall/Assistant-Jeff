"""Run with: python -m unittest -v test_core"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from core import CommandService, MAX_COMMAND_LENGTH, MAX_DELAY_SECONDS, MAX_TEXT_LENGTH, Store


NOW = 1_800_000_000.0


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "assistant.sqlite3"
        self.store = Store(self.path)
        self.service = CommandService(self.store)

    def assert_error(self, command, **kwargs):
        result = self.service.execute(command, **kwargs)
        self.assertEqual(result["ok"], False, result)
        self.assertEqual(result["kind"], "error", result)
        self.assertIsInstance(result["message"], str)
        self.assertTrue(result["message"])
        self.assertNotIn("id", result)

    def test_reopen_and_schema(self):
        with patch("core.time.time", return_value=NOW):
            note_id = self.store.add_note("Купить хлеб")
            reminder_id = self.store.add_reminder("Чай", NOW - 10)
        reopened = Store(self.path)
        self.assertEqual(reopened.notes(), [{"id": note_id, "text": "Купить хлеб", "created_at": NOW}])
        self.assertEqual(reopened.pending(), [{"id": reminder_id, "text": "Чай", "due_at": NOW - 10,
                                              "created_at": NOW, "delivered_at": None}])

    def test_due_is_read_only_until_explicit_ack(self):
        past = self.store.add_reminder("Вчера", NOW - 1)
        exact = self.store.add_reminder("Сейчас", NOW)
        future = self.store.add_reminder("Потом", NOW + 1)
        expected = [past, exact]
        for store in (self.store, self.store, Store(self.path)):
            self.assertEqual([row["id"] for row in store.due(NOW)], expected)
            self.assertEqual(len(store.pending()), 3)
        with patch("core.time.time", return_value=NOW):
            self.assertEqual([row["id"] for row in self.store.due()], expected)
            self.assertIsNone(self.store.mark_delivered(past))
        with patch("core.time.time", return_value=NOW + 100):
            self.store.mark_delivered(past)
        with closing(sqlite3.connect(self.path)) as connection:
            delivered = connection.execute("SELECT delivered_at FROM reminders WHERE id = ?", (past,)).fetchone()[0]
        self.assertEqual(delivered, NOW)
        self.assertEqual([row["id"] for row in Store(self.path).pending()], [exact, future])
        self.assertEqual([row["id"] for row in self.store.due(NOW)], [exact])

    def test_order_delete_and_no_id_reuse(self):
        later = self.store.add_reminder("Позже", NOW + 1)
        first = self.store.add_reminder("Первое", NOW)
        second = self.store.add_reminder("Второе", NOW)
        self.assertEqual([row["id"] for row in self.store.pending()], [first, second, later])
        self.assertIsNone(self.store.delete_reminder(first))
        self.store.delete_reminder(first)
        self.store.mark_delivered(first)
        self.assertEqual([row["id"] for row in self.store.pending()], [second, later])
        note = self.store.add_note("Один")
        self.assertIsNone(self.store.delete_note(note))
        self.store.delete_note(note)
        self.assertEqual(self.store.notes(), [])
        self.assertGreater(self.store.add_note("Два"), note)

    def test_thread_safe_per_operation_connections(self):
        def write(index):
            self.store.add_note(str(index))
            id = self.store.add_reminder(str(index), NOW + index)
            self.store.pending()
            self.store.due(NOW)
            return id
        with ThreadPoolExecutor(max_workers=8) as pool:
            ids = list(pool.map(write, range(40)))
        self.assertEqual(len(set(ids)), 40)
        self.assertEqual(len(self.store.notes()), 40)
        self.assertEqual(len(Store(self.path).pending()), 40)

    def test_store_validation(self):
        for value in (None, 3, "", " \n", "x" * (MAX_TEXT_LENGTH + 1), "x\0y"):
            with self.subTest(text=repr(value)[:50]):
                with self.assertRaises(ValueError):
                    self.store.add_note(value)
                with self.assertRaises(ValueError):
                    self.store.add_reminder(value, NOW)
        for value in (0, -1, True, "1", None, float("nan"), float("inf"), 10**400):
            with self.subTest(time=repr(value)[:50]):
                with self.assertRaises(ValueError):
                    self.store.add_reminder("Текст", value)
                if value is not None:
                    with self.assertRaises(ValueError):
                        self.store.due(value)
        for method in (self.store.mark_delivered, self.store.delete_note, self.store.delete_reminder):
            for value in (0, -1, True, "1", 1.5, 2**63):
                with self.assertRaises(ValueError):
                    method(value)
        with self.assertRaises(ValueError):
            Store(":memory:")

    def test_exact_note_prefixes_and_literal_payload(self):
        for prefix in ("запиши заметку", "заметка", "сохрани заметку", "создай заметку", "ЗАМЕТКА:"):
            result = self.service.execute(prefix + " Купить хлеб")
            self.assertEqual(set(result), {"ok", "message", "kind", "id"})
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["kind"], "note")
            self.assertEqual(self.store.notes()[-1]["text"], "Купить хлеб")
        payload = "'; DROP TABLE notes; --"
        self.service.execute("заметка " + payload)
        self.assertEqual(self.store.notes()[-1]["text"], payload)
        for command in ("заметкам привет", "заметкапривет", "запиши заметкуещё привет"):
            self.assert_error(command)

    def test_relative_numbers_and_inflections(self):
        cases = {
            "1 секунду": 1, "две секунды": 2, "пять секунд": 5,
            "одну минуту": 60, "две минуты": 120, "10 минут": 600,
            "один час": 3600, "два часа": 7200, "пять часов": 18000,
            "полтора часа": 5400, "полторы минуты": 90, "1,5 минуты": 90,
            "двадцать одну минуту": 1260, "двадцать две минуты": 1320,
            "сто двадцать три секунды": 123, "девятнадцать секунд": 19,
            "двести секунд": 200, "девятьсот девяносто девять секунд": 999,
            "0.5 секунды": 0.5,
        }
        for interval, delay in cases.items():
            with self.subTest(interval=interval):
                result = self.service.execute(f"напомни через {interval} Проверить чай", now=NOW)
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["kind"], "reminder")
                row = next(row for row in self.store.pending() if row["id"] == result["id"])
                self.assertEqual(row["due_at"], NOW + delay)
                self.assertEqual(row["text"], "Проверить чай")

    def test_timer_and_default_now(self):
        with patch("core.time.time", return_value=NOW):
            result = self.service.execute("  ПОСТАВЬ таймер на ДВЕ минуты  ")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["kind"], "reminder")
        row = self.store.pending()[0]
        self.assertEqual(row["due_at"], NOW + 120)
        self.assertEqual(row["created_at"], NOW)
        self.assertEqual(row["text"], "Таймер на ДВЕ минуты")

    def test_reminder_body_can_mention_another_duration(self):
        result = self.service.execute("напомни через две минуты заварить чай на три минуты", now=NOW)
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.store.pending()[0]["text"], "заварить чай на три минуты")

    def test_exact_local_stt_transcripts(self):
        fixtures = (
            ("Запиши заметку, купить молоко и хлеб.", "note", "купить молоко и хлеб.", None),
            ("Напомни через 10 минут проверить чай.", "reminder", "проверить чай.", 600),
            ("Поставь таймер на две минуты.", "reminder", "Таймер на две минуты", 120),
        )
        for transcript, kind, content, delay in fixtures:
            with self.subTest(transcript=transcript):
                result = self.service.execute(transcript, now=NOW)
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["kind"], kind)
                rows = self.store.notes() if kind == "note" else self.store.pending()
                row = next(row for row in rows if row["id"] == result["id"])
                self.assertEqual(row["text"], content)
                if delay is not None:
                    self.assertEqual(row["due_at"], NOW + delay)
                    self.assertIn(f"через {delay} с.", result["message"])

    def test_note_comma_separator(self):
        for prefix in ("Запиши заметку", "Сохрани заметку", "Создай заметку", "Заметка"):
            for separator in (", ", ",", " , "):
                with self.subTest(prefix=prefix, separator=separator):
                    result = self.service.execute(prefix + separator + "Молоко, хлеб.")
                    self.assertTrue(result["ok"], result)
                    self.assertEqual(self.store.notes()[-1]["text"], "Молоко, хлеб.")
            self.assert_error(prefix + ", ")

    def test_whisper_timer_punctuation(self):
        for ending in (".", "!", "?", "...", "…", "! "):
            with self.subTest(ending=ending):
                result = self.service.execute("Поставь таймер на две минуты" + ending, now=NOW)
                self.assertTrue(result["ok"], result)
                self.assertEqual(set(result), {"ok", "message", "kind", "id"})
                self.assertEqual(result["message"], "Таймер установлен: через 120 с.")
                row = next(row for row in self.store.pending() if row["id"] == result["id"])
                self.assertEqual(row["text"], "Таймер на две минуты")
                self.assertEqual(row["due_at"], NOW + 120)

    def test_whisper_reminder_punctuation_and_alias(self):
        for prefix in ("Напомни", "Поставь напоминание"):
            for separator in (" ", ", ", ",", " , "):
                with self.subTest(prefix=prefix, separator=separator):
                    result = self.service.execute(
                        prefix + " через 10 минут" + separator + "проверить чай.", now=NOW,
                    )
                    self.assertTrue(result["ok"], result)
                    self.assertEqual(result["message"], "Напоминание установлено: через 600 с.")
                    row = next(row for row in self.store.pending() if row["id"] == result["id"])
                    self.assertEqual(row["due_at"], NOW + 600)
                    self.assertEqual(row["text"], "проверить чай.")

    def test_note_alias_preserves_content_punctuation(self):
        payload = 'Чай, хлеб: 1,5 литра. "Не забыть!"...'
        for prefix in ("Создай заметку", "Создай заметку:", "Заметка", "Запиши заметку", "Сохрани заметку"):
            result = self.service.execute(prefix + " " + payload)
            self.assertTrue(result["ok"], result)
            self.assertEqual(self.store.notes()[-1]["text"], payload)
        self.assert_error("создай заметкуещё хлеб")

    def test_confirmation_duration_without_rounding(self):
        cases = (
            ("Таймер на 1,5 минуты.", 90, "Таймер установлен: через 90 с."),
            ("Напомни через полтора часа, чай.", 5400, "Напоминание установлено: через 5400 с."),
            ("Таймер на 1.23456789 секунды.", 1.23456789, "Таймер установлен: через 1,23456789 с."),
        )
        for command, delay, message in cases:
            with self.subTest(command=command):
                result = self.service.execute(command, now=NOW)
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["message"], message)
                row = next(row for row in self.store.pending() if row["id"] == result["id"])
                self.assertEqual(row["due_at"], NOW + delay)

    def test_punctuated_compounds_and_corrections_are_not_partially_accepted(self):
        commands = (
            "Поставь таймер на две минуты, и тридцать секунд.",
            "Поставь таймер на две минуты. Нет, на три минуты.",
            "Поставь таймер на две минуты, а лучше три.",
            "Поставь таймер на две минуты. Открой браузер.",
            "Поставь таймер на две минуты,",
            "Напомни через 10 минут, и 30 секунд проверить чай.",
            "Напомни через 10 минут, и ещё 30 секунд проверить чай.",
            "Напомни через 10 минут, 30 секунд проверить чай.",
            "Напомни через 10 минут, нет, через 20 минут проверить чай.",
            "Напомни через 10 минут, а лучше через 20 минут проверить чай.",
            "Напомни через 10 минут, проверить чай, точнее через 20 минут.",
            "Напомни через 10 минут, нет, через 20 минут. Проверить чай.",
            "Поставь напоминание через 10 минут, проверить чай. Нет, через 20 минут.",
            "Поставь напоминание через 10 минут, .",
            "Напомни через 10 минут.",
            "Создай заметку:",
        )
        for command in commands:
            with self.subTest(command=command):
                self.assert_error(command, now=NOW)
        self.assertEqual(self.store.pending(), [])
        self.assertEqual(self.store.notes(), [])

    def test_invalid_commands_have_no_side_effects(self):
        commands = [
            None, 12, "", " \t\n", "заметка", "запиши заметку:",
            "таймер на -5 минут", "таймер на 0 секунд", "таймер на ноль минут",
            "таймер на минус две минуты", "таймер на +2 минуты", "таймер на 1e3 секунд",
            "таймер на NaN секунд", "таймер на бесконечность часов",
            "таймер на два три часа", "таймер на двадцать десять минут",
            "таймер на пару минут", "таймер на 5 дней", "таймер на 5 минут открой браузер",
            "напомни через 10 минут", "напомни завтра в 12:00 чай",
            "напомни сегодня в 23:00 чай", "напомни в пятницу чай",
            "напомни через 1 час и 30 минут чай", "напомни через 1 час 30 минут чай",
            "открой браузер", "выключи компьютер", "rm -rf /", "заметка x\x00y",
            "заметка " + "x" * (MAX_TEXT_LENGTH + 1),
            "x" * (MAX_COMMAND_LENGTH + 1),
            "напомни через 1 секунду " + "x" * (MAX_TEXT_LENGTH + 1),
            f"таймер на {MAX_DELAY_SECONDS + 1} секунд",
        ]
        for command in commands:
            with self.subTest(command=repr(command)[:80]):
                self.assert_error(command, now=NOW)
        self.assertEqual(self.store.notes(), [])
        self.assertEqual(self.store.pending(), [])

    def test_limits_invalid_now_and_float_precision(self):
        self.assertTrue(self.service.execute("заметка " + "x" * MAX_TEXT_LENGTH)["ok"])
        self.assertTrue(self.service.execute(f"таймер на {MAX_DELAY_SECONDS} секунд", now=NOW)["ok"])
        for now in (0, -1, True, "tomorrow", float("nan"), float("inf"), 1e300):
            self.assert_error("таймер на 1 секунду", now=now)
        self.assert_error("таймер на 0.000000000000001 секунды", now=NOW)
        self.assert_error("таймер на " + "9" * 350 + " секунд", now=NOW)

    def test_no_implicit_deduplication(self):
        for command in ("заметка купить хлеб", "напомни через 1 минуту чай", "таймер на две минуты"):
            first = self.service.execute(command, now=NOW)
            second = self.service.execute(command, now=NOW)
            self.assertTrue(first["ok"], first)
            self.assertTrue(second["ok"], second)
            self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(len(self.store.notes()), 2)
        self.assertEqual(len(self.store.pending()), 4)

    def test_help_and_storage_error(self):
        for command in ("помощь", "справка", "что ты умеешь"):
            result = self.service.execute(command)
            self.assertTrue(result["ok"])
            self.assertEqual(result["kind"], "help")
            self.assertNotIn("id", result)
        with patch.object(self.store, "add_note", side_effect=sqlite3.OperationalError("private path")):
            self.assert_error("заметка чай")
            self.assertNotIn("private path", self.service.execute("заметка чай")["message"])
        self.assertEqual(self.store.notes(), [])
        self.assertEqual(self.store.pending(), [])


if __name__ == "__main__":
    unittest.main()
