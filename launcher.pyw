"""Windowless entry point with local crash reporting."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
(ROOT / 'data').mkdir(exist_ok=True)
with (ROOT / 'data/runtime.log').open('a', encoding='utf-8', buffering=1) as log:
    sys.stdout = log
    sys.stderr = log
    try:
        from app import main
        main()
    except Exception:
        import traceback
        traceback.print_exc()
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, str(ROOT / 'data/runtime.log'),
                                        'Jarvis Local: ошибка запуска', 16)
