param(
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [string]$Arguments = '',
  [string]$WorkingDirectory = '',
  [string]$IconPath = '',
  [string]$ShortcutPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $IconPath) { $IconPath = Join-Path $env:APPDATA 'netmeter\netmeter.ico' }
if (-not $ShortcutPath) { $ShortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\NetMeter.lnk' }

foreach ($folder in @((Split-Path -Parent $IconPath), (Split-Path -Parent $ShortcutPath))) {
  if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
}

Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath {
  param([double]$X, [double]$Y, [double]$Width, [double]$Height, [double]$Radius)
  $diameter = $Radius * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)
$fill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 22, 124, 240))
$graphics.FillPath($fill, (New-RoundedRectanglePath 16 16 224 224 48))
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 15
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$points = @(
  (New-Object System.Drawing.PointF 64, 128),
  (New-Object System.Drawing.PointF 96, 128),
  (New-Object System.Drawing.PointF 115, 80),
  (New-Object System.Drawing.PointF 149, 176),
  (New-Object System.Drawing.PointF 167, 128),
  (New-Object System.Drawing.PointF 192, 128)
)
$graphics.DrawLines($pen, $points)
$graphics.Dispose()

$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$stream = [System.IO.File]::Create($IconPath)
$icon.Save($stream)
$stream.Dispose()
$bitmap.Dispose()

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $TargetPath
$shortcut.Arguments = $Arguments
$shortcut.WorkingDirectory = $WorkingDirectory
$shortcut.IconLocation = $IconPath
$shortcut.Description = 'NetMeter network traffic widget'
$shortcut.Save()

Write-Output "shortcut=$ShortcutPath"
Write-Output "icon=$IconPath"
