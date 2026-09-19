# Native desktop lab

A visible, isolated WinForms target and a narrow **FlaUI.UIA3 5.0.0** JSON-lines helper. This is an actual Windows UI Automation experiment, not a simulated JavaScript state machine. It never controls the real browser, plays music, changes OS keyboard layout or reads other applications.

Build from the repository with `powershell -NoProfile -File scripts/build-desktop-lab.ps1`. Uses the installed Windows .NET Framework 4.8 compiler/runtime, with official NuGet packages pinned and SHA-256 checked in `dependencies.json`. Packages, binaries, copied MIT licenses and artifact hashes stay under `work/desktop-lab/`. No SDK installation. Build does not launch the target.

The controller launches `work/desktop-lab/bin/JeffDesktopLabTarget.exe` visibly (`windowsHide:false`; it is a GUI executable with no console) and captures its PID, then starts `JeffDesktopLabHelper.exe --pid <PID> --exe <absolute-target-exe-path>` with redirected stdio and no console window. The helper only accepts the target executable beside itself, validates process path/session/start identity before observations and effects, and traverses only the target's named client surface. No desktop inventory, screenshots, keyboard/mouse injection or shell is exposed.

UTF-8 stdin/stdout, one JSON object per line (64 KiB maximum). The controller should impose an overall request timeout and terminate a hung helper; UIA COM calls can block on an unresponsive target.

```json
{"id":1,"method":"observe","args":{}}
{"id":2,"method":"execute","args":{"targetId":"el1","operation":"select","expectedVersion":"version-from-observe"}}
```

Responses: `{id,ok:true,result}` or `{id,ok:false,error:{code}}`. Observe result: `{version,app,summary,elements:[{id,label,name,role,order,selected,capabilities}],facts:{selectedTab,playing,language},metadata}`. Execute result: `{executed:{targetId,operation},snapshot}`. `version` is SHA-256 over deterministic semantic UIA facts and observed actions, not wall time. COM runtime IDs map to stable session-local `elN` identifiers. Windows virtual TabItem providers can return an empty runtime ID; those use their real parent COM runtime ID plus the uniquely observed UIA name (ambiguous identity fails closed). Tab labels include observed ordinal positions from UIA sibling geometry; `name` retains the exact UIA name and `selected` comes from SelectionItem. Music Play/Pause is present only on the selected Music page; use only identifiers supplied by the latest observation. Capabilities are actual supported UIA SelectionItem (`select`) or Invoke (`click`) patterns. At most 32 action targets, 256 scanned elements and 16 tree levels. Password elements and their subtrees are excluded.

Tab labels also include the observed parent group name, for example `Content tabs / Tab 2: VK feed` versus `Mock in-app language / Tab 2: Russian`. `group` exposes that UIA name separately. Selected tabs remain visible as evidence with `selected:true` and `capabilities:[]`; redundant selection is not proposed as progress and direct execution is rejected. `metadata.actionCount` counts only elements with a nonempty capability list.

Facts come from selected UIA tab items and visible UIA labels. The helper has no fixture memory access, shared data file or private state API. Language is explicitly a **MOCK in-app English/Russian selector**, not proof of changing Windows input language. Music is a visible playback-state label, not audio output. Documentation/VK tabs are local fixture pages, not external websites.

Errors include `STALE_SNAPSHOT`, `UNKNOWN_TARGET`, `OPERATION_DENIED`, `TARGET_PATH_DENIED`, `TARGET_IDENTITY_MISMATCH`, `TARGET_WINDOW_UNAVAILABLE`, `FIXTURE_FACTS_UNAVAILABLE`, `TREE_LIMIT`, `ACTION_LIMIT`, `INVALID_ARGUMENT`, `UNKNOWN_METHOD`. Exceptions do not return arbitrary process paths, internal traces or private fields. There is no model or hardcoded natural-language intent parser in the target/helper: the outer controller chooses among observed controls. UIA validation and pattern invocation are not atomic: an external change can still occur in the short interval between them. Post-action verification detects many such mismatches; this is not a guarantee against every race.
