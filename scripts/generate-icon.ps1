$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OutIco = Join-Path $ProjectRoot "assets\qufu-usage-monitor.ico"

function New-IconPngBytes([int]$Size) {
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $s = [float]$Size
  $pad = $s * 0.06
  $box = $s - ($pad * 2)
  $radius = $box * 0.24

  # Rounded square dark slate background with subtle gradient
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc($pad, $pad, $d, $d, 180, 90)
  $path.AddArc($pad + $box - $d, $pad, $d, $d, 270, 90)
  $path.AddArc($pad + $box - $d, $pad + $box - $d, $d, $d, 0, 90)
  $path.AddArc($pad, $pad + $box - $d, $d, $d, 90, 90)
  $path.CloseFigure()

  $endPos = [float]($pad + $box)
  $p1 = New-Object System.Drawing.PointF([float]$pad, [float]$pad)
  $p2 = New-Object System.Drawing.PointF($endPos, $endPos)
  $c1 = [System.Drawing.Color]::FromArgb(255, 24, 24, 29)
  $c2 = [System.Drawing.Color]::FromArgb(255, 14, 15, 20)
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($p1, $p2, $c1, $c2)
  $g.FillPath($bgBrush, $path)

  # Subtle crisp border
  $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 68, 72, 84), [Math]::Max(1.0, $s * 0.025))
  $g.DrawPath($borderPen, $path)

  # Helper to draw a rounded pill bar
  function Draw-Bar([float]$x, [float]$y, [float]$w, [float]$h, [System.Drawing.Color]$color) {
    $r = $h / 2.0
    $bp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bd = $r * 2
    if ($w -le $bd) {
      $bp.AddEllipse($x, $y, $h, $h)
    } else {
      $bp.AddArc($x, $y, $bd, $bd, 180, 90)
      $bp.AddArc($x + $w - $bd, $y, $bd, $bd, 270, 90)
      $bp.AddArc($x + $w - $bd, $y + $h - $bd, $bd, $bd, 0, 90)
      $bp.AddArc($x, $y + $h - $bd, $bd, $bd, 90, 90)
      $bp.CloseFigure()
    }
    $br = New-Object System.Drawing.SolidBrush($color)
    $g.FillPath($br, $bp)
    $br.Dispose()
    $bp.Dispose()
  }

  # Top subtle Antigravity-inspired accent chevron/arc
  $accentPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 96, 165, 250), [Math]::Max(1.5, $s * 0.055))
  $accentPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $accentPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $accentPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $cx = $s * 0.50
  $topY = $s * 0.21
  $baseY = $s * 0.36
  $spanX = $s * 0.16
  $pts = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF([float]($cx - $spanX), [float]$baseY)),
    (New-Object System.Drawing.PointF([float]$cx, [float]$topY)),
    (New-Object System.Drawing.PointF([float]($cx + $spanX), [float]$baseY))
  )
  $g.DrawLines($accentPen, $pts)

  # 3 crisp horizontal quota meter bars (Green, Amber, Emerald)
  $barX = $s * 0.21
  $barW = $s * 0.58
  $barH = [Math]::Max(2.0, $s * 0.095)
  $trackColor = [System.Drawing.Color]::FromArgb(255, 46, 48, 56)

  $y1 = $s * 0.47
  $y2 = $s * 0.62
  $y3 = $s * 0.77

  # Bar 1: Green (82%)
  Draw-Bar $barX $y1 $barW $barH $trackColor
  Draw-Bar $barX $y1 ($barW * 0.82) $barH ([System.Drawing.Color]::FromArgb(255, 34, 197, 94))

  # Bar 2: Amber (52%)
  Draw-Bar $barX $y2 $barW $barH $trackColor
  Draw-Bar $barX $y2 ($barW * 0.52) $barH ([System.Drawing.Color]::FromArgb(255, 250, 204, 21))

  # Bar 3: Bright Green (96%)
  Draw-Bar $barX $y3 $barW $barH $trackColor
  Draw-Bar $barX $y3 ($barW * 0.96) $barH ([System.Drawing.Color]::FromArgb(255, 52, 211, 153))

  $accentPen.Dispose()
  $borderPen.Dispose()
  $bgBrush.Dispose()
  $path.Dispose()
  $g.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $arr = $ms.ToArray()
  $ms.Dispose()
  return ,$arr
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = New-Object System.Collections.Generic.List[object]
foreach ($sz in $sizes) {
  [byte[]]$pngBytes = New-IconPngBytes $sz
  $images.Add([PSCustomObject]@{ Size = $sz; Bytes = $pngBytes })
}

$outMs = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($outMs)

# ICONDIR header
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$images.Count)

$offset = 6 + (16 * $images.Count)
foreach ($img in $images) {
  $dim = if ($img.Size -ge 256) { [byte]0 } else { [byte]$img.Size }
  [byte[]]$b = $img.Bytes
  $bw.Write($dim)
  $bw.Write($dim)
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]$b.Length)
  $bw.Write([UInt32]$offset)
  $offset += $b.Length
}

foreach ($img in $images) {
  [byte[]]$b = $img.Bytes
  $bw.Write($b)
}

$bw.Flush()
[System.IO.File]::WriteAllBytes($OutIco, $outMs.ToArray())
$bw.Dispose()
$outMs.Dispose()
Write-Host "Generated multi-resolution icon: $OutIco ($((Get-Item $OutIco).Length) bytes)"
