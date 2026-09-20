$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

# Read installed application shortcuts only. Reject links requiring arguments:
# their name may identify a PWA/game rather than the executable they point to.
# Argument contents are never stored, returned, logged or passed to a process.
# Explicit built-ins (Task Manager) are added by the JavaScript catalog, which
# validates the exact SystemRoot executable; this shortcut scan stays restricted.
$blocked = '(?i)(uninstall|unins\d*|updat(?:e|er|ing)|setup|installer|maintenance|repair|codex|antigravity|password|keepass|bitwarden|1password|lastpass|dashlane|nordpass|security|defender|antivirus|credential|settings|control panel|terminal|powershell|command prompt|\u0443\u0434\u0430\u043b\u0435\u043d\u0438|\u0434\u0435\u0438\u043d\u0441\u0442\u0430\u043b|\u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d|\u0443\u0441\u0442\u0430\u043d\u043e\u0432\u0449\u0438\u043a|\u043f\u0430\u0440\u043e\u043b|\u0431\u0435\u0437\u043e\u043f\u0430\u0441\u043d\u043e\u0441\u0442|\u043f\u0430\u0440\u0430\u043c\u0435\u0442\u0440\u044b|\u043a\u043e\u043c\u0430\u043d\u0434\u043d\u0430\u044f \u0441\u0442\u0440\u043e\u043a\u0430)'
$blockedExecutable = '^(?i:cmd|powershell|pwsh|conhost|wt|windowsterminal|bash|wsl|sh|python\d*|pythonw\d*|node|deno|bun|ruby|perl|cscript|wscript|mshta|rundll32|regsvr32|regedit|mmc|control|taskmgr|procexp\d*|processhacker|runas|java|javaw|electron|msiexec|schtasks|sc|net|netsh|bcdedit|diskpart|format|services|secpol|gpedit|mstsc|ssh|putty|openconsole)$'
$roots = @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu')) | Select-Object -Unique
$apps = New-Object System.Collections.Generic.List[object]
$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$shell = New-Object -ComObject WScript.Shell
try {
    foreach ($root in $roots) {
        if (-not $root -or -not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        foreach ($link in @(Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -File -ErrorAction SilentlyContinue | Sort-Object FullName)) {
            if ($apps.Count -ge 200) { break }
            $name = [IO.Path]::GetFileNameWithoutExtension($link.Name).Trim()
            if ($name.Length -lt 2 -or $name.Length -gt 100 -or $name -notmatch '\p{L}' -or $name -match '[\x00-\x1f\x7f\\/:<>|]' -or $name -match $blocked -or $name -match '(?i)(api[_-]?key|bearer\s|[a-z0-9_-]{40,})') { continue }
            $shortcut = $null
            try {
                $shortcut = $shell.CreateShortcut($link.FullName)
                if (-not [string]::IsNullOrEmpty([string]$shortcut.Arguments)) { continue }
                $target = [string]$shortcut.TargetPath
                if ($target -notmatch '^[A-Za-z]:\\' -or $target -match '[\x00-\x1f\x7f"<>|?*%]' -or $target.Substring(2).Contains(':') -or $target -notmatch '(?i)\.exe$') { continue }
                $full = [IO.Path]::GetFullPath($target)
                if ($full -cne $target -or $full -match '(?i)\\Windows\\' -or $full -match $blocked) { continue }
                $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($full))
                if ($drive.DriveType -notin @([IO.DriveType]::Fixed, [IO.DriveType]::Removable)) { continue }
                $process = [IO.Path]::GetFileNameWithoutExtension($full)
                if ($process -match $blockedExecutable -or -not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
                if ($seen.Add($full + [char]0 + $name)) { $apps.Add([pscustomobject]@{ name = $name; exe = $full }) }
            } catch { continue }
            finally { if ($null -ne $shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) } }
        }
        if ($apps.Count -ge 200) { break }
    }
} finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
ConvertTo-Json -InputObject @($apps.ToArray()) -Compress -Depth 3
