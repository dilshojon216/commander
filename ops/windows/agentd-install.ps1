<#
Windows'da (FOYDALANUVCHI nomidan, admin KERAK EMAS) agentd'ni o'rnatadi:
  - bundle'ni %USERPROFILE%\.commander\bin ga qo'yadi (agentd.mjs, cc-hook.mjs, cc-statusline.mjs, cc-mcp.mjs)
  - %USERPROFILE%\.commander papkasiga ACL qo'yadi (faqat shu foydalanuvchi + SYSTEM; Windows'da chmod 0700 ishlamaydi)
  - yashirin nazoratchi ishga tushiruvchi (agentd-launch.vbs; konsol oynasi ko'rinmaydi; agentd crash bo'lsa 10 s da qayta ishga tushiradi) yozadi
  - per-user Scheduled Task "Commander agentd": shu foydalanuvchi kirganda (AtLogOn) ishga tushadi, vaqt cheklovi yo'q.
    "Faqat tizimga kirganda ishlaydi" rejimi (parol saqlanmaydi). (Task Scheduler'ning "xatoda qayta ishga tushirish" sozlamasi ham qo'yiladi,
    lekin exit kodi bo'yicha ishonchli ishlamadi: qayta ishga tushirishni nazoratchi VBS bajaradi.)
  - log: %LOCALAPPDATA%\commander\agentd.log (5 MB, bitta .1 zaxira, agentd o'zi aylantiradi)
Foydalanish:
  powershell -NoProfile -ExecutionPolicy Bypass -File agentd-install.ps1 -BundleDir <papka> [-NodeBin <node.exe>] [-NoStart]
Enroll: node "$HOME\.commander\bin\agentd.mjs" enroll --center https://<mac>.<tailnet>.ts.net --code - --claude-bin <claude.cmd>   (kod stdin'dan)
#>
param(
  [string]$BundleDir = (Join-Path $PSScriptRoot '..\..\dist-bundle'),
  [string]$NodeBin = '',
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$TaskName = 'Commander agentd'

# Eslatma: administrator foydalanuvchining SSH sessiyasi "elevated" bo'ladi: bu normal. Task baribir RunLevel Limited (oddiy huquq) bilan ishlaydi.

if (-not $NodeBin) { $NodeBin = (Get-Command node -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath $NodeBin)) { throw "node topilmadi: $NodeBin" }
$major = [int]((& $NodeBin -p 'process.versions.node').Split('.')[0])
if ($major -lt 22) { throw "Node >= 22 kerak (v$major topildi)" }

$home_ = Join-Path $env:USERPROFILE '.commander'
$bin = Join-Path $home_ 'bin'
$logDir = Join-Path $env:LOCALAPPDATA 'commander'
New-Item -ItemType Directory -Force -Path $bin, $logDir | Out-Null

# ACL: meroslik o'chiriladi, faqat joriy foydalanuvchi (SID) va SYSTEM to'liq huquq. Yangi fayllar (device.key, agentd.db) shuni meros oladi.
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $home_ /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls xatosi ($LASTEXITCODE)" }

foreach ($f in 'agentd', 'cc-hook', 'cc-statusline', 'cc-mcp') {
  $src = Join-Path $BundleDir "$f.mjs"
  if (-not (Test-Path -LiteralPath $src)) { throw "bundle fayli yo'q: $src" }
  Copy-Item -LiteralPath $src -Destination (Join-Path $bin "$f.mjs") -Force
}

# Yashirin ishga tushiruvchi: wscript konsol oynasini ko'rsatmaydi (style 0), node tugaguncha kutadi va exit kodini qaytaradi
# (Task Scheduler "xatoda qayta ishga tushirish" shunga tayanadi).
$agentd = Join-Path $bin 'agentd.mjs'
$logFile = Join-Path $logDir 'agentd.log'
$vbs = Join-Path $bin 'agentd-launch.vbs'
$cmdLine = '"""' + $NodeBin + '"" ""' + $agentd + '"" run --exit-with-parent --log-file ""' + $logFile + '"""'
@(
  "' Avtomatik yaratilgan (agentd-install.ps1). Qo'lda o'zgartirmang.",
  "' Nazoratchi: agentd 0 dan boshqa kod bilan tugasa (crash) 10 s dan keyin qayta ishga tushiradi.",
  "' Task to'xtatilsa wscript o'ladi; agentd --exit-with-parent tufayli o'zi ham tartibli to'xtaydi.",
  'Set sh = CreateObject("WScript.Shell")',
  'Do',
  "  rc = sh.Run($cmdLine, 0, True)",
  '  If rc = 0 Then Exit Do',
  '  WScript.Sleep 10000',
  'Loop',
  'WScript.Quit 0'
) | Set-Content -LiteralPath $vbs -Encoding ASCII

$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument "//B //Nologo `"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -Hidden
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Commander agentd (Claude Code sessiya agenti), faqat shu foydalanuvchi' -Force | Out-Null
Write-Output "Scheduled Task '$TaskName' ro'yxatdan o'tdi (foydalanuvchi: $user)"

$config = Join-Path $home_ 'config.json'
if ($NoStart -or -not (Test-Path -LiteralPath $config)) {
  Write-Output "Ishga tushirilmadi (enroll qiling, so'ng: Start-ScheduledTask -TaskName '$TaskName')"
  exit 0
}
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
Write-Output "ishga tushirildi | log: $logFile | holat: node `"$agentd`" status"
