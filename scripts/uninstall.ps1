$ErrorActionPreference = "Stop"

function Resolve-AgyExe {
  $defaultWin = Join-Path $env:LOCALAPPDATA "agy\bin\agy.exe"
  if (Test-Path $defaultWin) { return $defaultWin }
  $cmd = Get-Command agy -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$PluginName = "qufu-usage-monitor"
$AgyExe = Resolve-AgyExe

if ($AgyExe) {
  Write-Host "Uninstalling $PluginName via agy plugin uninstall..."
  & $AgyExe plugin uninstall $PluginName
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "agy plugin uninstall returned exit code $LASTEXITCODE."
  }
  & $AgyExe plugin list
} else {
  $PluginDir = Join-Path $env:USERPROFILE ".gemini\config\plugins\$PluginName"
  if (Test-Path $PluginDir) {
    Remove-Item -Recurse -Force $PluginDir
    Write-Host "Removed $PluginDir."
  } else {
    Write-Host "Plugin directory not found at $PluginDir."
  }
}

$ShortcutName = "Qufu Antigravity Monitor.lnk"
$shortcutPaths = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) $ShortcutName),
  (Join-Path ([Environment]::GetFolderPath("Programs")) $ShortcutName)
)
foreach ($p in $shortcutPaths) {
  if (Test-Path $p) {
    Remove-Item -Force $p
    Write-Host "Removed shortcut: $p"
  }
}

$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
if (Get-ItemProperty -Path $runKey -Name "QufuAntigravityMonitor" -ErrorAction SilentlyContinue) {
  Remove-ItemProperty -Path $runKey -Name "QufuAntigravityMonitor" -ErrorAction SilentlyContinue
  Write-Host "Removed Windows startup entry."
}
