# Assistant Jeff

- Only working checkout: `D:\papka for all\work\Assistant Jeff`. Always set shell workdir explicitly and edit absolute paths.
- Use the installed `typesafe-ai` skill for TypeSafe/Jev integration and read current official API docs before changing contracts.
- New desktop runtime is Electron / JavaScript. Original Python prototype stays available for reference and fallback.
- Preserve `data/assistant.sqlite` and `data/settings.json`. Never test against real personal records.
- Secrets, models, local data, build outputs and scratch work must not enter Git. Use Windows DPAPI / server environment files for secrets; never log them.
- Remote: `https://github.com/NNFall/Assistant-Jeff.git`. User authorizes committing and pushing project changes.
- Only final recognized commands may cause effects; interim transcripts are display-only. Desktop actions use a fixed allowlist, never generated shell commands.
- Microphone begins only by explicit user control/autostart setting. Cloud audio begins only after wake activation or explicit record command; no continuous cloud streaming while waiting.
- Subagents may own independent modules. Preserve concurrent edits and verify integrated behavior.
