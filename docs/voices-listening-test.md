# Локальные голоса: образцы для прослушивания

**Выбор пользователя: Piper Denis.** Другие голоса больше не ищем. Выбор зафиксирован для будущей интеграции; Denis не включён автоматически в установленном приложении, его настройки не изменены.

20 сентября 2026. Подготовлены одинаковые русские WAV-образцы Piper Denis, Piper Dmitri и Windows SAPI Irina. Микрофон и облачные API не использовались; звук автоматически не воспроизводился. Настройки установленного Assistant Jeff не менялись.

Финальные файлы находятся в `C:\Users\User\Documents\Codex\2026-09-19\assistant-jeff\outputs\voices`: `piper-denis.wav`, `piper-dmitri.wav`, `sapi-irina.wav`, `sample-text.txt`, `piper-metrics.json`, `sapi-metrics.json`. Аудио не включается в Git.

| Голос | Длина WAV | Синтез | Загрузка модели | Вес ONNX | Размер WAV |
|---|---:|---:|---:|---:|---:|
| Piper Denis medium | 30,128 с | 1,990 с | 3,616 с | 63 201 294 байта | 1 328 684 байта |
| Piper Dmitri medium | 25,426 с | 1,391 с | 3,922 с | 63 201 294 байта | 1 121 324 байта |
| SAPI Microsoft Irina Desktop, Rate=1 | 40,502 с | 0,330 с | отдельно не измерялась | системный голос | 1 786 178 байт |

Piper измерен на CPU, один запуск каждого голоса, default runtime settings; это не устойчивый benchmark и не замер peak RAM/CPU load. Синтез измерен отдельно от загрузки модели, без воспроизведения. Оба нейронных голоса сгенерировали запись быстрее её длительности. У SAPI для попадания в 25–45 секунд выбран Rate=1; у Piper скорость по умолчанию. Все три дорожки: mono PCM16, 22050 Hz; программно проверены ненулевые frames, длительность, peak/RMS и SHA-256. Качество произношения и предпочтение тембра должен оценить пользователь прослушиванием; автоматическая проверка не заменяет это.

## Воспроизведение генерации

Использован официальный Windows wheel `piper-tts==1.8.0` в отдельной `work/tts/venv`. Это вспомогательный генератор аудиопроб, не переход конечного Electron-приложения на Python. Текущий официальный release имеет Windows wheel, но не standalone EXE; для финального native sidecar возможен официальный C API `libpiper` с отдельной Windows-сборкой.

```powershell
py -3.12 -m venv work\tts\venv
work\tts\venv\Scripts\python.exe -m pip install piper-tts==1.8.0
work\tts\venv\Scripts\python.exe scripts\voice-samples.py --out "C:\Users\User\Documents\Codex\2026-09-19\assistant-jeff\outputs\voices"
powershell.exe -NoProfile -NonInteractive -File scripts\voice-samples-sapi.ps1 -OutputDirectory "C:\Users\User\Documents\Codex\2026-09-19\assistant-jeff\outputs\voices"
```

До запуска Piper нужны ровно два комплекта `.onnx` + `.onnx.json` в `data/tts/piper`: `ru_RU-denis-medium`, `ru_RU-dmitri-medium`. Их получили с официального [каталога Piper voices](https://huggingface.co/rhasspy/piper-voices/tree/main/ru/ru_RU). Файлы модели и runtime игнорируются Git. Скрипт не скачивает и не исполняет команды из озвучиваемого текста. Фраза с будильником 23:30 и открытием Chrome — только тест произношения, не заявление о выполнении этих действий.

Исходники/лицензии: [Piper 1.8.0](https://github.com/OHF-Voice/piper1-gpl/releases/tag/v1.8.0), [native C API](https://github.com/OHF-Voice/piper1-gpl/blob/main/libpiper/README.md), [Denis card](https://huggingface.co/rhasspy/piper-voices/blob/main/ru/ru_RU/denis/medium/MODEL_CARD), [Dmitri card](https://huggingface.co/rhasspy/piper-voices/blob/main/ru/ru_RU/dmitri/medium/MODEL_CARD). Движок GPL-3.0; обе карточки указывают dataset CC0. Условия остальных голосов нельзя автоматически считать теми же.
