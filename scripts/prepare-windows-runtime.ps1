[CmdletBinding()]
param([string]$FfmpegPath, [string]$FfmpegLicensePath)
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $repositoryRoot 'work\voice-runtime'

function Assert-File([string]$FilePath) {
  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { throw "Required runtime file missing: $FilePath" }
}
function Assert-Hash([string]$FilePath, [string]$Expected) {
  Assert-File $FilePath
  if ($Expected -notmatch '^[A-Fa-f0-9]{64}$' -or (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash -ne $Expected) {
    throw "Runtime SHA256 mismatch: $FilePath"
  }
}

# Build separately with npm run windows:build. Preparation never starts an app or compiler.
$helperRoot = Join-Path $repositoryRoot 'work\windows-desktop\bin'
Assert-File (Join-Path $helperRoot 'JeffWindowsDesktopHelper.exe')
Assert-File (Join-Path $helperRoot 'JeffWindowsDesktopHelper.exe.config')
$artifactManifest = Join-Path $helperRoot 'artifacts.json'
Assert-File $artifactManifest
$artifacts = Get-Content -Raw -LiteralPath $artifactManifest | ConvertFrom-Json
foreach ($artifact in $artifacts.artifacts) {
  if ([IO.Path]::GetFileName($artifact.name) -ne $artifact.name) { throw 'Invalid helper artifact manifest path.' }
  Assert-Hash (Join-Path $helperRoot $artifact.name) $artifact.sha256
}
foreach ($dll in @('FlaUI.Core.dll', 'FlaUI.UIA3.dll', 'Interop.UIAutomationClient.dll')) { Assert-File (Join-Path $helperRoot $dll) }
if (-not (Get-ChildItem -LiteralPath (Join-Path $helperRoot 'licenses') -File)) { throw 'Native helper license notices missing.' }
Assert-File (Join-Path $repositoryRoot 'scripts\windows-desktop\read-apps.ps1')

$modelRoot = Join-Path $repositoryRoot 'models'
$wakeManifest = Join-Path $modelRoot 'download-manifest.json'
Assert-File $wakeManifest
$wakeModels = Get-Content -Raw -LiteralPath $wakeManifest | ConvertFrom-Json
foreach ($name in @('melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx')) {
  Assert-Hash (Join-Path $modelRoot $name) $wakeModels.$name.sha256
}
$voiceRoot = Join-Path $repositoryRoot 'data\tts\piper'
foreach ($name in @('ru_RU-denis-medium.onnx', 'ru_RU-denis-medium.onnx.json', 'denis-MODEL_CARD.md')) { Assert-File (Join-Path $voiceRoot $name) }

$piperRoot = Join-Path $runtimeRoot 'piper'
$piperArchive = Join-Path $runtimeRoot 'piper_windows_amd64-2023.11.14-2.zip'
$piperHash = 'F3C58906402B24F3A96D92145F58ACBA6D86C9B5DB896D207F78DC80811EFCEA'
if (-not (Test-Path -LiteralPath (Join-Path $piperRoot 'runtime-manifest.json'))) {
  & (Join-Path $PSScriptRoot 'install-voice-runtime.ps1')
}
# Existing installations are checked against every byte of the pinned release archive;
# no network request or silent binary replacement is needed on the normal prepare path.
Assert-Hash $piperArchive $piperHash
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($piperArchive)
try {
  foreach ($entry in $zip.Entries) {
    $entryPath = [IO.Path]::GetFullPath((Join-Path $runtimeRoot $entry.FullName))
    if (-not $entryPath.StartsWith($piperRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      if ($entryPath -ne $piperRoot) { throw 'Unexpected Piper ZIP entry path.' }
    }
    if (-not $entry.Name) { continue }
    Assert-File $entryPath
    $stream = $entry.Open()
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $entryHash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $hasher.Dispose() }
    Assert-Hash $entryPath $entryHash
  }
} finally { $zip.Dispose() }
$piperManifest = Get-Content -Raw -LiteralPath (Join-Path $piperRoot 'runtime-manifest.json') | ConvertFrom-Json
foreach ($license in $piperManifest.licenses) {
  if ([IO.Path]::GetFileName($license.file) -ne $license.file) { throw 'Invalid Piper license manifest path.' }
  Assert-Hash (Join-Path $piperRoot "licenses\$($license.file)") $license.sha256
}

# Only an explicit local FFmpeg path or the already installed Chocolatey package is used.
# The system shim in chocolatey/bin is not copied as a standalone runtime.
$ffmpegRoot = Join-Path $runtimeRoot 'ffmpeg'
$ffmpegTarget = Join-Path $ffmpegRoot 'ffmpeg.exe'
$licenseTarget = Join-Path $ffmpegRoot 'LICENSE'
$ffmpegManifestPath = Join-Path $ffmpegRoot 'runtime-manifest.json'
$ffmpegSource = $null
if ($FfmpegPath) { $ffmpegSource = [IO.Path]::GetFullPath($FfmpegPath) }
elseif (-not (Test-Path -LiteralPath $ffmpegTarget)) { $ffmpegSource = 'C:\ProgramData\chocolatey\lib\ffmpeg\tools\ffmpeg\bin\ffmpeg.exe' }
if ($ffmpegSource) {
  Assert-File $ffmpegSource
  $licenseSource = if ($FfmpegLicensePath) { [IO.Path]::GetFullPath($FfmpegLicensePath) } else {
    $nearby = Join-Path ([IO.Path]::GetDirectoryName($ffmpegSource)) 'LICENSE'
    if (Test-Path -LiteralPath $nearby -PathType Leaf) { $nearby }
    else { Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($ffmpegSource))) 'LICENSE' }
  }
  Assert-File $licenseSource
  New-Item -ItemType Directory -Path $ffmpegRoot -Force | Out-Null
  if ($ffmpegSource -ne $ffmpegTarget) { Copy-Item -LiteralPath $ffmpegSource -Destination $ffmpegTarget -Force }
  if ($licenseSource -ne $licenseTarget) { Copy-Item -LiteralPath $licenseSource -Destination $licenseTarget -Force }
} elseif (Test-Path -LiteralPath $ffmpegManifestPath) {
  $existingFfmpeg = Get-Content -Raw -LiteralPath $ffmpegManifestPath | ConvertFrom-Json
  Assert-Hash $ffmpegTarget $existingFfmpeg.sha256
  Assert-Hash $licenseTarget $existingFfmpeg.licenseSha256
}
Assert-File $ffmpegTarget
Assert-File $licenseTarget
if ((Get-Item -LiteralPath $ffmpegTarget).Length -lt 10MB) { throw 'FFmpeg runtime is unexpectedly small; use the real executable, not a package-manager shim.' }
if ((Get-Item -LiteralPath $licenseTarget).Length -lt 1KB) { throw 'FFmpeg LICENSE is incomplete.' }
$ffmpegHash = (Get-FileHash -LiteralPath $ffmpegTarget -Algorithm SHA256).Hash
$ffmpegLicenseHash = (Get-FileHash -LiteralPath $licenseTarget -Algorithm SHA256).Hash
@{
  sha256 = $ffmpegHash; licenseSha256 = $ffmpegLicenseHash
  provenance = 'Locally supplied executable or existing Chocolatey installation; hashes measured locally, not upstream signed checksums'
} | ConvertTo-Json | Set-Content -LiteralPath $ffmpegManifestPath -Encoding UTF8
Write-Output 'Windows runtime resources ready: native helper, wake models, Denis, pinned Piper, local FFmpeg and license notices. No application was launched.'
