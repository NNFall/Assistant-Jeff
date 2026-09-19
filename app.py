"""Personal, offline-first voice assistant for Windows."""
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk, messagebox

from core import Store, CommandService
from audio_engine import AudioEngine, NAMES, Speaker

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data'
DEFAULT = {'wake_name': 'Hey Jarvis', 'threshold': 0.5, 'device': None,
           'duck': True, 'tts': True}


def shortcut_path():
    return Path(os.environ['APPDATA']) / 'Microsoft/Windows/Start Menu/Programs/Startup/Jarvis Local.lnk'


def make_shortcut(path, background=False):
    import win32com.client
    shortcut = win32com.client.Dispatch('WScript.Shell').CreateShortcut(str(path))
    shortcut.TargetPath = str(ROOT / '.venv/Scripts/pythonw.exe')
    shortcut.Arguments = f'"{ROOT / "launcher.pyw"}"' + (' --background' if background else '')
    shortcut.WorkingDirectory = str(ROOT)
    shortcut.Description = 'Jarvis Local - local voice notes and reminders'
    shortcut.WindowStyle = 7
    shortcut.Save()


class App:
    def __init__(self, root, background=False, test=False):
        self.root = root
        self.test = test
        self.closing = False
        self.want_listen = False
        self.shutdown_speech = threading.Event()
        self.events = queue.Queue()
        DATA.mkdir(exist_ok=True)
        self.config_path = DATA / 'settings.json'
        self.config = dict(DEFAULT)
        if self.config_path.exists():
            try:
                self.config.update(json.loads(self.config_path.read_text(encoding='utf-8')))
            except (ValueError, OSError):
                pass
        self.store = Store(DATA / ('ui-test.sqlite' if test else 'assistant.sqlite'))
        self.commands = CommandService(self.store)
        self.engine = AudioEngine(self.events, self.commands)
        self.announced = set()
        self.speech_busy = threading.Event()
        self.speech_queue = queue.Queue()
        self.speech_thread = None
        self.last_due_check = 0
        self.last_poll_error = None
        self.tray = None
        self.root.title('Jarvis Local')
        self.root.geometry('860x620')
        self.root.minsize(720, 530)
        self.root.protocol('WM_DELETE_WINDOW', self.hide)
        self.status = tk.StringVar(value='Микрофон выключен')
        self.name = tk.StringVar(value=self.config['wake_name'])
        self.threshold = tk.DoubleVar(value=self.config['threshold'])
        self.duck = tk.BooleanVar(value=self.config['duck'])
        self.tts = tk.BooleanVar(value=self.config['tts'])
        self.autostart = tk.BooleanVar(value=shortcut_path().exists())
        self.score = tk.DoubleVar(value=0)
        self.text = tk.StringVar()
        self.device_value = tk.StringVar()
        self.build()
        if not test:
            self.start_tray()
            self.load_devices()
            self.root.after(100, self.poll)
            if background:
                self.root.after(300, self.hide)
                self.root.after(500, self.start)
        self.refresh()

    def build(self):
        style = ttk.Style()
        style.theme_use('vista')
        base = ttk.Frame(self.root, padding=16)
        base.pack(fill='both', expand=True)
        head = ttk.Frame(base)
        head.pack(fill='x')
        ttk.Label(head, text='Jarvis Local', font=('Segoe UI', 18, 'bold')).pack(side='left')
        ttk.Button(head, text='Выход', command=self.quit).pack(side='right')
        ttk.Button(head, text='В трей', command=self.hide).pack(side='right', padx=6)
        ttk.Label(base, textvariable=self.status, wraplength=650).pack(anchor='w', pady=(10, 6))
        row = ttk.Frame(base)
        row.pack(fill='x')
        self.start_button = ttk.Button(row, text='Включить микрофон', command=self.start)
        self.start_button.pack(side='left')
        ttk.Button(row, text='Выключить микрофон', command=self.stop).pack(side='left', padx=6)
        ttk.Button(row, text='Записать команду', command=self.record).pack(side='left')
        ttk.Progressbar(row, variable=self.score, maximum=1, length=100).pack(side='right')
        tabs = ttk.Notebook(base)
        tabs.pack(fill='both', expand=True, pady=12)
        journal = ttk.Frame(tabs, padding=10)
        notes = ttk.Frame(tabs, padding=10)
        reminders = ttk.Frame(tabs, padding=10)
        settings = ttk.Frame(tabs, padding=10)
        tabs.add(journal, text='Команды')
        tabs.add(notes, text='Заметки')
        tabs.add(reminders, text='Напоминания')
        tabs.add(settings, text='Настройки')
        self.history = tk.Text(journal, wrap='word', font=('Segoe UI', 10), state='disabled')
        self.history.pack(fill='both', expand=True)
        input_row = ttk.Frame(journal)
        input_row.pack(fill='x', pady=(8, 0))
        entry = ttk.Entry(input_row, textvariable=self.text)
        entry.pack(side='left', fill='x', expand=True)
        entry.bind('<Return>', lambda _: self.execute_text())
        ttk.Button(input_row, text='Выполнить', command=self.execute_text).pack(side='right', padx=(8, 0))
        self.notes_tree = self.tree(notes, ('created', 'text'), ('Дата', 'Заметка'))
        ttk.Button(notes, text='Удалить выбранную', command=self.delete_note).pack(anchor='e', pady=6)
        self.reminders_tree = self.tree(reminders, ('due', 'text'), ('Срок', 'Напоминание'))
        ttk.Button(reminders, text='Отметить выполненным', command=self.acknowledge).pack(anchor='e', pady=6)
        settings.columnconfigure(1, weight=1)
        ttk.Label(settings, text='Фраза активации').grid(row=0, column=0, sticky='w', pady=8)
        ttk.Combobox(settings, values=list(NAMES), textvariable=self.name, state='readonly').grid(row=0, column=1, sticky='ew')
        ttk.Label(settings, text='Микрофон').grid(row=1, column=0, sticky='w', pady=8)
        self.device_combo = ttk.Combobox(settings, textvariable=self.device_value, state='readonly')
        self.device_combo.grid(row=1, column=1, sticky='ew')
        ttk.Button(settings, text='Обновить', command=self.load_devices).grid(row=1, column=2, padx=6)
        ttk.Label(settings, text='Порог активации').grid(row=2, column=0, sticky='w', pady=8)
        ttk.Spinbox(settings, from_=0.1, to=0.95, increment=0.05, textvariable=self.threshold, width=8).grid(row=2, column=1, sticky='w')
        ttk.Checkbutton(settings, text='Приглушать другие приложения во время команды', variable=self.duck).grid(row=3, column=0, columnspan=3, sticky='w', pady=8)
        ttk.Checkbutton(settings, text='Голосовые подтверждения', variable=self.tts).grid(row=4, column=0, columnspan=3, sticky='w', pady=8)
        ttk.Checkbutton(settings, text='Запускать в трее и включать микрофон при входе в Windows',
                        variable=self.autostart, command=self.set_autostart).grid(row=5, column=0, columnspan=3, sticky='w', pady=8)
        ttk.Button(settings, text='Применить при следующем включении', command=self.save).grid(row=6, column=0, columnspan=3, sticky='w', pady=8)
        self.foot = tk.StringVar(value='Локальный режим · CPU · AEC не включён')
        ttk.Label(base, textvariable=self.foot, wraplength=650).pack(anchor='w')

    @staticmethod
    def tree(parent, columns, headings):
        frame = ttk.Frame(parent)
        frame.pack(fill='both', expand=True)
        tree = ttk.Treeview(frame, columns=columns, show='headings', selectmode='browse')
        for column, heading in zip(columns, headings):
            tree.heading(column, text=heading)
            tree.column(column, width=170 if column != 'text' else 530, minwidth=90)
        scrollbar = ttk.Scrollbar(frame, orient='vertical', command=tree.yview)
        tree.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side='right', fill='y')
        tree.pack(fill='both', expand=True)
        tree.bind('<Double-1>', lambda _: App.show_full(tree))
        return tree

    @staticmethod
    def show_full(tree):
        selected = tree.selection()
        if selected:
            messagebox.showinfo('Запись', tree.item(selected[0], 'values')[-1])

    def load_devices(self):
        import sounddevice as sd
        self.devices = {'По умолчанию': None}
        try:
            apis = sd.query_hostapis()
            for i, device in enumerate(sd.query_devices()):
                if device['max_input_channels'] > 0:
                    key = f'{i}: {device["name"]} [{apis[device["hostapi"]]["name"]}]'
                    self.devices[key] = i
            self.device_combo['values'] = list(self.devices)
            selected = next((k for k, v in self.devices.items() if v == self.config['device']), 'По умолчанию')
            self.device_value.set(selected)
        except Exception as exc:
            self.log(str(exc))

    def save(self):
        try:
            threshold = self.threshold.get()
            if not 0.1 <= threshold <= 0.95:
                raise ValueError('Порог должен быть от 0.1 до 0.95')
            self.config.update(wake_name=self.name.get(), threshold=threshold,
                               duck=self.duck.get(), tts=self.tts.get(),
                               device=self.devices.get(self.device_value.get()))
            tmp = self.config_path.with_suffix('.tmp')
            tmp.write_text(json.dumps(self.config, ensure_ascii=False, indent=2), encoding='utf-8')
            tmp.replace(self.config_path)
            return True
        except Exception as exc:
            messagebox.showerror('Настройки', str(exc))
            return False

    def set_autostart(self):
        try:
            if self.autostart.get():
                make_shortcut(shortcut_path(), background=True)
            else:
                shortcut_path().unlink(missing_ok=True)
        except Exception as exc:
            self.autostart.set(shortcut_path().exists())
            messagebox.showerror('Автозапуск', str(exc))

    def start(self, requested=True):
        if requested:
            self.want_listen = True
        if self.closing or not self.want_listen:
            return
        if self.speech_busy.is_set() or not self.speech_queue.empty():
            if not self.speech_busy.is_set():
                self.speak_without_microphone()
            self.status.set('Ожидание завершения голосового напоминания…')
            self.root.after(200, lambda: self.start(False))
            return
        if self.engine.running and self.engine.stop_event.is_set():
            self.status.set('Завершение предыдущей команды; повторное включение…')
            self.root.after(200, lambda: self.start(False))
            return
        if not self.closing and self.save():
            self.engine.start(self.config)

    def stop(self):
        self.want_listen = False
        self.engine.stop()
        self.status.set('Остановка микрофона…' if self.engine.running else 'Микрофон выключен')

    def record(self):
        if self.engine.running:
            self.engine.manual.set()
        else:
            self.log('Сначала включите микрофон.')

    def execute_text(self):
        value = self.text.get().strip()
        if value:
            self.log('Вы: ' + value)
            result = self.commands.execute(value)
            self.log(result['message'])
            self.text.set('')
            self.refresh()

    def log(self, text):
        self.history.configure(state='normal')
        self.history.insert('end', time.strftime('%H:%M:%S ') + text + '\n\n')
        self.history.see('end')
        self.history.configure(state='disabled')

    def refresh(self):
        for tree in (self.notes_tree, self.reminders_tree):
            for child in tree.get_children():
                tree.delete(child)
        for row in self.store.notes():
            self.notes_tree.insert('', 'end', iid=str(row['id']), values=(self.date(row['created_at']), row['text']))
        for row in self.store.pending():
            self.reminders_tree.insert('', 'end', iid=str(row['id']), values=(self.date(row['due_at']), row['text']))

    @staticmethod
    def date(value):
        return time.strftime('%d.%m %H:%M:%S', time.localtime(float(value)))

    def delete_note(self):
        selected = self.notes_tree.selection()
        if selected and messagebox.askyesno('Удалить заметку', 'Удалить выбранную заметку?'):
            self.store.delete_note(int(selected[0]))
            self.refresh()

    def acknowledge(self):
        selected = self.reminders_tree.selection()
        if selected:
            self.store.mark_delivered(int(selected[0]))
            self.refresh()

    def poll(self):
        try:
            self.poll_events()
            self.last_poll_error = None
        except Exception as exc:
            error = f'{type(exc).__name__}: {exc}'
            if error != self.last_poll_error and not self.closing:
                self.last_poll_error = error
                self.log('Ошибка обработки: ' + error)
        finally:
            if not self.closing:
                self.root.after(150, self.poll)

    def poll_events(self):
        while True:
            try:
                kind, value = self.events.get_nowait()
            except queue.Empty:
                break
            if kind == 'state':
                self.status.set(value)
            elif kind == 'score':
                self.score.set(value)
            elif kind == 'transcript':
                self.log('Вы: ' + (value or '[неразборчиво]'))
            elif kind == 'result':
                self.log(value['message'])
                self.refresh()
            elif kind in ('warning', 'error'):
                self.log(value)
                if kind == 'error':
                    self.foot.set('Ошибка: ' + value)
            elif kind == 'voice' and not value:
                self.log('Русский голос Windows не найден. Подтверждения остаются текстовыми.')
            elif kind == 'latency':
                self.foot.set(f'Распознавание: {value} с · CPU · AEC не включён')
            elif kind == 'stopped':
                self.status.set('Микрофон выключен')
                self.score.set(0)
            elif kind == 'show':
                self.root.deiconify()
            elif kind == 'quit':
                self.quit()
            elif kind == 'pause':
                self.stop()
        if not self.speech_queue.empty() and not self.speech_busy.is_set():
            self.speak_without_microphone()
        if self.closing or time.monotonic() - self.last_due_check < 1:
            return
        self.last_due_check = time.monotonic()
        for reminder in self.store.due():
            if reminder['id'] in self.announced:
                continue
            self.announced.add(reminder['id'])
            text = reminder['text']
            self.log('Напоминание: ' + text)
            self.foot.set('Напоминание: ' + text[:90])
            if self.tray:
                try:
                    self.tray.notify(text[:240], 'Jarvis Local: напоминание')
                except Exception as exc:
                    self.log('Уведомление Windows недоступно: ' + str(exc))
            import winsound
            winsound.MessageBeep(winsound.MB_ICONASTERISK)
            if self.tts.get():
                spoken = (reminder['id'], 'Напоминание. ' + text)
                if self.engine.running and not self.engine.stop_event.is_set():
                    self.engine.output.put(spoken)
                else:
                    self.speak_without_microphone(spoken)
            # Keep overdue entries until explicit acknowledgment; a toast may be hidden.

    def speak_without_microphone(self, item=None):
        if item is not None:
            self.speech_queue.put(item)
        if self.speech_thread and self.speech_thread.is_alive():
            return
        self.speech_busy.set()

        def speak():
            import pythoncom
            pythoncom.CoInitialize()
            try:
                speaker = Speaker()
                if not speaker.setup():
                    self.events.put(('warning', 'Русский голос Windows недоступен.'))
                    return
                while not self.closing:
                    try:
                        id, text = self.speech_queue.get_nowait()
                    except queue.Empty:
                        break
                    if any(row['id'] == id for row in self.store.pending()):
                        speaker.say(text, self.shutdown_speech)
            except Exception as exc:
                self.events.put(('warning', 'Ошибка голоса: ' + str(exc)))
            finally:
                pythoncom.CoUninitialize()
                self.speech_busy.clear()

        self.speech_thread = threading.Thread(target=speak, name='reminder-voice', daemon=True)
        self.speech_thread.start()

    def start_tray(self):
        import pystray
        from PIL import Image, ImageDraw
        image = Image.new('RGB', (64, 64), '#137c66')
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((25, 10, 39, 37), radius=7, fill='white')
        draw.arc((17, 20, 47, 46), 0, 180, fill='white', width=4)
        draw.line((32, 45, 32, 54), fill='white', width=4)
        draw.line((23, 54, 41, 54), fill='white', width=4)
        menu = pystray.Menu(
            pystray.MenuItem('Открыть', lambda *_: self.events.put(('show', None)), default=True),
            pystray.MenuItem('Выключить микрофон', lambda *_: self.events.put(('pause', None))),
            pystray.MenuItem('Выход', lambda *_: self.events.put(('quit', None))))
        self.tray = pystray.Icon('Jarvis Local', image, 'Jarvis Local', menu)
        threading.Thread(target=self.tray.run, name='voice-tray', daemon=True).start()

    def hide(self):
        if self.tray and self.tray.visible:
            self.root.withdraw()
        elif not self.test:
            self.log('Значок трея ещё не готов; окно оставлено открытым.')

    def quit(self):
        if self.closing:
            return
        self.closing = True
        self.want_listen = False
        self.shutdown_speech.set()
        self.engine.stop()
        self.status.set('Завершение…')
        self.finish_quit()

    def finish_quit(self):
        if self.engine.running or self.speech_busy.is_set():
            self.root.after(100, self.finish_quit)
            return
        if self.tray:
            self.tray.stop()
        self.root.destroy()


def main():
    import win32api
    import win32event
    mutex = win32event.CreateMutex(None, False, 'Local\\JarvisLocalPersonalAssistant')
    if win32api.GetLastError() == 183:
        root = tk.Tk()
        root.withdraw()
        messagebox.showinfo('Jarvis Local', 'Приложение уже запущено. Откройте его через значок в трее.')
        root.destroy()
        return
    root = tk.Tk()
    App(root, background='--background' in sys.argv)
    root.mainloop()
    win32api.CloseHandle(mutex)


if __name__ == '__main__':
    main()
