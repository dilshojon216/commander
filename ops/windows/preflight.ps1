<#
Preflight (faqat o'qiydi, hech narsani o'zgartirmaydi). Chiqish: `kalit=qiymat` qatorlari yoki `PREFLIGHT XATO:`.
#>
$ErrorActionPreference = 'Stop'
$errors = @()

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } else { '' }
if (-not $node) { $errors += "node topilmadi (PATH'da)" }
else {
  $major = [int]((& $node -p 'process.versions.node').Split('.')[0])
  if ($major -lt 22) { $errors += "Node >= 22 kerak (v$major topildi)" }
}

# claude: `where` ro'yxatidan birinchisi (npm shim: claude.cmd). Aniq yo'l config'ga yoziladi (Scheduled Task PATH'i boshqacha bo'lishi mumkin).
$claude = ''
$w = & where.exe claude 2>$null
if ($LASTEXITCODE -eq 0 -and $w) {
  $cands = @($w)
  $claude = ($cands | Where-Object { $_ -match '\.(cmd|exe)$' } | Select-Object -First 1)
  if (-not $claude) { $claude = $cands[0] }
}
if (-not $claude) { $errors += "claude topilmadi (PATH'da)" }

# Git Bash: Claude Code hook buyruqlarini shu orqali bajaradi. WSL'ning System32\bash.exe emas!
$bash = ''
$git = Get-Command git -ErrorAction SilentlyContinue
if ($env:CLAUDE_CODE_GIT_BASH_PATH -and (Test-Path -LiteralPath $env:CLAUDE_CODE_GIT_BASH_PATH)) { $bash = $env:CLAUDE_CODE_GIT_BASH_PATH }
elseif ($git) {
  $cand = Join-Path (Split-Path (Split-Path $git.Source)) 'bin\bash.exe'
  if (Test-Path -LiteralPath $cand) { $bash = $cand }
}
if (-not $bash) { $errors += "Git Bash topilmadi (Git for Windows kerak: Claude Code hook'lari bash orqali bajariladi)" }

if ($errors.Count -gt 0) { Write-Output ("PREFLIGHT XATO:" + [Environment]::NewLine + ($errors -join [Environment]::NewLine)); exit 1 }

$cfg = Join-Path $env:USERPROFILE '.commander\config.json'
$enrolled = (Test-Path -LiteralPath $cfg) -and ((Get-Content -LiteralPath $cfg -Raw) -match '"deviceId"')
$task = if (Get-ScheduledTask -TaskName 'Commander agentd' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }
Write-Output 'PREFLIGHT OK'
Write-Output "node=$node"
Write-Output "claude=$claude"
Write-Output "bash=$bash"
Write-Output "userprofile=$env:USERPROFILE"
Write-Output "enrolled=$(if ($enrolled) { 'yes' } else { 'no' })"
Write-Output "task=$task"
