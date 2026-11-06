param([string]$Script = 'scripts/i18n-probe.cjs')

$root = 'C:\Users\augmigrow\projects\NetMeter'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$out = Join-Path $root 'scripts\probe-out.txt'
$err = Join-Path $root 'scripts\probe-err.txt'
Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
$process = Start-Process -FilePath (Join-Path $root 'node_modules\electron\dist\electron.exe') `
  -ArgumentList $Script -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
$process.WaitForExit(90000) | Out-Null
Write-Output ('exit=' + $process.ExitCode)
Write-Output '--- stderr ---'
Get-Content $err -ErrorAction SilentlyContinue | Select-Object -Last 25
Write-Output '--- stdout ---'
Get-Content $out -ErrorAction SilentlyContinue | Select-Object -Last 30
