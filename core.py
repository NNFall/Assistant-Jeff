"""Local-only command parsing and durable SQLite storage (Python 3.12+)."""

from contextlib import contextmanager
import math
import os
import re
import sqlite3
import time


MAX_TEXT_LENGTH = 2000
MAX_COMMAND_LENGTH = 4096
MAX_DELAY_SECONDS = 365 * 24 * 60 * 60


def _text(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Текст не должен быть пустым.")
    if len(value) > MAX_TEXT_LENGTH:
        raise ValueError(f"Текст не должен превышать {MAX_TEXT_LENGTH} символов.")
    if any(ord(char) < 32 and char not in "\n\r\t" for char in value):
        raise ValueError("Текст содержит недопустимые управляющие символы.")
    return value.strip()


def _timestamp(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Время должно быть положительным числом секунд Unix.")
    try:
        value = float(value)
    except OverflowError:
        raise ValueError("Слишком большое значение времени.") from None
    if not math.isfinite(value) or value <= 0:
        raise ValueError("Время должно быть конечным положительным числом.")
    return value


def _id(value):
    if type(value) is not int or not 0 < value <= 2**63 - 1:
        raise ValueError("Идентификатор должен быть положительным целым числом.")
    return value


class Store:
    """File-backed store; each operation opens and closes its own connection.

    Timestamps are Unix seconds. Lists contain dictionaries of all table columns.
    Reminders are ordered by (due_at, id), notes by id. Mutators other than add_*
    return None; deleting or acknowledging a missing positive id is a no-op.
    due() never acknowledges delivery. Call mark_delivered() only after delivery.
    """

    def __init__(self, db_path: str | os.PathLike[str]):
        path = os.fspath(db_path)
        if not isinstance(path, str) or not path or path == ":memory:":
            raise ValueError("Нужен путь к постоянному файлу SQLite.")
        self.db_path = os.path.abspath(path)
        with self._connection() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS notes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS reminders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text TEXT NOT NULL,
                    due_at REAL NOT NULL,
                    created_at REAL NOT NULL,
                    delivered_at REAL
                );
                CREATE INDEX IF NOT EXISTS reminders_pending_due
                    ON reminders(due_at, id) WHERE delivered_at IS NULL;
            """)

    @contextmanager
    def _connection(self):
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def add_note(self, text: str) -> int:
        text = _text(text)
        with self._connection() as connection:
            return connection.execute(
                "INSERT INTO notes(text, created_at) VALUES (?, ?)",
                (text, time.time()),
            ).lastrowid

    def add_reminder(self, text: str, due_at: float) -> int:
        text, due_at = _text(text), _timestamp(due_at)
        with self._connection() as connection:
            return connection.execute(
                "INSERT INTO reminders(text, due_at, created_at) VALUES (?, ?, ?)",
                (text, due_at, time.time()),
            ).lastrowid

    def pending(self) -> list[dict]:
        with self._connection() as connection:
            return [dict(row) for row in connection.execute(
                "SELECT * FROM reminders WHERE delivered_at IS NULL ORDER BY due_at, id"
            )]

    def notes(self) -> list[dict]:
        with self._connection() as connection:
            return [dict(row) for row in connection.execute("SELECT * FROM notes ORDER BY id")]

    def due(self, now: float | None = None) -> list[dict]:
        now = _timestamp(time.time() if now is None else now)
        with self._connection() as connection:
            return [dict(row) for row in connection.execute(
                "SELECT * FROM reminders WHERE delivered_at IS NULL AND due_at <= ? "
                "ORDER BY due_at, id", (now,),
            )]

    def mark_delivered(self, id: int) -> None:
        id = _id(id)
        with self._connection() as connection:
            connection.execute(
                "UPDATE reminders SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL",
                (time.time(), id),
            )

    def delete_reminder(self, id: int) -> None:
        id = _id(id)
        with self._connection() as connection:
            connection.execute("DELETE FROM reminders WHERE id = ?", (id,))

    def delete_note(self, id: int) -> None:
        id = _id(id)
        with self._connection() as connection:
            connection.execute("DELETE FROM notes WHERE id = ?", (id,))


_SMALL = {
    "один": 1, "одна": 1, "одну": 1, "одной": 1,
    "два": 2, "две": 2, "двух": 2,
    "три": 3, "четыре": 4, "пять": 5, "шесть": 6, "семь": 7,
    "восемь": 8, "девять": 9, "десять": 10, "одиннадцать": 11,
    "двенадцать": 12, "тринадцать": 13, "четырнадцать": 14,
    "пятнадцать": 15, "шестнадцать": 16, "семнадцать": 17,
    "восемнадцать": 18, "девятнадцать": 19,
}
_TENS = dict(zip(
    "двадцать тридцать сорок пятьдесят шестьдесят семьдесят восемьдесят девяносто".split(),
    range(20, 100, 10),
))
_HUNDREDS = dict(zip(
    "сто двести триста четыреста пятьсот шестьсот семьсот восемьсот девятьсот".split(),
    range(100, 1000, 100),
))
_UNITS = {
    "секунда": 1, "секунду": 1, "секунды": 1, "секунд": 1, "секунде": 1,
    "минута": 60, "минуту": 60, "минуты": 60, "минут": 60, "минуте": 60,
    "час": 3600, "часа": 3600, "часов": 3600,
}
_NOTE = re.compile(r"(?:запиши заметку|сохрани заметку|создай заметку|заметка)(?=$|[\s:,])\s*[:,]?\s*(.*)", re.I)
_REMINDER = re.compile(r"(?:напомни|поставь напоминание) через\s+(.+)", re.I)
_TIMER = re.compile(r"(?:поставь таймер|таймер) на\s+(.+)", re.I)
_DURATION = re.compile(
    r"(?P<number>.+?)\s+(?P<unit>" + "|".join(_UNITS)
    + r")(?=$|[\s,])(?:(?:\s*,\s*|\s+)(?P<body>.*))?",
    re.I,
)
_DURATION_START = re.compile(
    r"(?P<number>.+?)\s+(?:" + "|".join(_UNITS) + r")(?=$|[\s,.;:!?…])", re.I,
)
_CORRECTION = re.compile(
    r"(?<!\w)(?:а\s+лучше|а\s+нет|нет|точнее|вернее|лучше|то\s+есть)\b"
    r"[\s,.:;!?]*(?:(?:через|на)\s+)?", re.I,
)
_HELP = (
    "Команды: «запиши заметку купить хлеб», «заметка купить хлеб», "
    "«сохрани заметку купить хлеб», «создай заметку купить хлеб», "
    "«поставь таймер на две минуты», «напомни через полтора часа проверить чай», "
    "«поставь напоминание через 10 минут проверить чай». "
    "Поддерживаются секунды, минуты и часы, до 365 дней. "
    "Календарные даты, составные интервалы и другие действия не поддерживаются."
)


def _number(text):
    if re.fullmatch(r"[0-9]+(?:[.,][0-9]+)?", text):
        value = float(text.replace(",", "."))
    elif text in ("полтора", "полторы"):
        value = 1.5
    else:
        words = text.split()
        value = 0
        if words and words[0] in _HUNDREDS:
            value += _HUNDREDS[words.pop(0)]
        if words and words[0] in _TENS:
            value += _TENS[words.pop(0)]
            if words and 0 < _SMALL.get(words[0], 0) < 10:
                value += _SMALL[words.pop(0)]
        elif words and words[0] in _SMALL:
            value += _SMALL[words.pop(0)]
        if words:
            raise ValueError("Не удалось распознать число. Укажите положительное число цифрами или словами.")
    if not math.isfinite(value) or value <= 0:
        raise ValueError("Длительность должна быть конечным положительным числом.")
    return value


def _starts_with_duration(text):
    remainder = re.sub(r"^(?:и(?: ещё| еще)?|плюс)\b[\s,]*", "", text.lower())
    duration = _DURATION_START.match(remainder)
    if not duration:
        return False
    try:
        _number(duration["number"])
    except ValueError:
        return False
    return True


def _ambiguous_duration(text):
    return _starts_with_duration(text) or any(
        _starts_with_duration(text[match.end():]) for match in _CORRECTION.finditer(text)
    )


class CommandService:
    """execute(text, now=None) returns ok, message, kind and optional created id.

    kind is note/reminder/help/error; timers are reminders. now controls scheduling
    only; created_at/delivered_at record actual storage/delivery time. Repeated
    commands intentionally create independent records, with no implicit dedup.
    """

    def __init__(self, store: Store):
        self.store = store

    def execute(self, text: str, now: float | None = None) -> dict:
        try:
            if not isinstance(text, str) or not text.strip():
                raise ValueError("Введите команду.")
            if len(text) > MAX_COMMAND_LENGTH:
                raise ValueError(f"Команда не должна превышать {MAX_COMMAND_LENGTH} символов.")
            if any(ord(char) < 32 and char not in "\n\r\t" for char in text):
                raise ValueError("Команда содержит недопустимые управляющие символы.")
            command = " ".join(text.split())
            if command.lower() in ("помощь", "справка", "что ты умеешь"):
                return {"ok": True, "message": _HELP, "kind": "help"}
            note = _NOTE.fullmatch(command)
            if note:
                id = self.store.add_note(note[1])
                return {"ok": True, "message": "Заметка сохранена.", "kind": "note", "id": id}
            timer = _TIMER.fullmatch(command)
            reminder = _REMINDER.fullmatch(command)
            match = timer or reminder
            if not match:
                raise ValueError("Команда не поддерживается. " + _HELP)
            # Strip sentence-ending punctuation only from timers, never note/body text.
            interval = match[1].rstrip(".!?…").rstrip() if timer else match[1]
            duration = _DURATION.fullmatch(interval)
            if not duration:
                raise ValueError("Укажите длительность числом и единицей: секунды, минуты или часы.")
            delay = _number(duration["number"].lower()) * _UNITS[duration["unit"].lower()]
            if delay > MAX_DELAY_SECONDS:
                raise ValueError("Максимальный интервал: 365 дней.")
            body = duration["body"] or ""
            if timer and duration["body"] is not None:
                raise ValueError("После длительности таймера не должно быть других команд или текста.")
            # Do not silently treat the remainder of a compound interval as its message.
            if body and _ambiguous_duration(body):
                raise ValueError("Составные интервалы и исправления срока не поддерживаются. Укажите одно число и единицу.")
            if not timer and not any(char.isalnum() for char in body):
                raise ValueError("Укажите текст напоминания после длительности.")
            body = _text("Таймер на " + interval if timer else body)
            current = _timestamp(time.time() if now is None else now)
            due_at = _timestamp(current + delay)
            if due_at <= current:
                raise ValueError("Слишком малая длительность для указанного времени.")
            id = self.store.add_reminder(body, due_at)
            seconds = str(delay).removesuffix(".0").replace(".", ",")
            label = "Таймер установлен" if timer else "Напоминание установлено"
            return {"ok": True, "message": f"{label}: через {seconds} с.",
                    "kind": "reminder", "id": id}
        except ValueError as exc:
            return {"ok": False, "message": str(exc), "kind": "error"}
        except sqlite3.Error:
            return {"ok": False, "message": "Не удалось сохранить данные в локальную базу.", "kind": "error"}
