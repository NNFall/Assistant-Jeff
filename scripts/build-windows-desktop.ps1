[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $repo 'native\windows-desktop'
$work = Join-Path $repo 'work\windows-desktop'
$packages = Join-Path $work 'packages'
$bin = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $work 'bin' }
$allowedOutputRoot = [IO.Path]::GetFullPath($work).TrimEnd('\') + '\'
if (!$bin.StartsWith($allowedOutputRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputDirectory must stay under the repository work/windows-desktop directory.' }
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler missing. No global SDK is installed by this script.' }
New-Item -ItemType Directory -Force $packages,$bin,(Join-Path $bin 'licenses') | Out-Null
# Reuse the checked-in, hash-pinned FlaUI dependencies; do not float versions.
$manifestPath = Join-Path $repo 'native\desktop-lab\dependencies.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$references = @()
foreach ($package in $manifest.packages) {
    $name = $package.id.ToLowerInvariant()
    $stem = "$name.$($package.version)"
    $archive = Join-Path $packages "$stem.nupkg"
    $expanded = Join-Path $packages $stem
    if (!(Test-Path -LiteralPath $archive)) {
        $localCache = Join-Path $repo "work\desktop-lab\packages\$stem.nupkg"
        if (Test-Path -LiteralPath $localCache) { Copy-Item -LiteralPath $localCache -Destination $archive }
        else { Invoke-WebRequest -Uri "$($manifest.source)/$name/$($package.version)/$stem.nupkg" -OutFile $archive -UseBasicParsing }
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $package.sha256) { throw "NuGet archive integrity mismatch: $stem" }
    $zip = Join-Path $packages "$stem.zip"
    Copy-Item -LiteralPath $archive -Destination $zip -Force
    Expand-Archive -LiteralPath $zip -DestinationPath $expanded -Force
    $license = Join-Path $expanded $package.licenseFile
    if (!(Test-Path -LiteralPath $license)) { throw "Package license missing: $stem" }
    Copy-Item -LiteralPath $license -Destination (Join-Path $bin "licenses\$stem.txt") -Force
    if ($package.dll) {
        $dll = Join-Path $expanded $package.dll
        Copy-Item -LiteralPath $dll -Destination $bin -Force
        $references += "/reference:$dll"
    }
}
$common = @('/nologo','/optimize+','/platform:x64','/codepage:65001',('/reference:' + (Join-Path $framework 'System.dll')),('/reference:' + (Join-Path $framework 'System.Core.dll')),('/reference:' + (Join-Path $framework 'System.Drawing.dll')),('/reference:' + (Join-Path $framework 'System.Windows.Forms.dll')))
& $compiler @common @references /target:exe "/reference:$(Join-Path $framework 'System.Web.Extensions.dll')" "/reference:$(Join-Path $framework 'System.Management.dll')" "/reference:$(Join-Path $framework 'WPF\WindowsBase.dll')" "/out:$(Join-Path $bin 'JeffWindowsDesktopHelper.exe')" (Join-Path $source 'Helper.cs') (Join-Path $source 'SystemVolume.cs')
if ($LASTEXITCODE -ne 0) { throw 'Windows desktop helper compilation failed.' }
Copy-Item -LiteralPath (Join-Path $repo 'native\desktop-lab\app.config') -Destination (Join-Path $bin 'JeffWindowsDesktopHelper.exe.config') -Force
Copy-Item -LiteralPath $manifestPath -Destination $bin -Force
$artifactHashes = Get-ChildItem -LiteralPath $bin -File | Where-Object Extension -in @('.exe','.dll') | ForEach-Object { @{name=$_.Name;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash} }
@{framework='Windows .NET Framework 4.8';compiler=$compiler;artifacts=@($artifactHashes)} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $bin 'artifacts.json') -Encoding UTF8
Write-Output "Built native Windows desktop helper (not launched): $bin"
