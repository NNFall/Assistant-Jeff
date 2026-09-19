param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$textPath = Join-Path $OutputDirectory 'sample-text.txt'
$text = [IO.File]::ReadAllText($textPath, [Text.Encoding]::UTF8)
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voice.SelectVoice('Microsoft Irina Desktop')
    $voice.Rate = 1
    $voice.SetOutputToWaveFile((Join-Path $OutputDirectory 'sapi-irina.wav'))
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $voice.Speak($text)
    $timer.Stop()
    $voice.SetOutputToNull()
    @{ voice = 'Microsoft Irina Desktop'; synthesis_seconds = $timer.Elapsed.TotalSeconds } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'sapi-metrics.json') -Encoding utf8
} finally { $voice.Dispose() }
