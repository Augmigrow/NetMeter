# Starts the NetMeter desktop app and waits until the local collector answers.
$root = 'C:\Users\augmigrow\projects\NetMeter'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like '*NetMeter*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
$process = Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $root -PassThru
Write-Output ('started pid=' + $process.Id)
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Seconds 1
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:4174/api/status' -UseBasicParsing -TimeoutSec 3
    Write-Output ('status=' + $response.Content)
    $ready = $true
    break
  } catch {
    # keep waiting for the local collector to bind
  }
}
if (-not $ready) { Write-Output 'status=NOT READY' }
Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table -AutoSize
