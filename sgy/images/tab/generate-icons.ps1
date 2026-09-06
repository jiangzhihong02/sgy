# Generate tab bar icons v3 - bigger glyphs filling canvas.
# Usage:  powershell -ExecutionPolicy Bypass -File images\tab\generate-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$outDir = $PSScriptRoot

function New-Icon([string]$kind, [string]$path, [System.Drawing.Color]$color) {
  $bmp = New-Object System.Drawing.Bitmap 81, 81
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $pen = New-Object System.Drawing.Pen $color, 8
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  switch ($kind) {
    'feed' {
      $g.DrawEllipse($pen, 20, 11, 34, 34)
      $g.DrawLine($pen, 49, 40, 68, 60)
    }
    'chat' {
      $g.DrawEllipse($pen, 14, 18, 52, 38)
      $g.DrawLine($pen, 24, 56, 15, 64)
      $g.DrawLine($pen, 15, 64, 30, 64)
    }
    'trips' {
      $g.DrawEllipse($pen, 20, 12, 42, 42)
      $g.DrawLine($pen, 41, 24, 41, 38)
      $g.DrawLine($pen, 41, 38, 51, 45)
    }
    'profile' {
      $g.DrawEllipse($pen, 31, 9, 20, 20)
      $g.DrawArc($pen, 17, 27, 48, 38, 200, 140)
    }
  }
  $pen.Dispose(); $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$gray = [System.Drawing.Color]::FromArgb(255, 138, 144, 153)
$green = [System.Drawing.Color]::FromArgb(255, 7, 193, 96)
foreach ($k in 'feed', 'chat', 'trips', 'profile') {
  New-Icon $k (Join-Path $outDir "$k.png") $gray
  New-Icon $k (Join-Path $outDir "$k-active.png") $green
}
Write-Output 'done v3:'
Get-ChildItem $outDir -Filter *.png | Select-Object -ExpandProperty Name
