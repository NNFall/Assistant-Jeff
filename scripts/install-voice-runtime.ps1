$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $repositoryRoot 'work\voice-runtime'
$piperRoot = Join-Path $runtimeRoot 'piper'
$version = '2023.11.14-2'
$url = "https://github.com/rhasspy/piper/releases/download/$version/piper_windows_amd64.zip"
# Locally measured SHA256 of the official GitHub release asset on 2026-09-20.
# GitHub's release API has digest:null for this legacy asset; this is NOT an upstream signed checksum.
$expectedHash = 'F3C58906402B24F3A96D92145F58ACBA6D86C9B5DB896D207F78DC80811EFCEA'
$archive = Join-Path $runtimeRoot "piper_windows_amd64-$version.zip"
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
}
$actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) { throw 'Piper archive checksum mismatch. The existing archive was preserved for inspection.' }

# Validate every ZIP entry before extracting this fixed, pinned archive into the repository workspace.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  foreach ($entry in $zip.Entries) {
    $entryTarget = [IO.Path]::GetFullPath((Join-Path $runtimeRoot $entry.FullName))
    if (-not $entryTarget.StartsWith($piperRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      if ($entryTarget -ne $piperRoot) { throw "Unexpected archive entry: $($entry.FullName)" }
    }
  }
} finally { $zip.Dispose() }
Expand-Archive -LiteralPath $archive -DestinationPath $runtimeRoot -Force
if (-not (Test-Path -LiteralPath (Join-Path $piperRoot 'piper.exe'))) { throw 'Piper executable missing after extraction.' }

$licenseRoot = Join-Path $piperRoot 'licenses'
New-Item -ItemType Directory -Path $licenseRoot -Force | Out-Null
# Release CMake sources identify these dependencies. eSpeak is GPL-3.0; Piper's MIT license
# alone does not describe the complete binary bundle. Keep notices and source links together.
$licenses = @(
  @{ name = 'Piper-LICENSE.txt'; url = "https://raw.githubusercontent.com/rhasspy/piper/$version/LICENSE.md" },
  @{ name = 'Piper-phonemize-LICENSE.txt'; url = 'https://raw.githubusercontent.com/rhasspy/piper-phonemize/2023.11.14-4/LICENSE.md' },
  @{ name = 'eSpeak-NG-COPYING.txt'; url = 'https://raw.githubusercontent.com/rhasspy/espeak-ng/master/COPYING' },
  @{ name = 'ONNX-Runtime-LICENSE.txt'; url = 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.14.1/LICENSE' },
  @{ name = 'fmt-LICENSE.txt'; url = 'https://raw.githubusercontent.com/fmtlib/fmt/10.0.0/LICENSE.rst' },
  @{ name = 'spdlog-LICENSE.txt'; url = 'https://raw.githubusercontent.com/gabime/spdlog/v1.12.0/LICENSE' }
)
$licenseManifest = @()
foreach ($license in $licenses) {
  $licenseFile = Join-Path $licenseRoot $license.name
  Invoke-WebRequest -UseBasicParsing -Uri $license.url -OutFile $licenseFile
  $licenseManifest += @{ file = $license.name; url = $license.url; sha256 = (Get-FileHash -LiteralPath $licenseFile -Algorithm SHA256).Hash }
}
$modelCard = Join-Path $repositoryRoot 'data\tts\piper\denis-MODEL_CARD.md'
if (Test-Path -LiteralPath $modelCard) { Copy-Item -LiteralPath $modelCard -Destination (Join-Path $licenseRoot 'Denis-MODEL_CARD.md') -Force }
@{
  version = $version; url = $url; sha256 = $actualHash
  checksumProvenance = 'Locally measured from the official release; upstream digest absent'
  installedAt = [DateTime]::UtcNow.ToString('o'); licenses = $licenseManifest
  source = "https://github.com/rhasspy/piper/tree/$version"
  note = 'Native Windows x64 runtime; no Python. Archive is an archived legacy release. License copies are notices, not a completed redistribution compliance audit.'
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $piperRoot 'runtime-manifest.json') -Encoding UTF8
Write-Output "Piper $version installed in $piperRoot (SHA256 verified)."
