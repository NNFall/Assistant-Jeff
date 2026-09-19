# Архитектура Assistant Jeff 0.2.0

## Контур выполнения

```text
Electron renderer: микрофон → PCM16 mono 16 kHz, кадры 80 мс
        ↓ узкий IPC
Electron main: ONNX openWakeWord локально
        ↓ имя / ручная активация
AssemblyAI WebSocket → сигнал готовности → аудио команды → partial/final
        ↓ только final
AssistantService → Jev intent/app choice → локальная проверка
        ├─ SQLite note/reminder
        ├─ allowlist Windows app launch
        └─ SSH tunnel → private gateway → Gemini text answer
        ↓
Интерфейс, Windows notification, SAPI TTS
```

`desktop/main.mjs` управляет окном, треем, разрешением микрофона, SQLite, IPC и провайдерами. Renderer изолирован: `contextIsolation`, sandbox, без Node integration; доступен только preload API. Переходы окна и новые окна блокируются. Ответ модели не превращается в shell-код.

`desktop/audio/controller.mjs` управляет состояниями off/loading/waiting/connecting/listening/thinking/speaking/error. На stop меняется поколение сессии, поэтому поздние результаты не выполняют локальное действие. Уже отправленный удалённый запрос не обязательно отменится у провайдера. Во время TTS wake-word временно не обрабатывается, затем очищается детектор. Это не AEC.

`desktop/audio/streaming.mjs`: одна реплика на WSS-соединение, PCM16LE 16 kHz, до 15 с подключения и 30 с сессии. Очереди ограничены. `Turn/end_of_turn` — окончательный текст; partial только отображается. По умолчанию `whisper-rt` без `language_codes`: экспериментальный legacy-профиль после реальной синтетической проверки. При ошибке речи команда не исполняется.

## Jev и локальный исполнитель

`desktop/providers/typesafe.mjs` использует официальный `/v1/systemone`, alias `jev-latest`. Последний smoke вернул `jev-1.13.0`. Два типизированных выбора в одном запросе: route и app. Разрешены note/reminder/open_app/chat/unknown и calculator/notepad/browser/explorer/unknown. Проверяются форма ответа, набор labels, вероятности и пороги. Порог — продуктовая эвристика, не разрешение на действие.

`desktop/service.mjs` сопоставляет решение с детерминированным парсером. Содержимое заметки копируется из исходного текста; срок не генерируется Jev. Несогласие/неизвестное намерение запрашивает уточнение. При сетевой ошибке Jev точная локальная команда может выполниться через local-fallback; отказ модели не обходится этим fallback. Gemini не исполняет инструменты.

`desktop/core` содержит парсер и Store. SQLite совместима с исходными notes/reminders. Повтор не дедуплицируется. Просроченные записи показываются после запуска; уведомление не равно завершению напоминания.

## Приватный Gemini gateway

`server/gateway.mjs` — отдельный Node HTTP-сервис на новом VPS, слушающий только loopback. Доступ требует bearer-токен. Приложение создаёт SSH-туннель через `ssh2`, проверяя SHA-256 fingerprint host key. Локальная сторона также слушает только loopback на случайном порту. Шлюз отправляет ограниченный текстовый запрос в Gemini `generateContent`; это пока не потоковая выдача токенов.

На сервере нужны `JEFF_GATEWAY_TOKEN`, `GEMINI_API_KEY`; необязательны `GEMINI_MODEL` (по умолчанию `gemini-3.1-flash-lite`) и `PORT`. Не публиковать HTTP-порт и не сохранять env с ключами в Git. Ответ ограничен 1024 токенами, два параллельных upstream запроса, общий таймаут. Шлюз не читает локальную БД и не имеет инструментов компьютера. Публичные IP и конкретные реквизиты подключения намеренно не входят в документацию.

Клиентский `gateway.json` задаёт `host`, `port`, `username`, `hostHash`, `remotePort` (в текущем адаптере 18741). Хэш должен быть получен доверенным способом при подготовке сервера. Нельзя заменять проверку fingerprint безусловным доверием.

## Хранилище и миграция

Основная папка — `%APPDATA%\Assistant Jeff`:

- `assistant.sqlite`: заметки/напоминания, без шифрования;
- `settings.json`: настройки;
- `gateway.json`: параметры туннеля без ключей;
- `secrets/typesafe.dpapi`, `assemblyai.dpapi`, `gateway-key.dpapi`, `gateway-token.dpapi`: DPAPI CurrentUser.

Development launch при отсутствии целевой БД читает исходную `data/assistant.sqlite` и создаёт консистентную копию через `VACUUM INTO`; оригинал не меняется. Настройки новой оболочки имеют собственные defaults. Уже существующая целевая БД не перезаписывается. Упакованный пакет не включает исходную БД: существующему пользователю перед установкой подготавливается миграция в AppData. Последующие записи Python и Electron не синхронизируются.

`JEFF_DATA_DIR` изолирует проверочную БД и отключает автоматическое копирование реальных данных/секретов. `JEFF_NO_TTS=1` отключает озвучку при smoke. Ключи TypeSafe/AssemblyAI можно предоставить через одноимённые API_KEY environment variables; иначе читается DPAPI. Для текущего пользователя поддержан legacy AssemblyAI secret из Codex. Наличие файла/индикатор провайдера не доказывает кредит или рабочее соединение.

## Сборка и ограничения

`npm run build` → electron-builder NSIS x64, `release/`; runtime включает ONNX и подготовленные модели. Python не нужен новой оболочке. Старые Python файлы и окружение сохранены для офлайн-варианта. Пакет не является универсально настроенным приложением для других пользователей: ключи и приватный gateway provisioned отдельно, полного UI-мастера настройки пока нет.

Автозапуск только по явной настройке установленного приложения; close скрывает окно, tray Exit завершает. Ключи, БД, models, work-артефакты, installers и node_modules не включаются в Git.

Первичные ссылки: [TypeSafe docs](https://docs.typesafe.ai/), [AssemblyAI streaming](https://www.assemblyai.com/docs/streaming), [Gemini API](https://ai.google.dev/gemini-api/docs/text-generation), [openWakeWord](https://github.com/dscripka/openWakeWord), [исследование демо](research-social.md).
