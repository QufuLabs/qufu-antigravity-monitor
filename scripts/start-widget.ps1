$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ExePath = Join-Path $ProjectRoot "widget\bin\Release\net8.0-windows\QufuUsageWidget.exe"

if (-not (Test-Path $ExePath)) {
  Write-Host "Building QufuUsageWidget..."
  dotnet build (Join-Path $ProjectRoot "widget\QufuUsageWidget.csproj") -c Release --nologo
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to build QufuUsageWidget."
  }
}

Start-Process -FilePath $ExePath
Write-Host "Qufu Usage Widget started ($ExePath)."
