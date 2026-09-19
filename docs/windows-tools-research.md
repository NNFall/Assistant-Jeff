# Windows computer-use: готовые инструменты

Исследование проверено 20 сентября 2026, read-only. В рамках сравнения репозитории не запускались. Затем отдельно был построен [Windows Lab](windows-lab.md) на FlaUI; его результаты не распространяются на другие библиотеки, Яндекс Браузер или смешанный DPI.

## Практический выбор

Для Electron без Python: основной библиотечный вариант — отдельный C# процесс с **FlaUI.UIA3**, узким JSON IPC и нашим циклом Jev. Но до реализации всего адаптера стоит проверить **Microsoft winapp CLI**: `winapp ui` уже имеет inspect/search/invoke/set-value и JSON-вывод в опубликованном теге v0.6.0. Это потенциально готовый observer/executor, а не очередной LLM-агент. Существование команд подтверждено исходниками тега; пригодность для нашего приложения пока гипотеза. [FlaUI](https://github.com/FlaUI/FlaUI), [winapp v0.6.0 UI documentation](https://github.com/microsoft/winappCli/blob/v0.6.0/docs/ui-automation.md).

Jev остаётся выбирающим компонентом: инструменты ниже сами не делают его мультимодальным и не решают проверку достижения произвольной цели. Адаптер должен возвращать наблюдаемые элементы и доступные patterns; наш код формирует кандидатов и после исполнения повторно проверяет состояние.

Сам факт отправки Invoke не доказывает успех. Для тестового окна реализованы узкие независимые проверки selectedTab/playing. Проверяемая спецификация произвольной пользовательской цели — отдельная нерешённая задача; общий UIA bridge сам её не предоставляет.

## Сравнение

Версии — latest GitHub release на дату проверки; pushed — метаданные репозитория, не доказательство качества или регулярности сопровождения. Лицензии — GitHub SPDX и LICENSE репозиториев; зависимости проверяются отдельно перед включением в дистрибутив.

| Проект | Runtime / лицензия | Release; последний push | Вывод для Jeff |
|---|---|---|---|
| [FlaUI](https://github.com/FlaUI/FlaUI/releases) | .NET, UIA2/UIA3; MIT | v5.0.0, 25.02.2025; 13.08.2026 | Лучший базовый вариант для собственного долгоживущего C# sidecar; библиотека, не готовый агент. |
| [pywinauto](https://github.com/pywinauto/pywinauto/releases) | Python, Win32/UIA; BSD-3-Clause | 0.6.9, 06.01.2025; 23.05.2026 | Зрелый reference/инструмент экспериментов, но против требования убрать Python из runtime. |
| [Windows-MCP](https://github.com/CursorTouch/Windows-MCP/releases) | Python; MIT | v0.8.5, 01.08.2026; 16.09.2026 | Готовый MCP bridge с UIA snapshot/actions; более широкий набор полномочий и зависимостей, чем нам нужен. |
| [Windows-Use](https://github.com/Jeomon/Windows-Use/releases) | Python; MIT | v0.8.1, 30.04.2026; 07.07.2026 | Готовый агент поверх accessibility/tools, не лёгкая native библиотека. CursorTouch URL перенаправляет сюда. |
| [Microsoft UFO](https://github.com/microsoft/UFO/releases) | Python; MIT | v3.0.9, 14.09.2026; 15.09.2026 | Полная многоагентная система, Windows UIA/Win32/COM; UFO³ добавляет multi-device orchestration. Слишком большой готовый runtime для малого Electron-приложения. |
| [Microsoft winappCli](https://github.com/microsoft/winappCli/releases) | .NET; MIT | v0.6.0, 12.08.2026; 19.09.2026 | Готовые UIA CLI-команды. Main также предлагает .NET API; доступность конкретного NuGet и совпадение API с release надо проверить отдельно. |
| [Seeless-UIA](https://github.com/yaki1210/Seeless-UIA) | .NET 10, CLI + TCP daemon; MIT | GitHub release не найден; push 03.06.2026 | Близкий готовый native мост: snapshot refs, patterns, window registry. Меньше истории сопровождения; IPC и жизненный цикл refs требуют ревью. |
| [WinAppDriver](https://github.com/microsoft/WinAppDriver/releases) | Windows server, WebDriver; MIT | v1.2.1, 05.11.2020; push 14.04.2025 | Не основной выбор нового проекта: опубликованный стабильный релиз старый; это не утверждение, что весь проект заброшен. |

## Что прочитано в коде

**FlaUI:** [Keyboard.cs](https://github.com/FlaUI/FlaUI/blob/main/src/FlaUI.Core/Input/Keyboard.cs) использует `KEYEVENTF_UNICODE` для Unicode-символов; кириллица не требует эмуляции русской физической раскладки. Для текстовых полей предпочтительнее ValuePattern с чтением результата. Наличие Unicode-пути не доказывает ввод во все приложения, IME или корректность surrogate pairs. [pywinauto keyboard.py](https://github.com/pywinauto/pywinauto/blob/master/pywinauto/keyboard.py) также документирует Unicode на Windows.

**Windows-MCP:** [tree/service.py](https://github.com/CursorTouch/Windows-MCP/blob/main/src/windows_mcp/tree/service.py) читает UIA, поддерживает бюджет дерева, ищет `RootWebArea` для browser extraction. Название DOM mode не означает чтение настоящего DOM через CDP. [desktop/service.py](https://github.com/CursorTouch/Windows-MCP/blob/main/src/windows_mcp/desktop/service.py) длинный простой текст вводит через clipboard paste; есть восстановление предыдущего текстового clipboard. Это не гарантия сохранения всех clipboard-форматов. В [Browser enum](https://github.com/CursorTouch/Windows-MCP/blob/main/src/windows_mcp/desktop/views.py) перечислены Chrome, Edge, Firefox, Яндекс не заявлен: специальный browser mode может потребовать добавления определения процесса. README предлагает ограничивать набор tools; не нужно переносить PowerShell/Registry/FileSystem целиком в Jev action space.

**winapp:** [UIA documentation](https://github.com/microsoft/winappCli/blob/main/docs/ui-automation.md) описывает re-resolve, ambiguous-selector errors и `target_moved`. [KeyboardInput.cs](https://github.com/microsoft/winappCli/blob/main/src/winapp-CLI/WinApp.UIAutomation/Input/KeyboardInput.cs) содержит Unicode SendInput. [UIAutomation.csproj](https://github.com/microsoft/winappCli/blob/main/src/winapp-CLI/WinApp.UIAutomation/WinApp.UIAutomation.csproj) main нацелен на .NET 10 Windows. Это конкретно прочитанный main, не обещание такой же структуры пакетов v0.6.0.

## Русский интерфейс, мониторы и браузеры

UIA возвращает локализованные имена; не следует искать только английские подписи. AutomationId/runtime identity и control patterns полезнее жёсткого текста. RuntimeId нельзя считать вечным ID после перестроения интерфейса. Для Unicode IPC задаём UTF-8 явно.

UIA bounding rectangles — физические координаты. Electron screen использует DIP, поэтому прямое смешение координат опасно; нужен DPI-aware helper и явное преобразование для каждого монитора. Тестировать 100/150%, отрицательные координаты и перенос окна между мониторами. Patterns Invoke/Selection/Value позволяют вообще обходиться без координат. [Microsoft UIA scaling](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-screenscaling).

Chromium exposing accessibility не гарантирует одинаковую полноту у Chrome, Electron и Яндекса. UIA зависит от provider, видимости/виртуализации и состояния приложения; canvas не превращается автоматически в кнопки. Для точного списка вкладок браузерное расширение с tabs API остаётся более определённым каналом. Нельзя обещать Яндекс по факту поддержки Chrome. [Chromium UIA explainer](https://github.com/MicrosoftEdge/MSEdgeExplainers/blob/main/Accessibility/UIA/explainer.md).

## Jev + Windows и X

Целевые поиски `Jev Windows computer use GitHub`, `site:x.com "Jev" "Windows"`, `site:github.com "Jev" "Windows-MCP"` не дали подтверждённого исходниками готового Windows+Jev проекта. Это ограниченный результат поиска, не доказательство отсутствия. Ранее проверенные ссылки пользователя ведут к macOS/DOM примерам и каталогу проектов; новый Windows-ролик не найден и никакие ролики не просмотрены. [Studio Yebisu](https://x.com/studio_yebisu/status/2101065176069886152), [Saccc_c](https://x.com/Saccc_c/status/2100833094291087773).

Следующий минимальный технический шаг: сравнить read-only snapshot одного окна через FlaUI и winapp, затем выбрать один backend; проверить русский текст, вкладки Яндекса и второй монитор. Только после этого подключать типизированное исполнение к уже существующему циклу Jev. Никакой из исследованных README не заменяет эти проверки.
