param(
  [Parameter(Mandatory = $true)][string]$ShortcutPath,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Write-PinResult([string]$State, [string]$Reason) {
  Write-Output (@{ state = $State; reason = $Reason } | ConvertTo-Json -Compress)
}

function Get-StartPinActions($Shell, [string]$Path) {
  $folder = $Shell.Namespace((Split-Path -Parent $Path))
  if ($null -eq $folder) { throw 'Shortcut folder is unavailable' }
  $item = $folder.ParseName((Split-Path -Leaf $Path))
  if ($null -eq $item) { throw 'Shortcut is unavailable' }
  $pin = $null
  $alreadyPinned = $false
  foreach ($verb in $item.Verbs()) {
    $name = $verb.Name.Replace('&', '').Trim()
    if ($name -match '^Unpin.*Start|(?:开始|開始).*(?:取消|解除)固定|(?:取消|解除)固定.*(?:开始|開始)') {
      $alreadyPinned = $true
    } elseif ($name -match '^Pin to Start|^固定到.*(?:开始|開始)') {
      $pin = $verb
    }
  }
  return @{ Pin = $pin; AlreadyPinned = $alreadyPinned }
}

try {
  if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
    Write-PinResult 'manual-required' 'shortcut-missing'
    exit 0
  }
  $shell = New-Object -ComObject Shell.Application
  $actions = Get-StartPinActions $shell $ShortcutPath
  if ($actions.AlreadyPinned) {
    Write-PinResult 'already-pinned' 'unpin-verb-present'
    exit 0
  }
  if ($CheckOnly) {
    if ($null -ne $actions.Pin) { Write-PinResult 'pin-available' 'check-only' }
    else { Write-PinResult 'manual-required' 'pin-verb-unavailable' }
    exit 0
  }
  if ($null -eq $actions.Pin) {
    Write-PinResult 'manual-required' 'pin-verb-unavailable'
    exit 0
  }
  # Only invoke the actual Pin verb, never an Unpin verb or registry workaround.
  $actions.Pin.DoIt()
  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    Start-Sleep -Milliseconds 150
    $confirmed = Get-StartPinActions $shell $ShortcutPath
    if ($confirmed.AlreadyPinned) {
      Write-PinResult 'pinned' 'unpin-verb-confirmed'
      exit 0
    }
  }
  Write-PinResult 'manual-required' 'not-confirmed'
} catch {
  # Modern Windows can reject programmatic Start pinning (E_ACCESSDENIED).
  # The app must show its user-driven Explorer flow instead of claiming success.
  Write-PinResult 'manual-required' 'native-request-blocked'
}
