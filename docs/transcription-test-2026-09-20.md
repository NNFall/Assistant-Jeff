# Gemini 3.5 Transcribe: синтетический MP3 smoke

Проверка завершена 2026-09-19 20:20 UTC / 2026-09-20 00:20 Europe/Samara.
Пользователь разрешил реальные API-запросы. Выполнено ровно три запроса
транскрипции; пользовательские записи и микрофон не использовались.

## Результат

**3/3 HTTP 200, status=completed.** Dedicated-модель `gemini-3.5-transcribe`
фактически принимает MP3 inline через Interactions без Files upload.

Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/interactions`.
Запрос: `model`, `store:false`, `input:[{type:"audio", mime_type:"audio/mp3",
data:"<base64 MP3>"}]`. Дополнительного текстового промпта и language hint не было.

Исходная синтетическая команда Microsoft Irina Desktop (Windows SAPI):

> Джарвис, напомни мне через десять минут проверить чайник.

Ответ во всех трёх запросах:

> Джарвис, напомни мне через 10 минут проверить чайник.

MP3: 5.323688 секунды, 43 532 байта, mono 16 kHz, 64 kbps.

| Запрос | Отдельный Files upload | HTTP API, включая inline-передачу | Всего на US-хосте |
|---|---:|---:|---:|
| 1 | 0 мс | 2004 мс | 2004 мс |
| 2 | 0 мс | 1598 мс | 1599 мс |
| 3 | 0 мс | 1495 мс | 1496 мс |

Медиана API: **1598 мс**. Нельзя отделить передачу inline-аудио от обработки
модели по этому замеру: обе входят в один HTTP roundtrip. Соединение urllib
создавалось заново для каждого запроса.

Эти времена **не включают** произнесение команды, локальную паузу VAD,
MP3-кодирование, SSH bootstrap и путь desktop → сервер. При паузе завершения
две секунды ожидаемая сумма после последней речи на основе этого единственного
клипа — около 3.5–4 секунд плюс перечисленные накладные расходы; это оценка,
не измерение сквозного голосового сценария. Три одинаковых синтетических
запроса не характеризуют качество на живой речи и p95 сервиса.

## Изоляция и воспроизведение

- Скрипт: `scripts/test-gemini-transcription-smoke.py`.
- Локальная диагностика: `work/transcription-smoke/result.json`.
- Аудио: `work/transcription-smoke/command.mp3` и исходный WAV.
- Ключ прочитан в памяти одноразового Python-процесса на существующем US-хосте
  из существующего env. В исходники, отчёт и stdout ключ не попадал.
- Удалённых файлов аудио не создавалось; Files API не понадобился.
- `store:false` был отправлен во всех запросах; фактическую политику хранения
  внутри провайдера тест не проверяет.
- Серверные файлы, сервисы и установленное приложение не изменялись.

Официальные источники:

- https://ai.google.dev/gemini-api/docs/transcribe
- https://ai.google.dev/api/interactions-api
- https://ai.google.dev/gemini-api/docs/interactions-overview#data-storage-and-retention

## Повторение теста (запускает реальные платные запросы)

Нужны Windows PowerShell, установленный русский SAPI-голос, FFmpeg, Python 3,
OpenSSH и заранее проверенный SSH-host в known_hosts. Создание клипа локальное,
без микрофона. Выполнять из корня проекта:

```powershell
New-Item -ItemType Directory -Force '.\work\transcription-smoke' | Out-Null
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $synth.SelectVoice('Microsoft Irina Desktop')
    $synth.SetOutputToWaveFile([IO.Path]::GetFullPath('.\work\transcription-smoke\command.wav'))
    $synth.Speak('Джарвис, напомни мне через десять минут проверить чайник.')
} finally {
    $synth.Dispose()
}
ffmpeg -hide_banner -loglevel error -y -i '.\work\transcription-smoke\command.wav' -ar 16000 -ac 1 -c:a libmp3lame -b:a 64k '.\work\transcription-smoke\command.mp3'
```

Затем явно указать собственные SSH-параметры и путь существующего env
с `APP_GEMINI_API_KEY` или `GEMINI_API_KEY`. Пример содержит placeholders;
`--report` выбрать новый, чтобы сохранить предыдущий замер:

```powershell
python '.\scripts\test-gemini-transcription-smoke.py' --audio '.\work\transcription-smoke\command.mp3' --ssh-host 'USER@HOST' --ssh-key 'C:\PATH\TO\PRIVATE_KEY' --remote-env '/ABSOLUTE/PATH/TO/EXISTING.env' --report '.\work\transcription-smoke\new-result.json'
```

Скрипт не создаёт аудио самостоятельно. Фиксированные reference/source в отчёте
относятся именно к приведённому синтетическому клипу; другой файл потребует
корректировки этих метаданных перед сравнением качества. SSH запускается
без shell-интерполяции, удалённая команда всегда `python3 -`, путь env
передаётся внутри stdin как Python-строка. `--help` безопасен и не обращается
к сети.
