param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Resolve-AgyExe {
  $defaultWin = Join-Path $env:LOCALAPPDATA "agy\bin\agy.exe"
  if (Test-Path $defaultWin) { return $defaultWin }
  $cmd = Get-Command agy -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$AgyExe = Resolve-AgyExe
if (-not $AgyExe) {
  Write-Error "Antigravity CLI (agy) was not found. Install it first: irm https://antigravity.google/cli/install.ps1 | iex"
  exit 1
}

if (-not $SkipBuild) {
  Write-Host "Building Qufu Usage Monitor..."
  Push-Location $ProjectRoot
  try {
    if (-not (Test-Path (Join-Path $ProjectRoot "node_modules"))) {
      npm install --no-audit --no-fund
    }
    npm run build
  } finally {
    Pop-Location
  }
}

$StageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("qufu-usage-monitor-stage-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $StageDir "assets") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $StageDir "dist") | Out-Null

try {
  Copy-Item (Join-Path $ProjectRoot "plugin.json") $StageDir
  Copy-Item (Join-Path $ProjectRoot "mcp_config.json") $StageDir
  Copy-Item (Join-Path $ProjectRoot "README.md") $StageDir
  Copy-Item (Join-Path $ProjectRoot "assets\logo.svg") (Join-Path $StageDir "assets\logo.svg")
  Copy-Item (Join-Path $ProjectRoot "dist\mcp-server.mjs") (Join-Path $StageDir "dist\mcp-server.mjs")
  Copy-Item (Join-Path $ProjectRoot "dist\ui.html") (Join-Path $StageDir "dist\ui.html")

  Write-Host "Validating staged plugin with agy plugin validate --strict..."
  & $AgyExe plugin validate --strict $StageDir
  if ($LASTEXITCODE -ne 0) {
    throw "Plugin validation failed with exit code $LASTEXITCODE"
  }

  Write-Host "Installing Qufu Usage Monitor via agy plugin install..."
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $installOutput = & $AgyExe plugin install $StageDir 2>&1
    $installExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevPref
  }
  if ($installExit -ne 0) {
    $errText = ($installOutput | Out-String)
    # On Windows, when Antigravity Desktop is running, its directory watcher on
    # ~/.gemini/config/plugins can lock agy's temp .install-* directory during rename.
    # Fall back to the official documented global plugin folder copy (~/.gemini/config/plugins/<name>).
    if ($errText -match "rename.*plugins") {
      Write-Warning "agy plugin install hit a Windows directory-watcher rename lock while Antigravity Desktop is open. Installing directly into ~/.gemini/config/plugins/qufu-usage-monitor (official global plugin path)..."
      $TargetDir = Join-Path $env:USERPROFILE ".gemini\config\plugins\qufu-usage-monitor"
      New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir "assets") | Out-Null
      New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir "dist") | Out-Null
      Copy-Item -Force (Join-Path $StageDir "plugin.json") $TargetDir
      Copy-Item -Force (Join-Path $StageDir "mcp_config.json") $TargetDir
      Copy-Item -Force (Join-Path $StageDir "README.md") $TargetDir
      Copy-Item -Force (Join-Path $StageDir "assets\logo.svg") (Join-Path $TargetDir "assets\logo.svg")
      Copy-Item -Force (Join-Path $StageDir "dist\mcp-server.mjs") (Join-Path $TargetDir "dist\mcp-server.mjs")
      Copy-Item -Force (Join-Path $StageDir "dist\ui.html") (Join-Path $TargetDir "dist\ui.html")
    } else {
      Write-Error $errText
      throw "Plugin installation failed with exit code $installExit"
    }
  } else {
    Write-Host ($installOutput | Out-String)
  }

  Write-Host "Validating installed plugin directory..."
  $InstalledDir = Join-Path $env:USERPROFILE ".gemini\config\plugins\qufu-usage-monitor"
  & $AgyExe plugin validate --strict $InstalledDir
  if ($LASTEXITCODE -ne 0) {
    throw "Installed plugin validation failed with exit code $LASTEXITCODE"
  }

  Write-Host "Verifying installed plugins..."
  & $AgyExe plugin list
  Write-Host "`nDone. Open Qufu Usage Monitor in Antigravity Desktop from:"
  Write-Host "  - Side Panel: Overview > Plugins > Usage Monitor (or right-click tab > Pin Tab)"
  Write-Host "  - Left Sidebar: Plugins > Usage Monitor"
} finally {
  if (Test-Path $StageDir) {
    Remove-Item -Recurse -Force $StageDir -ErrorAction SilentlyContinue
  }
}
