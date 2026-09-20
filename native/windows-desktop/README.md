# Windows desktop product backend

`JeffWindowsDesktopHelper.exe` is the native backend for the product's real Windows mode. It enumerates eligible top-level windows and reads a bounded UI Automation tree for one selected window. It is separate from the existing `desktop-lab` fixture backend; production launches it without a fixture restriction.

Build from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-desktop.ps1
```

Output: `work/windows-desktop/bin/JeffWindowsDesktopHelper.exe`. The build uses the Windows .NET Framework 4.8 compiler, reuses the checked-in SHA-256-pinned FlaUI 5.0.0 manifest, verifies every NuGet archive before extracting it, copies licenses and writes artifact hashes. No global SDK is installed. An optional `-OutputDirectory` must remain inside `work/windows-desktop/`.

## Process and protocol

The caller launches the helper hidden, with redirected UTF-8 standard input/output. Each request and response is one JSON line. The input line limit is 64 KiB. Errors contain stable codes only; exception messages and stack traces are never returned.

```json
{"id":1,"method":"observe","args":{}}
{"id":1,"ok":true,"result":{"version":"…","app":"Windows","summary":"…","elements":[],"windows":[],"facts":{"selectedWindowId":null,"surfaceStatus":"not_inspected"},"metadata":{"provider":"FlaUI.UIA3 5.0.0","monitorCount":2,"truncated":false,"fixtureRestricted":false}}}
```

`observe` keeps the current inspected window. `observe {"windowId":"win_…"}` selects an inventory window and observes its UIA controls without activating it. `observe {"windowId":null}` clears the selection. A selected window that closes is cleared automatically. An explicitly requested unknown window returns `WINDOW_NOT_AVAILABLE`.

The snapshot contains at most 64 windows and 160 UIA control elements (plus window elements). Window objects expose `id`, `title`, `processName`, numeric `processId`, `minimized`, `maximized` and `active`. Every inventory window also appears as a `Window` element. UIA elements expose bounded `name`/`label`, role, selected/toggle/expand state, enabled/offscreen state, window ID, parent group, capabilities and bounding geometry.

Tab `tabGroupId` derives from its bound parent/container identity, independently of the human-readable group label. `order` is a one-based visual rank among **TabItems only** in that container. Visually overlapping rows (at least half the smaller tab height) are grouped before sorting left-to-right, so small vertical insets do not reverse tabs on the same strip. The provider's structural child index is retained internally only for identity fallback; it is not presented as order. A group with incomplete sibling enumeration, omitted/unobserved tabs or unusable bounds sets `orderIsPartial:true`. `visualOrder` ranks all observed visible tabs in the selected window; `visualOrderIsPartial` and `metadata.tabOrderPartial` explicitly mark incomplete global coverage, including a truncated tree or excluded cross-process descendants. Missing/offscreen geometry has no visual rank. A partial rank means first **among observed tabs**, not proof of the absolute first tab in the app.

A SHA-256 version covers the semantic inventory, elements and selection; it excludes timestamps.

Each inventory window and matching Window element also has `stateVersion`, a deterministic hash of that window's stable process/window identity, title, process ID/name, minimized/maximized and foreground state. `execute` may optionally include `expectedWindowVersion` **only for a window target**. In that case freshness is checked against this target-specific version instead of unrelated UIA/tree changes; the original `expectedVersion` argument remains required for protocol compatibility. Without the option the full snapshot version remains mandatory. UIA control targets reject the option with `WINDOW_VERSION_REQUIRES_WINDOW_TARGET` and always retain full-snapshot freshness. Both paths still reobserve, re-resolve the target and revalidate process/window identity before any effect.

```json
{"id":2,"method":"execute","args":{"expectedVersion":"…","targetId":"win_…","operation":"inspect"}}
```

Available operations are never inferred from names; each target advertises its supported capabilities:

| Target | Operations |
| --- | --- |
| Window | `inspect`, `activate`, `minimize`, `maximize`, `restore`, `close`, when supported by current state/style |
| UIA control | `select`, `invoke`, `toggle`, `expand`, `collapse`, when supported by current patterns and state |
| Active eligible Window | `set_keyboard_language`, with `language:"English"` or `language:"Russian"` |
| Focused writable non-password Edit | `replace_text`, with literal `text` (0–4096 UTF-16 units) |

`restore` requests a normal, non-minimized, non-maximized window. `activate` requests foreground and restores a minimized window; the receipt explicitly reports `foreground_not_granted` if Windows refuses activation. `close` posts graceful `WM_CLOSE`, never terminates a process. A destroyed/replaced original window yields `window_absent`; an original window that hides while its verified process keeps running yields `window_hidden_process_running`. The latter verifies closing the visible window and does not claim that the application exited. A still-visible window, including an unsaved-content dialog blocking close, remains unverified.

An execution receipt has:

```json
{"operation":"select","targetId":"el_…","before":{},"after":{},"verified":true,"stateChanged":false,"effectAttempted":true,"evidence":"element_selected"}
```

`before` and `after` are snapshots with their observation-completeness metadata. Selection, toggle, expansion and window effects are verified from their actual state. `inspect` verifies the selected-window binding, not that the app exposes all its controls. `invoke` always returns `verified:false`; a semantic change in the selected-window controls yields `stateChanged:true` and `evidence:"state_changed"` only when both snapshots have an available, untruncated surface for that same window. Geometry, visibility and capability-only changes do not count. A partial/unavailable surface returns `effect_outcome_unknown`, rather than treating missing controls as an app effect. This evidence is not proof that the user's overall task completed. An invoke with no observable change returns `invoked_without_observable_change`. Post-effect observation failure returns `after:null`, `effectAttempted:true` and `effect_outcome_unknown`; callers must not blindly repeat an effect of unknown outcome.

## Keyboard language and explicit text replacement

Window metadata includes `keyboardLanguage`, `keyboardLayoutId` (hexadecimal HKL) and `availableKeyboardLanguages`. These fields participate in its `stateVersion`. `set_keyboard_language` accepts only English/Russian, selects an already installed layout, and posts `WM_INPUTLANGCHANGEREQUEST` to the bound active window's focused child or window thread. It never loads a layout or simulates keys. The app can reject this message, so success is verified from `GetKeyboardLayout` after the request (`keyboard_language_verified`). A missing installed layout or lost foreground prevents the action. This changes the bound application's input language; it does not claim to change every window's language globally. [Microsoft message contract](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-inputlangchangerequest).

`replace_text` is **whole-field replacement**, not insertion at the caret or append. It is intended only for an explicit user-supplied literal. UIA `ValuePattern.SetValue` supplies the text directly; no Enter, other key, clipboard or shell action follows. Rich/multiline controls that expose only TextPattern are unsupported. [Microsoft ValuePattern documentation](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.valuepattern.setvalue).

Only a currently focused Edit in the selected eligible foreground window can be offered, and only when the password property is known false. Its Name is never read: the exposed name/label is the constant `Focused editable field`. Metadata reports only `supportsValuePattern`, `readOnly`, `isPassword:false` and `hasKeyboardFocus:true`, plus identity/capabilities. Read-only or unsupported focused edits have no replacement capability; password and nonfocused edits are omitted. Immediately before replacement the native backend rechecks the bound window, global focused element, runtime ID, edit role, password flag, enabled/visible/focused state, automation identity, ValuePattern support and read-only flag. It never reads existing or resulting Value/Text contents. Payloads above 4096 UTF-16 units, non-string values, invalid surrogate sequences and control characters other than CR/LF/tab are rejected. An explicitly supplied empty string clears the field.

Since it deliberately does not read the resulting field contents, replacement returns `verified:false`, `evidence:"text_set_unverified"`, `effectAttempted:true`, and `textLength` only. The receipt contains neither the supplied text nor a preview, and the controller must not retry it automatically. Entering a command into Jeff itself takes focus away from the external app: the controller must explicitly restore the intended app and obtain a fresh focused-edit observation, or use a voice flow that preserves external focus.

The exact canonical `%SystemRoot%\System32\Taskmgr.exe` is an exception for window-level inventory/actions only. A copied `Taskmgr.exe` at another path remains blocked. Observing the real Task Manager sets `surfaceStatus:"restricted_system_window"` and does not enumerate any process controls, editable fields or other UIA children. Keyboard/text capabilities are not offered for it; no process termination tools exist.

## Scope and validation

- Execution first reobserves, rejects a different `expectedVersion`, resolves the target again and revalidates HWND, PID, process start time, executable path and Windows session before any effect. Immediately before UIA mutation it also rechecks the exact Name fingerprint, exposed Name, selected/toggle/expand states, process and runtime/type/automation identity. A changed label or state yields `ELEMENT_IDENTITY_CHANGED` before effect execution. Element IDs are scoped to the bound window and UIA runtime identity, with a structural fallback for providers that omit runtime IDs.
- Observation never restores or activates windows. Minimized windows remain in the inventory; their control surface reports `window_minimized`.
- The helper and the caller passed via `--owner-pid <pid>` are excluded. Codex/ChatGPT, terminals, credential/security/password-management apps, settings and authentication windows are excluded using process, path and bounded title rules. Shell infrastructure, known overlays, tool windows and DWM-cloaked windows are also excluded. Protected windows are not exposed as action candidates. Unreadable process identity fails closed.
- No generated shell, file/process execution, arbitrary key input, coordinate clicking, OCR, screenshots, TextPattern contents or ValuePattern contents are read. Password and text subtrees are omitted; the focused Edit exception above exposes metadata only. Document containers are traversed for accessible controls without reading their own Name/text. Controls with sensitive authentication labels are omitted.
- Only one selected app subtree is walked: 480 scanned nodes, depth 12, 160 controls, a cooperative 1.8-second observation budget, and 500/650 ms UIA connection/transaction timeouts. A stable priority queue visits known Tab/TabItem nodes first, followed by toolbars and structural containers; menus and document content follow later. This prevents already-discovered browser tabs from waiting behind large menu/bookmark/content branches without increasing the budget. Window-root enumeration is independent of optional root patterns; unsupported optional descendant properties do not suppress their children. Partial/provider-limited observations report `truncated` or `provider_unavailable`; they are not a complete account of the desktop. `metadata.providerErrors` exposes at most 16 distinct fixed stage names and HRESULT codes, without external error messages or UI content. `skippedCrossProcess` counts descendants excluded by the process binding. The parent RPC timeout remains necessary because an external COM provider can still hang.
- The entire inventory participates in the full snapshot version. Unrelated changes may therefore cause a safe `STALE_SNAPSHOT` for UIA actions; the controller must obtain fresh evidence before retrying a decision. Window-level actions can use the target-specific `expectedWindowVersion` described above to avoid stalling on unrelated control churn. Neither mechanism permits retrying an effect whose outcome is unknown.

## Restricted regression checks

Run the reproducible suite from the repository root:

```powershell
node scripts/test-native-windows-desktop.cjs
```

It builds into `work/windows-desktop/test-bin`, builds the existing disposable lab fixture if missing, compiles the checked-in `ReviewTests.cs`, and runs targeted regressions plus native JSON-protocol scenarios. The helper receives `--fixture-pid`; it cannot enumerate personal apps. The suite briefly displays its own fixture and removes it afterward. It requires no model/API key. The machine-readable result is `work/windows-desktop/native-test-result.json`. To test an already-built helper without touching its binaries:

```powershell
node scripts/test-native-windows-desktop.cjs --helper-dir work/windows-desktop/staging-final --skip-build
```

The latter still recompiles its separate `ReviewTests.exe`. Do not run a native build concurrently with another native build because the verified NuGet extraction cache is shared.

`--fixture-pid <pid>` restricts inventory and actions to the known `work/desktop-lab/bin/JeffDesktopLabTarget.exe`, verifying its session, path and start time. This mode is for testing the real backend without reading personal apps; it is not enabled in product mode. It does not start a fixture itself. `--owner-pid` can be combined with it.

The same flag additionally accepts the exact test-only `work/windows-desktop/input-fixture/JeffWindowsInputFixture.exe` path. `node scripts/test-native-windows-input.cjs --helper-dir work/windows-desktop/staging-final --skip-build` builds that separate controlled fixture and tests focused replacement/privacy/denials and installed keyboard languages using an already-built helper. Its own test channel verifies synthetic text; the product helper still never reads field values. The fixture's original thread layout is restored afterward.

The implementation was compiled and exercised against a newly launched controlled fixture: inventory, UIA inspection, tab selection, invoke with state-change-only evidence, stable versions, stale execution rejection, minimize, passive observation of a minimized window, restore, maximize, and graceful close. Additional targeted regressions exercise unavailable/truncated invoke observations, name/selected/toggle/expand mismatch checks and a hidden original window with its process still running. These checks validate native mechanics; they do not claim that every third-party app exposes usable UIA controls.
