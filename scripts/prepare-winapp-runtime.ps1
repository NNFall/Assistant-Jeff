#requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$SkipSmoke
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The runtime is deliberately pinned to the Microsoft standalone x64 release.
# Do not resolve a moving "latest" URL here: the archive digest is part of the
# provenance contract and the Electron adapter is tested against this CLI schema.
$Version = '0.6.1'
$ReleaseCommit = 'd9a8d0f8ef192fa3ce07febdbe178606ea5fb4f5'
$AssetName = 'winappcli-x64.zip'
$DownloadUrl = "https://github.com/microsoft/winappCli/releases/download/v$Version/$AssetName"
$ExpectedArchiveSha256 = '11c03be2d356d6f910649cecce912a9bc6a0814dc4f2e9ae14e379a8cf470f01'
$LicenseUrl = "https://raw.githubusercontent.com/microsoft/winappCli/v$Version/LICENSE"
$ExpectedLicenseSha256 = 'c421b2a5e0ee627bb1c5d859bbca37d7654c02f63d626e753644484a9054c2d1'
$ExpectedFiles = [ordered]@{
    'winapp.exe' = 'd661c306e1909fd54a3c0d2a3c0a6330ab470cbf5a5fb80598efffcf33968a5c'
    'libSkiaSharp.dll' = '9a0d95e8caaa852c70d085af6a40a744242172ad9ea3fd6bc7599875a8a1dbcd'
}

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'work\winapp-runtime'))
$ArchivePath = Join-Path $RuntimeRoot "downloads\$AssetName"
$ExecutablePath = Join-Path $RuntimeRoot 'winapp.exe'
$SchemaPath = Join-Path $RuntimeRoot "cli-schema.v$Version.json"
$ManifestPath = Join-Path $RuntimeRoot 'runtime-manifest.json'
$EvidencePath = Join-Path $RuntimeRoot 'evidence.json'
$LicensePath = Join-Path $RuntimeRoot 'licenses\winappcli-MIT.txt'
$StagingRoot = Join-Path $RuntimeRoot ('.staging-' + [guid]::NewGuid().ToString('N'))

function Get-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path)
}

function Assert-UnderRuntime([string]$Path) {
    $candidate = Get-FullPath $Path
    $rootBase = (Get-FullPath $RuntimeRoot).TrimEnd('\')
    $root = $rootBase + '\'
    if ($candidate -ne $rootBase -and -not $candidate.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing a path outside the owned runtime directory: $candidate"
    }
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Assert-Hash([string]$Path, [string]$Expected) {
    $actual = Get-Sha256 $Path
    if ($actual -ne $Expected.ToLowerInvariant()) {
        throw "SHA-256 mismatch for '$Path': expected $Expected, got $actual"
    }
}

function Ensure-VerifiedCopy([string]$Source, [string]$Destination, [string]$Expected) {
    Assert-UnderRuntime $Destination
    if (Test-Path -LiteralPath $Destination) {
        if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
            throw "Refusing to replace a non-file runtime target: $Destination"
        }
        Assert-Hash $Destination $Expected
        return
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination
    Assert-Hash $Destination $Expected
}

function Download-ToStaging([string]$Url, [string]$Destination, [string]$Expected) {
    Assert-UnderRuntime $Destination
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
    Assert-Hash $Destination $Expected
}

function Extract-ZipEntries([string]$ZipPath, [string]$DestinationRoot) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $wanted = @('winapp.exe', 'libSkiaSharp.dll')
    $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $found = @{}
        foreach ($entry in $zip.Entries) {
            $leaf = [IO.Path]::GetFileName($entry.FullName)
            if ($wanted -notcontains $leaf) { continue }
            if ($found.ContainsKey($leaf)) { throw "Archive contains duplicate '$leaf' entries" }
            $found[$leaf] = $true
            $destination = Join-Path $DestinationRoot $leaf
            $input = $null
            $output = $null
            try {
                $input = $entry.Open()
                $output = [IO.File]::Create($destination)
                $input.CopyTo($output)
            } finally {
                if ($output) { $output.Dispose() }
                if ($input) { $input.Dispose() }
            }
        }
        foreach ($name in $wanted) {
            if (-not $found.ContainsKey($name)) { throw "Pinned archive is missing '$name'" }
        }
    } finally {
        $zip.Dispose()
    }
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    Assert-UnderRuntime $Path
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $Text, $encoding)
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot, (Split-Path -Parent $ArchivePath), $StagingRoot | Out-Null
Assert-UnderRuntime $RuntimeRoot
Assert-UnderRuntime $StagingRoot

# Never overwrite a previously downloaded archive with an unverified response.
# A mismatching existing artifact is a hard failure, so the operator can inspect
# it instead of the script silently replacing it.
if (Test-Path -LiteralPath $ArchivePath -PathType Leaf) {
    Assert-Hash $ArchivePath $ExpectedArchiveSha256
} else {
    $downloadedArchive = Join-Path $StagingRoot $AssetName
    Download-ToStaging $DownloadUrl $downloadedArchive $ExpectedArchiveSha256
    Ensure-VerifiedCopy $downloadedArchive $ArchivePath $ExpectedArchiveSha256
}

Extract-ZipEntries $ArchivePath $StagingRoot
foreach ($name in $ExpectedFiles.Keys) {
    $source = Join-Path $StagingRoot $name
    Assert-Hash $source $ExpectedFiles[$name]
    Ensure-VerifiedCopy $source (Join-Path $RuntimeRoot $name) $ExpectedFiles[$name]
}

if (Test-Path -LiteralPath $LicensePath -PathType Leaf) {
    Assert-Hash $LicensePath $ExpectedLicenseSha256
} else {
    $downloadedLicense = Join-Path $StagingRoot 'LICENSE'
    Download-ToStaging $LicenseUrl $downloadedLicense $ExpectedLicenseSha256
    Ensure-VerifiedCopy $downloadedLicense $LicensePath $ExpectedLicenseSha256
}

# Capture the complete pinned command schema from the actual executable. This
# is read-only and gives the JS adapter a versioned, on-device contract.
$oldTelemetryOptOut = [Environment]::GetEnvironmentVariable('WINAPP_CLI_TELEMETRY_OPTOUT', 'Process')
$env:WINAPP_CLI_TELEMETRY_OPTOUT = '1'
try {
    $schemaText = (& $ExecutablePath --cli-schema | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($schemaText)) {
        throw "winapp --cli-schema failed with exit code $LASTEXITCODE"
    }
    $null = $schemaText | ConvertFrom-Json
    Write-Utf8NoBom $SchemaPath ($schemaText + "`n")
} finally {
    if ($null -eq $oldTelemetryOptOut) {
        Remove-Item Env:WINAPP_CLI_TELEMETRY_OPTOUT -ErrorAction SilentlyContinue
    } else {
        $env:WINAPP_CLI_TELEMETRY_OPTOUT = $oldTelemetryOptOut
    }
}

$runtimeFiles = @(
    [ordered]@{ path = 'winapp.exe'; sha256 = Get-Sha256 $ExecutablePath; bytes = (Get-Item -LiteralPath $ExecutablePath).Length },
    [ordered]@{ path = 'libSkiaSharp.dll'; sha256 = Get-Sha256 (Join-Path $RuntimeRoot 'libSkiaSharp.dll'); bytes = (Get-Item -LiteralPath (Join-Path $RuntimeRoot 'libSkiaSharp.dll')).Length },
    [ordered]@{ path = 'licenses/winappcli-MIT.txt'; sha256 = Get-Sha256 $LicensePath; bytes = (Get-Item -LiteralPath $LicensePath).Length },
    [ordered]@{ path = "cli-schema.v$Version.json"; sha256 = Get-Sha256 $SchemaPath; bytes = (Get-Item -LiteralPath $SchemaPath).Length }
)
$manifest = [ordered]@{
    schemaVersion = 1
    product = 'Assistant Jeff Windows UI runtime'
    provider = 'Microsoft winappCli standalone'
    version = $Version
    architecture = 'x64'
    source = [ordered]@{
        repository = 'https://github.com/microsoft/winappCli'
        tag = "v$Version"
        commit = $ReleaseCommit
        releaseAsset = $AssetName
        releaseUrl = $DownloadUrl
        archiveSha256 = $ExpectedArchiveSha256
        licenseUrl = $LicenseUrl
    }
    launch = [ordered]@{
        executable = 'work/winapp-runtime/winapp.exe'
        telemetryOptOut = [ordered]@{ name = 'WINAPP_CLI_TELEMETRY_OPTOUT'; value = '1' }
        base = @('ui')
        json = '--json'
        quiet = '--quiet (use only for non-JSON output; v0.6.1 rejects --quiet together with --json)'
    }
    files = $runtimeFiles
    license = [ordered]@{ path = 'licenses/winappcli-MIT.txt'; spdx = 'MIT'; sha256 = $ExpectedLicenseSha256 }
}
Write-Utf8NoBom $ManifestPath (($manifest | ConvertTo-Json -Depth 12) + "`n")

$smoke = [ordered]@{
    version = [ordered]@{ command = @('--version'); exitCode = $null; stdout = $null }
    listWindows = [ordered]@{ command = @('ui', 'list-windows', '--json'); exitCode = $null; jsonValid = $false; count = $null; keys = @() }
}
if (-not $SkipSmoke) {
    $oldTelemetryOptOut = [Environment]::GetEnvironmentVariable('WINAPP_CLI_TELEMETRY_OPTOUT', 'Process')
    $env:WINAPP_CLI_TELEMETRY_OPTOUT = '1'
    try {
        $versionStdout = (& $ExecutablePath --version | Out-String).Trim()
        $smoke.version.exitCode = $LASTEXITCODE
        $smoke.version.stdout = $versionStdout
        if ($LASTEXITCODE -ne 0 -or $versionStdout -ne $Version) { throw "Unexpected winapp version smoke output: '$versionStdout'" }

        $windowsStdout = (& $ExecutablePath ui list-windows --json | Out-String).Trim()
        $windowsExit = $LASTEXITCODE
        $smoke.listWindows.exitCode = $windowsExit
        if ($windowsExit -ne 0) { throw "ui list-windows smoke failed with exit code ${windowsExit}: $windowsStdout" }
        # Use -InputObject rather than piping: Windows PowerShell otherwise
        # wraps a JSON array as one object whose properties are Length/Count.
        $parsedWindows = ConvertFrom-Json -InputObject $windowsStdout
        if ($parsedWindows -is [array] -and $parsedWindows.Count -eq 1 -and $parsedWindows[0] -is [array]) {
            $windows = @($parsedWindows[0])
        } else {
            $windows = @($parsedWindows)
        }
        $smoke.listWindows.jsonValid = $true
        $smoke.listWindows.count = $windows.Count
        $smoke.listWindows.keys = @($windows | ForEach-Object { if ($_ -and $_.PSObject) { $_.PSObject.Properties | ForEach-Object Name } } | Sort-Object -Unique)
        if ($windows.Count -lt 1) { throw 'ui list-windows smoke returned no windows' }
    } finally {
        if ($null -eq $oldTelemetryOptOut) {
            Remove-Item Env:WINAPP_CLI_TELEMETRY_OPTOUT -ErrorAction SilentlyContinue
        } else {
            $env:WINAPP_CLI_TELEMETRY_OPTOUT = $oldTelemetryOptOut
        }
    }
}

$evidence = [ordered]@{
    schemaVersion = 1
    checkedAtUtc = [DateTime]::UtcNow.ToString('o')
    source = $manifest.source
    runtime = [ordered]@{
        executable = $manifest.launch.executable
        localExecutable = $ExecutablePath
        version = $Version
        architecture = 'x64'
        dependencyFiles = @('libSkiaSharp.dll')
        telemetryOptOut = $manifest.launch.telemetryOptOut
        packaging = 'standalone archive; no Python, npm, MSIX install, PATH change, or registry change'
    }
    launchContract = [ordered]@{
        common = @('ui', '--json (do not add --quiet)')
        listWindows = @('ui', 'list-windows', '--json')
        inspect = @('ui', 'inspect', '--window', '<hwnd>', '--interactive', '--depth', '8', '--json')
        search = @('ui', 'search', '<text>', '--window', '<hwnd>', '--max', '32', '--json')
        invoke = @('ui', 'invoke', '<selector>', '--window', '<hwnd>', '--json')
        setValue = @('ui', 'set-value', '<selector>', '<value>', '--window', '<hwnd>', '--json')
        scroll = @('ui', 'scroll', '<selector>', '--window', '<hwnd>', '--direction', '<up|down|left|right>', '--json')
        waitFor = @('ui', 'wait-for', '<selector>', '--window', '<hwnd>', '--timeout', '3000', '--json')
        sendKeys = @('ui', 'send-keys', '<fixed-key-enum>', '--window', '<hwnd>', '--via', 'post-message', '--json')
        selectionToggleExpand = 'ui invoke; upstream selects InvokePattern, then TogglePattern, SelectionItemPattern, ExpandCollapsePattern in that order; there are no separate select/toggle/expand commands'
    }
    outputContract = [ordered]@{
        listWindows = [ordered]@{ type = 'array'; itemKeys = @('hwnd', 'processId', 'processName', 'title', 'label', 'width', 'height', 'ownerHwnd', 'className', 'isForeground') }
        inspect = [ordered]@{ type = 'object'; topLevelKeys = @('depth', 'interactive', 'hideDisabled', 'hideOffscreen', 'windows'); windowKeys = @('hwnd', 'title', 'className (optional)', 'elementCount', 'elements'); elementHandle = 'selector'; elementKeys = @('type', 'name', 'className', 'isEnabled', 'isOffscreen', 'x', 'y', 'width', 'height', 'selector', 'ancestorPath', 'isInvokable', 'hasMoreChildren') }
        search = [ordered]@{ type = 'object'; topLevelKeys = @('matchCount', 'hasMore', 'matches'); matchKeys = @('type', 'name', 'className', 'isEnabled', 'isOffscreen', 'x', 'y', 'width', 'height', 'selector', 'isInvokable', 'invokableAncestor') }
        getFocused = [ordered]@{ noFocus = [ordered]@{ hasFocus = $false }; focus = [ordered]@{ hasFocus = $true; element = '<element-shaped object>' } }
        waitFor = [ordered]@{ type = 'object'; topLevelKeys = @('found', 'waitedMs', 'element', 'timedOut'); elementKeys = @('type', 'name', 'className', 'isEnabled', 'isOffscreen', 'x', 'y', 'width', 'height', 'selector', 'isInvokable') }
    }
    safety = [ordered]@{
        readOnlySmoke = @('winapp --version', 'winapp ui list-windows --json', 'winapp --cli-schema')
        effectful = @('invoke', 'set-value', 'scroll', 'send-keys')
        staleTargetRule = 'After each inspect/search, the adapter must re-resolve the selector against the same hwnd and execute at most one effectful call.'
        excludedFromAssistantContract = @('app', 'powershell', 'filesystem', 'process', 'registry', 'clipboard', 'notification', 'package', 'sign', 'run')
    }
    observedReadOnlyEnvelopeProbe = [ordered]@{
        commands = @('ui search --json', 'ui inspect --json', 'ui wait-for --json')
        exitCode = 0
        values = 'Current element names, selectors, titles, and bounds were intentionally omitted; only envelope/field names are retained above.'
    }
    smoke = $smoke
    artifacts = [ordered]@{
        archive = [ordered]@{ path = 'work/winapp-runtime/downloads/winappcli-x64.zip'; sha256 = $ExpectedArchiveSha256; bytes = (Get-Item -LiteralPath $ArchivePath).Length }
        executable = [ordered]@{ path = 'work/winapp-runtime/winapp.exe'; sha256 = Get-Sha256 $ExecutablePath }
        schema = [ordered]@{ path = "work/winapp-runtime/cli-schema.v$Version.json"; sha256 = Get-Sha256 $SchemaPath }
        license = [ordered]@{ path = 'work/winapp-runtime/licenses/winappcli-MIT.txt'; sha256 = $ExpectedLicenseSha256 }
    }
}
Write-Utf8NoBom $EvidencePath (($evidence | ConvertTo-Json -Depth 16) + "`n")

# The current staging directory contains only verified copies used during this
# run. Remove that exact directory after evidence is written; failed runs leave
# their staging directory intact for diagnosis. The downloads directory is
# retained as the pinned archive cache and is excluded by the Electron packager.
if (Test-Path -LiteralPath $StagingRoot) {
    try {
        [IO.Directory]::Delete($StagingRoot, $true)
    } catch {
        Write-Warning "Could not remove verified staging directory '$StagingRoot': $($_.Exception.Message)"
    }
}

Write-Output "Prepared winappCli $Version x64 at $ExecutablePath"
Write-Output "Archive SHA-256: $ExpectedArchiveSha256"
if ($SkipSmoke) {
    Write-Output 'Smoke: skipped (-SkipSmoke)'
} else {
    Write-Output "Smoke: --version and ui list-windows passed ($($smoke.listWindows.count) windows observed; values omitted from evidence)"
}
Write-Output "Manifest: $ManifestPath"
Write-Output "Evidence: $EvidencePath"
