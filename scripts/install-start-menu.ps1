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
  if (-not (Test-Path -LiteralPath $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
}

# Reuse the shipped multi-size icon; never redraw the obsolete waveform.
$sourceIcon = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\assets\tray\netmeter.ico'))
if (-not (Test-Path -LiteralPath $sourceIcon)) { throw 'NetMeter app icon is missing' }
if ([System.IO.Path]::GetFullPath($IconPath) -ne $sourceIcon) {
  Copy-Item -LiteralPath $sourceIcon -Destination $IconPath -Force
}

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
