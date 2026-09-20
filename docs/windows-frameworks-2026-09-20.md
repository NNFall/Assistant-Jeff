# Windows framework/runtime research — 20.09.2026

Это read-only исследование готовых Windows-инструментов для Assistant Jeff. Репозитории, release metadata, исходники и официальные docs прочитаны; пакет не устанавливался, native UI и microphone не запускались, browser session и credentials не открывались. Поэтому «verified» ниже означает проверку исходника/артефакта, а не локальный end-to-end smoke.

## Решение для текущего 0.6

Первым широким adapter стоит использовать native Microsoft `winappCli`, а existing FlaUI/C# helper сохранить как safety anchor для display inventory, allowlisted app launch, оконных операций и fallback. Модель должна видеть typed opaque IDs и receipts из собственного Electron registry. Browser automation остаётся отдельным Playwright adapter.

Windows-MCP полезен как второй sidecar после отдельного packaging spike. Он шире по готовым инструментам, но upstream не публикует Windows exe; `py3-none-any` wheel лишь подтягивает большой Python/native dependency graph. Это не причина заменять уже понятный C# runtime Python-слоем до проверенного build/smoke.

## Сравнение пригодных вариантов

| Вариант | Что подтверждено в primary source | Runtime и граница | Решение |
| --- | --- | --- | --- |
| **Microsoft winappCli v0.6.1** | Native UI Automation для WPF/WinForms/Win32/Electron/WinUI3; `inspect`, `search`, `invoke`, `set-value`, `wait-for`, `scroll`, `click`, `send-keys`, `list-windows`; JSON output | Standalone x64/arm64 ZIP, MSIX и NPM tarball; MIT, `win32`, Node >=18. Не является LLM-agent и не получает policy из коробки | **Рекомендуемый broad adapter**: policy и Jev остаются в Jeff, Python не нужен |
| **Windows-MCP v0.8.5** | MCP stdio; `Snapshot`, `DisplayInventory`, `Click`, `Type`, `Scroll`, `WaitFor`, `Shortcut`, `App`, `Scrape` и другие инструменты | MIT, Python >=3.12 в pinned tag, wheel/sdist без exe; в lock около 99 записей, включая native Windows deps. PowerShell/FileSystem/Process/Registry требуют исключения | **Опциональный sidecar** после controlled packaging; safe subset сначала `Snapshot,Click,Type,Scroll,WaitFor,DisplayInventory` |
| **FlaUI/C# helper** | Текущий helper уже даёт Win32/UIA3 inventory, candidate IDs, проверку identity и fixed operations; wrapper принадлежит проекту | Native sidecar без Python, уже согласован с Electron IPC и fixture-проверками | **Оставить safety fallback** и не заменять новым runtime |
| Playwright MCP/extension | Structured browser accessibility/DOM/screenshot; extension attaches existing Chrome/Edge tab | Отдельная browser/session boundary; не умеет произвольные native windows | Отдельный browser adapter |
| Microsoft UFO / OmniParser / pywinauto | UFO — тяжёлая Python agent framework; OmniParser — visual parser/coordinates; pywinauto — Python UIA/Win32 library | Дополнительные модели, Python и собственная policy surface; OmniParser не заменяет UIA patterns | Reference/fallback, не текущий runtime |

OVOS и Home Assistant Assist подходят как voice/intent bus для smart-home сценариев, но не являются Windows UIA executor. Rhasspy полезен как историческая offline voice reference, но его upstream repository archived; новый runtime на нём строить не следует.

## Microsoft winappCli: что брать в adapter

### Provenance и packaging

Официальный репозиторий — [microsoft/winappCli](https://github.com/microsoft/winappCli), лицензия MIT. Для 0.6 зафиксирован release tag `v0.6.1`, standalone asset `winappcli-x64.zip`; release также публикует arm64/MSIX и NPM tarball. `scripts/prepare-winapp-runtime.ps1` pins version, release commit, archive/license hashes, извлекает `winapp.exe` и native dependency, сохраняет CLI schema и manifest, а затем способен выполнить только read-only `--version`/`ui list-windows --json` smoke. Сам факт наличия script/asset ещё не является evidence завершённого runtime smoke.

NPM usage docs описывают wrapper, который возвращает `{exitCode, stdout, stderr}`; JSON не превращается автоматически в доверенную моделью структуру. Поэтому adapter должен сам ограничить args, parse stdout, проверить exit code/schema и вернуть собственный typed result. Модель никогда не строит командную строку.

### JSON contracts, на которых строится parser

- `ui list-windows --json` — массив `{hwnd, processId, processName, title, label, width, height, ownerHwnd, className, isForeground}`.
- `ui inspect --json` — объект `{depth, interactive, hideDisabled, hideOffscreen, windows:[{hwnd,title,className,elementCount,elements}]}`. Элемент содержит `type`, `name`, `automationId`, `className`, `isEnabled`, `isOffscreen`, bounds, public `selector`, optional pattern state, children и `isInvokable`.
- `ui search --json` в source v0.6.1 — `{matchCount, hasMore, matches:[element]}`. В prose envelope reference встречается bare array; parser должен принять только явно поддержанную compatibility shape и не обходить проверку.
- `ui wait-for --json` — `{found, waitedMs, timedOut?, element?}`; исчезновение цели — `{found:false, waitedMs}`.
- `ui invoke --json` — `{elementId, pattern, hwnd}`; `ui set-value` и `ui scroll` возвращают соответствующие `elementId`/`hwnd` и operation fields. JSON error приходит с `{error:{code,message,...}}` и nonzero exit.

В release нет отдельных `select`, `toggle` и `expand` CLI-команд. `invoke` выбирает доступный UIA pattern; `get-property` читает `ToggleState`/`ExpandCollapseState`. Поэтому продуктовые action IDs для select/toggle/expand — это нормализация в adapter, а не придуманные model selectors.

Source nuance: inspect/search могут продвигать уникальный AutomationId в public selector, тогда как exact lookup action может вернуть canonical runtime slug. Сравнивать такой `elementId` с исходным AutomationId нельзя; adapter привязывает candidate к окну и повторно разрешает selector перед одним effect. После перестройки UI stale slug требует нового observation.

### Ограничения и password caveat

UIA pattern calls могут работать без foreground injection, но click/wheel/send-input требуют interactive desktop; locked session, provider gaps, virtualized lists, canvas и web surfaces не гарантируют coverage. В текущем Jeff `set-value` остаётся за отдельным bounded native text worker с контрактом свежего наблюдения и readback; его покрытие не расширяет гарантию `winappCli` на произвольные приложения.

В исходнике v0.6.1 вычисление `IsPassword` выглядит подозрительно: оно связано с `IsContentElement` и `Edit`, а не с очевидным native password property. Это source-level caveat, не воспроизведённый runtime bug. Поэтому именно `winappCli`-adapter не публикует editable/password fields и values. Отдельный text worker Jeff самостоятельно проверяет password/identity, поддерживает нефокусированные writable-поля и возвращает обычные значения модели только по запросу; password/secret values исключаются, а замена подтверждается exact readback/hash.

## Windows-MCP: feasibility без системного Python

Release `v0.8.5` публикует wheel `windows_mcp-0.8.5-py3-none-any.whl` и source distribution; exe, PyInstaller spec или ready standalone binary в release/tag не найдено. Pinned tag требует Python `>=3.12`; current main уже расходится по Python requirement, поэтому смешивать main и release нельзя. Lock graph содержит примерно 99 пакетов, среди inspected Windows CPython wheels есть `pywin32`, `dxcam`, `numpy`, `Pillow`, `psutil` и связанные native packages. Из этого следует, что embeddable CPython 3.14 **технически возможен**, но это inference, а не проверенный installer/runtime.

Контракт controlled sidecar выглядит так:

```text
<bundled-python> -m windows_mcp serve --transport stdio --tools "Snapshot,Click,Type,Scroll,WaitFor,DisplayInventory"
```

Если нужен именно исследованный расширенный allowlist из upstream, его stdio-запуск имеет вид:

```text
<bundled-python> -m windows_mcp serve --transport stdio --tools "Snapshot,App,Click,Type,Scroll,Shortcut,WaitFor,DisplayInventory,Scrape"
```

Это не рекомендуемый первый product surface: `App`, `Shortcut` и `Scrape` должны оставаться за отдельными policy gates.

В child environment задаётся `ANONYMIZED_TELEMETRY=false`; stdout оставляется MCP JSON-RPC, stderr — diagnostics. `App` лучше оставить существующему allowlisted catalog, потому что upstream launch принимает path/argv. `Shortcut` требует fixed product enum, `Scrape` — отдельную browser/network boundary. PowerShell, FileSystem, Process, Registry, unrestricted Clipboard и прочие generic tools в agent registry не попадают.

Если sidecar будет выбран позже, обязательны отдельные checks: embedded runtime/wheelhouse, MCP initialize/list-tools, synthetic window observation, benign pattern action, stdout/stderr separation, clean child termination и update provenance. Ни один из этих steps этим исследованием не запускался.

## Три практических варианта

1. **Рекомендуемый:** `winappCli v0.6.1` + existing FlaUI/C# + typed Jev gate. Даёт native UIA breadth без Python и оставляет shell/registry/process/filesystem за пределами model surface.
2. **Для последующего spike:** Windows-MCP v0.8.5 в embedded Python sidecar с safe allowlist. Он может покрыть snapshot/display/type/wait, но только после собственной упаковки и protocol smoke.
3. **Safety-first:** FlaUI/C# остаётся primary, winapp capability включается feature flag после runtime evidence. OmniParser рассматривается только для UIA-invisible canvas/icon surface и отдельной проверки весов/лицензий.

## Граница доказательств

**Проверено read-only:** primary repositories, tags/releases, package metadata, raw source contracts, licenses/archival flags и wiring текущего Assistant Jeff. **Не проверено запуском:** установка или MCP handshake Windows-MCP, `winapp.exe` на локальном UI, native text smoke на реальных приложениях, Yandex-specific behavior, locked/foreground behavior, universal Windows coverage и latency полного agent task.

Источники: [winappCli v0.6.1 release](https://github.com/microsoft/winappCli/releases/tag/v0.6.1), [UI automation docs](https://github.com/microsoft/winappCli/blob/v0.6.1/docs/ui-automation.md), [NPM usage](https://github.com/microsoft/winappCli/blob/v0.6.1/docs/npm-usage.md), [UI JSON envelope](https://github.com/microsoft/winappCli/blob/v0.6.1/plugins/winapp/skills/winapp-ui-automation/references/ui-json-envelope.md), [NPM registry](https://registry.npmjs.org/@microsoft%2Fwinappcli), [Windows-MCP v0.8.5](https://github.com/CursorTouch/Windows-MCP/tree/v0.8.5), [Windows-MCP pyproject](https://raw.githubusercontent.com/CursorTouch/Windows-MCP/v0.8.5/pyproject.toml), [Windows-MCP lock](https://raw.githubusercontent.com/CursorTouch/Windows-MCP/v0.8.5/uv.lock), [Windows-MCP PyPI metadata](https://pypi.org/pypi/windows-mcp/0.8.5/json), [Playwright MCP](https://github.com/microsoft/playwright-mcp/blob/main/README.md), [Playwright extension](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md), [Home Assistant Assist](https://www.home-assistant.io/voice_control/), [OVOS core](https://github.com/OpenVoiceOS/ovos-core), [Rhasspy archived repository](https://github.com/rhasspy/rhasspy).
