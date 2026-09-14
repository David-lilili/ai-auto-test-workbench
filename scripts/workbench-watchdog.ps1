param(
  [int]$Port = 54319
)
$ErrorActionPreference = "SilentlyContinue"

# Workbench watchdog: starts the local server hidden at login and restarts it if it dies.
# Managed port only; a manually started `npm run workbench -- --port <other>` is untouched.

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "reports"
$logFile = Join-Path $logDir "tmp-workbench-watchdog.log"
$pidFile = Join-Path $logDir "tmp-workbench-watchdog.pid"
$serverLog = Join-Path $logDir "tmp-workbench-server.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log([string]$message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  # keep the log small: drop the oldest half when it grows past ~200KB
  if ((Get-Item $logFile -ErrorAction SilentlyContinue).Length -gt 200KB) {
    $lines = Get-Content $logFile
    $lines | Select-Object -Skip ([int]($lines.Count / 2)) | Set-Content $logFile -Encoding UTF8
  }
}

# single-instance guard
if (Test-Path $pidFile) {
  $existingPid = (Get-Content $pidFile | Select-Object -First 1)
  if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) { exit 0 }
}
"$PID" | Set-Content $pidFile

function Test-WorkbenchHealthy {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port" -TimeoutSec 3
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Stop-StaleWorkbench {
  Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match 'start-workbench|npm run workbench|tsx scripts/start-workbench' -and $_.ProcessId -ne $PID
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
}

Write-Log "watchdog started (pid=$PID, port=$Port)"

while ($true) {
  if (-not (Test-WorkbenchHealthy)) {
    Write-Log "workbench not healthy on port $Port, (re)starting"
    Stop-StaleWorkbench
    if (Test-Path $serverLog) { Remove-Item $serverLog -Force }
    Start-Process -FilePath "cmd.exe" `
      -ArgumentList "/d", "/s", "/c", "npm run workbench -- --port $Port > reports/tmp-workbench-server.log 2>&1" `
      -WorkingDirectory $root -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 3
      if (Test-WorkbenchHealthy) { Write-Log "workbench healthy on port $Port"; break }
    }
    if (-not (Test-WorkbenchHealthy)) { Write-Log "workbench still unhealthy after 30s; will retry next cycle" }
  }
  Start-Sleep -Seconds 30
}
