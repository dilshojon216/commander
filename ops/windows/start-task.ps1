<#
Scheduled Task "Commander agentd" ni (qayta) ishga tushiradi va holatini chiqaradi. Xatoda exit 1.
  powershell -NoProfile -ExecutionPolicy Bypass -File start-task.ps1
#>
$ErrorActionPreference = 'Stop'
$name = 'Commander agentd'
Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $name
Start-Sleep -Seconds 2
Write-Output "task_state=$((Get-ScheduledTask -TaskName $name).State)"
