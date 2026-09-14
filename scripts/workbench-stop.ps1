$ErrorActionPreference = "SilentlyContinue"

# Stops the workbench watchdog and the managed server instance.

$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root "reports\tmp-workbench-watchdog.pid"

if (Test-Path $pidFile) {
  $watchdogPid = (Get-Content $pidFile | Select-Object -First 1)
  if ($watchdogPid) { Stop-Process -Id $watchdogPid -Force }
  Remove-Item $pidFile -Force
}

Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match 'start-workbench|npm run workbench|tsx scripts/start-workbench'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host "workbench watchdog and server stopped"
