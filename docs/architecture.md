# Архитектура Assistant Jeff 0.6

Этот документ описывает агентный контур версии 0.6, собранной и установленной 20 сентября 2026 года. Проверки и ограничения перечислены в README; наличие общего набора инструментов не означает совместимость с любым приложением Windows.

## Основной путь

```text
Renderer: текстовая команда или финальная голосовая транскрипция
                    |
                    v
desktop/audio/session.mjs -> AgentCommands
                    |
        typed tools + /agent через GeminiGateway
                    |
   model functionCall -> LocalToolRegistry -> receipt
                    |                         |
                    +---- следующий шаг <----+
                              |
                  assistant_respond (единственный финал)
                              |
                    report -> UI -> Denis
```

`AgentCommands` (`desktop/agent/commands.mjs`) владеет одним запуском: ограничивает шаги и вызовы, создаёт локальный registry, проверяет аргументы по JSON Schema, передаёт каждый вызов выбранному инструменту и возвращает модели нормализованный receipt. Для эффекта важны `ok`, `verified`, `effectAttempted`, `evidence` и `data`; неопределённый эффект останавливает цикл, а повторять его вслепую нельзя. Модель не получает shell, произвольный код, путь, HWND или сырой CLI-аргумент.

После изменения состояния следующий шаг должен сначала получить свежий readback. Для Windows это означает: наблюдение → один выбранный action → native receipt → повторное наблюдение. Устаревший target переводит запуск в re-observe/stale; uncertain effect остаётся отдельным исходом.

## Gemini и контекст

`desktop/providers/gemini.mjs` отправляет типизированные `contents`, `tools` и небольшой `context` в `/agent`. `server/agent-model.mjs` проверяет структуру запроса и ответа, строит обычный Gemini `generateContent` payload и возвращает function calls; gateway не читает SQLite и не выполняет Windows-действия. Модель по умолчанию — `gemini-3.1-flash-lite`; значение `JEFF_AGENT_MODEL` может выбрать другой агентский alias через тот же gateway.

Внутренний контекст ограничен восемью последними ходами, 24 KiB и TTL 30 минут. Старые записи передаются как справка, не как разрешение; сохранённые entity ID перечитываются перед новым эффектом. Кнопка очистки вызывает `clearContext` и начинает следующий запрос с пустой историей. Набор инструментов строится заново для каждого запуска, поэтому статус возможности в readable details отражает именно этот запуск.

Вызов `assistant_respond` обязан быть единственным финальным function call. Для `completed` нужны идентификаторы проверенных receipts; `answer`, `clarification` и `incomplete` явно описывают результат через тот же финальный вызов. После изменения состояния финал без readback не считается успехом; ответ без изменения Windows всё равно проходит через `assistant_respond`.

## Локальные инструменты

`main.mjs` собирает инструменты из `desktop/agent/data-tools.mjs`, `windows-tools.mjs`, `system-tools.mjs` и optional `winapp-tools.mjs`.

- Заметки имеют `notes_search`, `note_get`, `note_create`, `note_update`, `note_delete`. Напоминания имеют поиск, чтение, создание, изменение, удаление и завершение. Изменение или удаление разрешается только после чтения цели в текущем запуске и точной передачи `expectedText` (для напоминания также `expectedDueAt`). После записи Store перечитывается и receipt содержит результат проверки.
- `clock_now` сообщает актуальное локальное/UTC-время, а `time_resolve` рассчитывает срок из явных typed-компонентов. Отсутствующий день или час не угадывается; неоднозначный срок сначала становится уточнением.
- Системные инструменты ограничены чтением/установкой громкости через native CoreAudio и сворачиванием собственного окна Jeff. Windows helper остаётся владельцем native аргументов и readback.

Пример безопасного сценария: «найди заметку про хлеб, измени её на “купить хлеб и молоко”». Агент сначала ищет и читает запись, затем передаёт старый текст как `expectedText`, обновляет её и проверяет новую запись. Если запись изменилась между шагами, инструмент возвращает stale и не перезаписывает чужое состояние.

## Windows-адаптеры

### Проверенный базовый путь

Существующий C# helper на FlaUI/UIA3 сохраняет каталог допустимых окон, наблюдение Win32/UIA, фиксированные операции окна, allowlisted launch и системные fallback-пути. `windows_choose` — необязательный read-only шаг Jev для выбора одного уже наблюдаемого кандидата. Он не выполняет действие и не генерирует selector; `windows_execute` принимает только action ID и snapshot version из свежего наблюдения.

Для обычного UIA-текста уже подключён отдельный native text worker. После свежего `windows_observe` инструмент `windows_text_fields` читает ограниченный набор доступных для записи `ValuePattern`-полей в одном неминимизированном окне. Обычные значения возвращаются модели по запросу инструмента; поля пароля, секретные значения и чувствительный контекст исключаются. Фокус для этого пути не требуется. `windows_text_replace` принимает только `snapshotVersion`, `fieldId` и ограниченный литерал, заменяет всё поле через `ValuePattern.SetValue` без нажатия клавиш и подтверждает эффект только после точного readback. Проверка связывает процесс и время его запуска, отпечаток окна, UIA runtime ID и хеш предыдущего значения; receipt содержит длину и `valueHash`, а stale/identity/value mismatch блокирует действие.

### Новый native UIA путь

`desktop/agent/winapp-tools.mjs` — отдельный typed adapter поверх pinned Microsoft `winappCli v0.6.1`. Он нормализует список окон, UIA tree/search и opaque action IDs для `select`, `toggle`, `expand`, `scroll` и `invoke`; модели не передаются raw selector/HWND, а команды не проксируются как произвольная строка. `invoke` даёт только dispatch receipt и требует повторного наблюдения; stateful patterns требуют postcondition readback.

Для Electron выбран standalone native x64 runtime, подготавливаемый `scripts/prepare-winapp-runtime.ps1`. Ветка не требует Python; архив и schema pin должны совпадать с адаптером. Наличие бинарника лишь включает capability: оно ещё не является заявлением о полном Windows coverage или о завершённом release smoke.

UIA зависит от provider, виртуализации, состояния окна и interactive desktop. Canvas, недоступные accessibility-элементы, locked session, foreground restrictions и приложения с нестандартными provider могут не поддержать этот путь. В таких случаях инструмент честно возвращает unavailable/stale/uncertain, а не переходит к координатам или shell.

### Граница безопасности

Ни один агентский инструмент не принимает произвольный PowerShell, shell, process, registry, filesystem, clipboard, URL или сгенерированный shortcut. Browser DOM — отдельный Playwright-адаптер с отдельной границей вкладки; он не становится способом управления произвольными native окнами. Новое приложение запускается только через существующий каталог и native allowlist.

## Голос и озвучка

`VoiceSession` объединяет typed и voice запуск, но текстовая команда не включает микрофон. Live-путь использует PCM16 mono 16 kHz; при подключении сохраняется ограниченный буфер примерно на две секунды. Тишина по умолчанию завершает реплику через две секунды, а промежуточная транскрипция остаётся display-only. Только финальный текст после завершения реплики попадает в `AgentCommands`; поздние события старой операции отбрасываются.

Denis остаётся локальным Piper-ответом. Он получает только финальный проверенный/честно обозначенный результат и не запускает микрофон, новый tool call или дополнительный эффект. Ошибка озвучки не меняет уже полученный report.

## Gateway и интерфейс

Renderer работает через ограниченный preload API с `contextIsolation`, sandbox и отключённой Node integration. Основная логика, registry, native helper и запуск pinned runtime остаются в Electron main. Gateway — stateless модельный посредник: он валидирует JSON, вызывает Gemini и возвращает candidate function calls; Windows-код выполняется только локальным typed registry.

Readable details отделяет capabilities текущего запуска, исходное наблюдение и его coverage, decisions, tool calls/receipts, agent responses и conversation-turn count. В него не попадают скрытые рассуждения и необработанные opaque signatures. Голосовой журнал не сохраняет аудиобайты или interim-гипотезы.

## Статус evidence

Подтверждено чтением текущих исходников: wiring `AgentCommands` → typed tools → `/agent`, ограничения контекста, `clearContext`, data-tool guards, optional `winapp` capability и pinned runtime script. Синтетический function-call probe с задержкой 1199 мс — это один вызов модели/инструмента, а не полный пользовательский desktop task и не измерение микрофона.

Не следует считать подтверждёнными до отдельного root evidence: готовность установленного runtime, полный `winappCli` smoke на реальных приложениях, универсальность UIA, native text smoke на реальных приложениях, locked-session/foreground поведение и итоговые test counts. Исторические детали 0.5 оставлены в [старых исследованиях](jev-architecture-research-2026-09-20.md) и [описании Windows helper](windows-desktop.md); они не ограничивают новый 0.6-контракт там, где текущий source уже расширен.

Исследование готовых Windows framework/runtime: [windows-frameworks-2026-09-20.md](windows-frameworks-2026-09-20.md).
