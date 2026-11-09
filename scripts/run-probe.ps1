param(
  [string]$Script = 'scripts/i18n-probe.cjs',
  [ValidateRange(1,3600)][int]$TimeoutSeconds = 90,
  [string[]]$ProbeArguments = @(),
  [string]$Executable = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Executable) { $Executable = Join-Path $root 'node_modules\electron\dist\electron.exe' }

function Quote-Argument([string]$Value) {
  # Escape backslashes before quotes and the closing quote for Windows argv.
  return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $Executable
$info.WorkingDirectory = $root
$info.Arguments = ((@($Script) + $ProbeArguments | ForEach-Object { Quote-Argument $_ }) -join ' ')
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $info
$code = 1
try {
  if (-not $process.Start()) { throw 'Probe process did not start.' }
  # Drain both pipes concurrently so verbose probes cannot block on output.
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $code = 124
    Write-Output ('Probe timed out after ' + $TimeoutSeconds + ' seconds; stopping its process tree.')
    & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F 2>&1 | Out-Null
    if (-not $process.WaitForExit(10000)) { throw 'Probe process did not stop after timeout.' }
  } else {
    $code = $process.ExitCode
  }
  Write-Output ('exit=' + $code)
  Write-Output '--- stderr ---'
  if ($stderr.Wait(5000)) { ($stderr.Result -split '\r?\n') | Select-Object -Last 25 }
  Write-Output '--- stdout ---'
  if ($stdout.Wait(5000)) { ($stdout.Result -split '\r?\n') | Select-Object -Last 30 }
} catch {
  Write-Output ('Probe runner failed: ' + $_.Exception.Message)
} finally {
  $process.Dispose()
}
exit $code
