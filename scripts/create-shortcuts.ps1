$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ExePath = Join-Path $ProjectRoot "widget\bin\Release\net8.0-windows\QufuUsageWidget.exe"
$IconPath = Join-Path $ProjectRoot "assets\qufu-usage-monitor.ico"
$ShortcutName = "Qufu Antigravity Monitor.lnk"

if (-not (Test-Path $ExePath)) {
  throw "QufuUsageWidget.exe not found at $ExePath. Build the widget first."
}

$wsh = New-Object -ComObject WScript.Shell

$DesktopPath = [Environment]::GetFolderPath("Desktop")
$StartMenuPath = Join-Path ([Environment]::GetFolderPath("Programs")) ""

$targets = @(
  (Join-Path $DesktopPath $ShortcutName),
  (Join-Path $StartMenuPath $ShortcutName)
)

foreach ($lnkPath in $targets) {
  $sc = $wsh.CreateShortcut($lnkPath)
  $sc.TargetPath = $ExePath
  $sc.WorkingDirectory = Split-Path -Parent $ExePath
  $sc.Description = "Qufu Antigravity Monitor (Local model quota bar)"
  if (Test-Path $IconPath) {
    $sc.IconLocation = "$IconPath,0"
  } else {
    $sc.IconLocation = "$ExePath,0"
  }
  $sc.Save()
  Write-Host "Created shortcut: $lnkPath"
}
