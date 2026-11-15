<#
agentd'ni Windows'dan olib tashlaydi (admin kerak emas): Scheduled Task'ni to'xtatadi va o'chiradi, agentd jarayonini to'xtatadi,
bundle va ishga tushiruvchini o'chiradi. Kalit/config/DB (%USERPROFILE%\.commander) va log SAQLANADI; to'liq tozalash uchun -Purge
(markazda avval "device revoke" qiling).
  powershell -NoProfile -ExecutionPolicy Bypass -File agentd-uninstall.ps1 [-Purge]
#>
param([switch]$Purge)
$ErrorActionPreference = 'Stop'
$TaskName = 'Commander agentd'
$home_ = Join-Path $env:USERPROFILE '.commander'
$bin = Join-Path $home_ 'bin'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Scheduled Task o'chirildi"
}
# Task to'xtatilganda bola node qolib ketgan bo'lishi mumkin: faqat bizning agentd.mjs jarayonini to'xtatamiz.
$agentd = Join-Path $bin 'agentd.mjs'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($agentd) } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
  Write-Output "agentd jarayoni to'xtatildi (pid $($_.ProcessId))"
}
Remove-Item -LiteralPath (Join-Path $bin 'agentd.mjs'), (Join-Path $bin 'cc-hook.mjs'), (Join-Path $bin 'cc-statusline.mjs'), (Join-Path $bin 'cc-mcp.mjs'), (Join-Path $bin 'agentd-launch.vbs') -Force -ErrorAction SilentlyContinue
if ($Purge) {
  Remove-Item -LiteralPath $home_ -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $env:LOCALAPPDATA 'commander') -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output "$home_ va log o'chirildi (-Purge)"
} else {
  Write-Output "Saqlandi: $home_ (device.key, config.json, agentd.db). To'liq tozalash: -Purge"
}
