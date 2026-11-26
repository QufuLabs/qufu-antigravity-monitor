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

# Background dark gradient
$bgRect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.PointF(0, 0)),
  (New-Object System.Drawing.PointF([float]$W, [float]$H)),
  [System.Drawing.Color]::FromArgb(255, 14, 15, 20),
  [System.Drawing.Color]::FromArgb(255, 22, 24, 32)
)
$g.FillRectangle($bgBrush, $bgRect)

# Subtle ambient glow behind pill
$glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowPath.AddEllipse(220, 260, 840, 280)
$glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
$glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(34, 56, 189, 248)
$glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 14, 15, 20))
$g.FillPath($glowBrush, $glowPath)

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

# Logo badge (left-aligned with title)
$logoPath = New-RoundedRect 96 108 76 76 18
$logoBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 24, 25, 32))
$logoBorder = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 68, 72, 86), 2)
$g.FillPath($logoBg, $logoPath)
$g.DrawPath($logoBorder, $logoPath)

$accentPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 96, 165, 250), 4.5)
$accentPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$accentPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$accentPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$pts = [System.Drawing.PointF[]]@(
  (New-Object System.Drawing.PointF(122, 134)),
  (New-Object System.Drawing.PointF(134, 122)),
  (New-Object System.Drawing.PointF(146, 134))
)
$g.DrawLines($accentPen, $pts)

function Fill-MiniBar([float]$x, [float]$y, [float]$w, [float]$h, [System.Drawing.Color]$c) {
  $bp = New-RoundedRect $x $y $w $h ($h / 2)
  $br = New-Object System.Drawing.SolidBrush($c)
  $g.FillPath($br, $bp)
  $br.Dispose()
  $bp.Dispose()
}

$trackC = [System.Drawing.Color]::FromArgb(255, 46, 48, 58)
Fill-MiniBar 112 144 44 6 $trackC
Fill-MiniBar 112 144 36 6 ([System.Drawing.Color]::FromArgb(255, 34, 197, 94))
Fill-MiniBar 112 155 44 6 $trackC
Fill-MiniBar 112 155 24 6 ([System.Drawing.Color]::FromArgb(255, 250, 204, 21))
Fill-MiniBar 112 166 44 6 $trackC
Fill-MiniBar 112 166 42 6 ([System.Drawing.Color]::FromArgb(255, 52, 211, 153))

# Title & Subtitle
$titleFont = New-Object System.Drawing.Font("Segoe UI", 38, [System.Drawing.FontStyle]::Bold)
$subFont = New-Object System.Drawing.Font("Segoe UI", 19, [System.Drawing.FontStyle]::Regular)
$fgWhite = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 244, 244, 245))
$fgMuted = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 161, 161, 170))

$g.DrawString("Qufu Antigravity Monitor", $titleFont, $fgWhite, 196, 108)
$g.DrawString("Zero-token local quota monitor (MCP App + Windows always-on-top bar)", $subFont, $fgMuted, 96, 206)

# Live Widget Preview Mockup Pill
$pillPath = New-RoundedRect 96 296 1088 92 18
$pillBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 24, 25, 31))
$pillBorder = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 58, 61, 72), 1.5)
$g.FillPath($pillBg, $pillPath)
$g.DrawPath($pillBorder, $pillPath)

$dotGreen = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 34, 197, 94))
$g.FillEllipse($dotGreen, 132, 334, 16, 16)

$pillBold = New-Object System.Drawing.Font("Segoe UI", 20, [System.Drawing.FontStyle]::Bold)
$pillReg = New-Object System.Drawing.Font("Segoe UI", 18, [System.Drawing.FontStyle]::Regular)
$greenBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 34, 197, 94))
$yellowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 234, 179, 8))
$subtleBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 125, 128, 140))

$g.DrawString("Gemini", $pillBold, $fgWhite, 168, 323)
$g.DrawString("5h", $pillReg, $subtleBrush, 286, 326)
$g.DrawString("48%", $pillBold, $yellowBrush, 328, 323)
$g.DrawString("(3h42m)", $pillReg, $subtleBrush, 400, 326)
$g.DrawString("·  7d", $pillReg, $subtleBrush, 512, 326)
$g.DrawString("89%", $pillBold, $greenBrush, 578, 323)

$sepPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 58, 61, 72), 2)
$g.DrawLine($sepPen, 668, 322, 668, 362)

$g.DrawString("Claude/GPT", $pillBold, $fgWhite, 694, 323)
$g.DrawString("5h", $pillReg, $subtleBrush, 874, 326)
$g.DrawString("100%", $pillBold, $greenBrush, 916, 323)
$g.DrawString("·  7d", $pillReg, $subtleBrush, 1002, 326)
$g.DrawString("100%", $pillBold, $greenBrush, 1068, 323)

# Feature chips at bottom
$chipFont = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Regular)
$chips = @("0 Model Tokens", "Zero Telemetry", "Auto Theme Sync", "MCP Apps + Windows 10/11", "MIT License")
$cx = [float]96
foreach ($c in $chips) {
  $sz = $g.MeasureString($c, $chipFont)
  $cw = $sz.Width + 32
  $cp = New-RoundedRect $cx 448 $cw 42 10
  $cBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 30, 32, 40))
  $cPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 52, 55, 68), 1)
  $g.FillPath($cBg, $cp)
  $g.DrawPath($cPen, $cp)
  $g.DrawString($c, $chipFont, $fgMuted, ($cx + 16), 456)
  $cBg.Dispose()
  $cPen.Dispose()
  $cp.Dispose()
  $cx += $cw + 16
}

# Footer repo URL
$footFont = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Regular)
$g.DrawString("github.com/QufuLabs/qufu-antigravity-monitor", $footFont, $subtleBrush, 96, 556)

$bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Host "Generated social preview: $OutPng ($((Get-Item $OutPng).Length) bytes)"
