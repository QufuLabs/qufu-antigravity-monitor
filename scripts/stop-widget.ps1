$ErrorActionPreference = "Stop"

$procs = Get-Process -Name "QufuUsageWidget" -ErrorAction SilentlyContinue
if ($procs) {
  $procs | Stop-Process -Force
  Write-Host "Stopped QufuUsageWidget."
} else {
  Write-Host "QufuUsageWidget is not running."
}
