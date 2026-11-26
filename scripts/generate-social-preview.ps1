$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OutPng = Join-Path $ProjectRoot "assets\social-preview.png"

$W = 1280
$H = 640
$bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

# Clean dark slate background matching Antigravity dark mode
$bgRect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.PointF(0, 0)),
  (New-Object System.Drawing.PointF([float]$W, [float]$H)),
  [System.Drawing.Color]::FromArgb(255, 13, 14, 18),
  [System.Drawing.Color]::FromArgb(255, 20, 21, 27)
)
$g.FillRectangle($bgBrush, $bgRect)

function New-RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Fill-Bar([float]$x, [float]$y, [float]$w, [float]$h, [System.Drawing.Color]$c) {
  $bp = New-RoundedRect $x $y $w $h ($h / 2)
  $br = New-Object System.Drawing.SolidBrush($c)
  $g.FillPath($br, $bp)
  $br.Dispose()
  $bp.Dispose()
}

# Colors
$fgWhite = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 244, 244, 245))
$fgMuted = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 161, 161, 170))
$fgSubtle = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 113, 113, 122))
$greenBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 34, 197, 94))
$yellowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 234, 179, 8))
$trackColor = [System.Drawing.Color]::FromArgb(255, 42, 43, 52)
$greenColor = [System.Drawing.Color]::FromArgb(255, 34, 197, 94)
$yellowColor = [System.Drawing.Color]::FromArgb(255, 234, 179, 8)

# Left Column: Clean Typography (NO extra logo box)
$titleFont = New-Object System.Drawing.Font("Segoe UI", 36, [System.Drawing.FontStyle]::Bold)
$subFont = New-Object System.Drawing.Font("Segoe UI", 16.5, [System.Drawing.FontStyle]::Regular)
$chipFont = New-Object System.Drawing.Font("Segoe UI", 12.5, [System.Drawing.FontStyle]::Regular)
$footFont = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Regular)

$g.DrawString("Qufu Antigravity", $titleFont, $fgWhite, 76, 132)
$g.DrawString("Monitor", $titleFont, $fgWhite, 76, 186)

$g.DrawString("Real-time 5-hour & weekly quota bar", $subFont, $fgMuted, 78, 266)
$g.DrawString("for Google Antigravity 2.0 Desktop.", $subFont, $fgMuted, 78, 296)

# Clean feature bullets
$bulletFont = New-Object System.Drawing.Font("Segoe UI", 13.5, [System.Drawing.FontStyle]::Regular)
$bullets = @(
  "0 model tokens (official agy /usage CLI)",
  "Auto-syncs with your Antigravity theme",
  "Native MCP App + Windows topbar widget",
  "Zero telemetry · No app.asar patching"
)
$by = [float]356
foreach ($b in $bullets) {
  $g.FillEllipse($greenBrush, 82, ($by + 9), 7, 7)
  $g.DrawString($b, $bulletFont, $fgMuted, 100, $by)
  $by += 32
}

$g.DrawString("github.com/QufuLabs/qufu-antigravity-monitor", $footFont, $fgSubtle, 78, 558)

# Right Column: Faithful Antigravity Window Frame + Real Borderless Widget UI (Topbar + Expanded Drawer)
$winX = [float]548
$winY = [float]76
$winW = [float]660
$winH = [float]488
$winPath = New-RoundedRect $winX $winY $winW $winH 14
$winBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 16, 16, 20))
$winBorder = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 44, 46, 56), 1.5)
$g.FillPath($winBg, $winPath)
$g.DrawPath($winBorder, $winPath)

# Antigravity Topbar inside window frame (clipped cleanly to rounded corners)
$topH = [float]44
$topBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 22, 22, 27))
$g.SetClip($winPath)
$g.FillRectangle($topBg, $winX, $winY, $winW, $topH)
$g.ResetClip()
$g.DrawPath($winBorder, $winPath)
$topDiv = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 38, 39, 48), 1)
$g.DrawLine($topDiv, $winX, ($winY + $topH), ($winX + $winW), ($winY + $topH))

# Left menu items in Antigravity topbar
$menuFont = New-Object System.Drawing.Font("Segoe UI", 10.5, [System.Drawing.FontStyle]::Regular)
$g.DrawString("Antigravity   Workspace   View", $menuFont, $fgSubtle, ($winX + 16), ($winY + 13))

# Window controls on far right (— □ ×)
$ctrlPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 120, 122, 134), 1.3)
$g.DrawLine($ctrlPen, ($winX + $winW - 76), ($winY + 22), ($winX + $winW - 66), ($winY + 22))
$g.DrawRectangle($ctrlPen, ($winX + $winW - 52), ($winY + 17), 9, 9)
$g.DrawLine($ctrlPen, ($winX + $winW - 28), ($winY + 17), ($winX + $winW - 19), ($winY + 26))
$g.DrawLine($ctrlPen, ($winX + $winW - 19), ($winY + 17), ($winX + $winW - 28), ($winY + 26))

# Real Borderless Compact Bar sitting right in the topbar
$barX = $winX + 206
$barY = $winY + 8
$barW = [float]356
$barH = [float]28
$barPath = New-RoundedRect $barX $barY $barW $barH 6
$barBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 28, 28, 34))
$g.FillPath($barBg, $barPath)

$bBold = New-Object System.Drawing.Font("Segoe UI", 9.5, [System.Drawing.FontStyle]::Bold)
$bReg = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Regular)
$g.FillEllipse($greenBrush, ($barX + 9), ($barY + 11), 6, 6)
$g.DrawString("Gemini", $bBold, $fgWhite, ($barX + 21), ($barY + 6))
$g.DrawString("5h", $bReg, $fgSubtle, ($barX + 68), ($barY + 7))
$g.DrawString("48%", $bBold, $yellowBrush, ($barX + 86), ($barY + 6))
$g.DrawString("(3h42m)", $bReg, $fgSubtle, ($barX + 116), ($barY + 7))
$g.DrawString("· 7d", $bReg, $fgSubtle, ($barX + 165), ($barY + 7))
$g.DrawString("89%", $bBold, $greenBrush, ($barX + 190), ($barY + 6))
$g.DrawLine($topDiv, ($barX + 222), ($barY + 8), ($barX + 222), ($barY + 20))
$g.DrawString("Claude/GPT", $bBold, $fgWhite, ($barX + 229), ($barY + 6))
$g.DrawString("100%", $bBold, $greenBrush, ($barX + 305), ($barY + 6))

# Real Expanded Detail Drawer right below the compact bar (faithful to MainWindow.xaml)
$cardX = $winX + 188
$cardY = $winY + 56
$cardW = [float]392
$cardH = [float]368
$cardPath = New-RoundedRect $cardX $cardY $cardW $cardH 10
$cardBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 25, 26, 32))
$g.FillPath($cardBg, $cardPath)

# Subtle shadow under expanded card
$cardPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 42, 44, 54), 1)
$g.DrawPath($cardPen, $cardPath)

$dTitle = New-Object System.Drawing.Font("Segoe UI", 11.5, [System.Drawing.FontStyle]::Bold)
$dLbl = New-Object System.Drawing.Font("Segoe UI", 11.5, [System.Drawing.FontStyle]::Regular)
$dPct = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Bold)
$dMeta = New-Object System.Drawing.Font("Segoe UI", 10.5, [System.Drawing.FontStyle]::Regular)

$px = $cardX + 22
$pw = $cardW - 44

# Top compact header inside expanded card
$g.FillEllipse($greenBrush, $px, ($cardY + 22), 8, 8)
$g.DrawString("Gemini 5h", $dTitle, $fgWhite, ($px + 16), ($cardY + 15))
$g.DrawString("48%", $dTitle, $yellowBrush, ($px + 96), ($cardY + 15))
$g.DrawString("·  7d", $dMeta, $fgSubtle, ($px + 136), ($cardY + 16))
$g.DrawString("89%", $dTitle, $greenBrush, ($px + 174), ($cardY + 15))
$g.DrawString("Claude/GPT", $dTitle, $fgWhite, ($px + 220), ($cardY + 15))
$g.DrawString("100%", $dTitle, $greenBrush, ($px + 312), ($cardY + 15))

$g.DrawLine($topDiv, $px, ($cardY + 46), ($px + $pw), ($cardY + 46))

# Gemini Models Section
$g.DrawString("Gemini Models", $dTitle, $fgMuted, $px, ($cardY + 58))

$g.DrawString("5-Hour Limit", $dLbl, $fgWhite, $px, ($cardY + 86))
$g.DrawString("3h 42m 15s", $dMeta, $fgSubtle, ($px + 210), ($cardY + 88))
$g.DrawString("48%", $dPct, $yellowBrush, ($px + 306), ($cardY + 85))
Fill-Bar $px ($cardY + 114) $pw 7 $trackColor
Fill-Bar $px ($cardY + 114) ($pw * 0.48) 7 $yellowColor

$g.DrawString("Weekly Limit", $dLbl, $fgWhite, $px, ($cardY + 134))
$g.DrawString("6d 16h", $dMeta, $fgSubtle, ($px + 242), ($cardY + 136))
$g.DrawString("89%", $dPct, $greenBrush, ($px + 306), ($cardY + 133))
Fill-Bar $px ($cardY + 162) $pw 7 $trackColor
Fill-Bar $px ($cardY + 162) ($pw * 0.89) 7 $greenColor

$g.DrawLine($topDiv, $px, ($cardY + 186), ($px + $pw), ($cardY + 186))

# Claude & GPT Models Section
$g.DrawString("Claude & GPT Models", $dTitle, $fgMuted, $px, ($cardY + 198))

$g.DrawString("5-Hour Limit", $dLbl, $fgWhite, $px, ($cardY + 226))
$g.DrawString("Full", $dMeta, $fgSubtle, ($px + 258), ($cardY + 228))
$g.DrawString("100%", $dPct, $greenBrush, ($px + 298), ($cardY + 225))
Fill-Bar $px ($cardY + 254) $pw 7 $trackColor
Fill-Bar $px ($cardY + 254) $pw 7 $greenColor

$g.DrawString("Weekly Limit", $dLbl, $fgWhite, $px, ($cardY + 274))
$g.DrawString("Full", $dMeta, $fgSubtle, ($px + 258), ($cardY + 276))
$g.DrawString("100%", $dPct, $greenBrush, ($px + 298), ($cardY + 273))
Fill-Bar $px ($cardY + 302) $pw 7 $trackColor
Fill-Bar $px ($cardY + 302) $pw 7 $greenColor

$g.DrawLine($topDiv, $px, ($cardY + 324), ($px + $pw), ($cardY + 324))

$dFoot = New-Object System.Drawing.Font("Segoe UI", 9.5, [System.Drawing.FontStyle]::Regular)
$g.DrawString("Updated 18:45:12", $dFoot, $fgSubtle, $px, ($cardY + 336))
$g.DrawString("60s · Right-click for menu", $dFoot, $fgSubtle, ($px + 192), ($cardY + 336))

$bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Host "Regenerated faithful social preview: $OutPng ($((Get-Item $OutPng).Length) bytes)"
