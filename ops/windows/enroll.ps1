<#
Enrollment (Windows). Kod STDIN'dan o'qiladi va `agentd enroll --code -` ga uzatiladi: argv/log/env'da ko'rinmaydi.
  "<kod>" | powershell -NoProfile -ExecutionPolicy Bypass -File enroll.ps1 -Center <https url> -NodeBin <node.exe> -ClaudeBin <claude yo'li>
#>
param(
  [Parameter(Mandatory = $true)][string]$Center,
  [Parameter(Mandatory = $true)][string]$NodeBin,
  [Parameter(Mandatory = $true)][string]$ClaudeBin
)
$ErrorActionPreference = 'Stop'
$agentd = Join-Path $env:USERPROFILE '.commander\bin\agentd.mjs'
$code = [Console]::In.ReadLine()
if (-not $code) { throw "enrollment kodi stdin'da yo'q" }
$code | & $NodeBin $agentd enroll --center $Center --code - --claude-bin $ClaudeBin
if ($LASTEXITCODE -ne 0) { throw "enroll xatosi (exit $LASTEXITCODE)" }
