param(
  [int]$X,
  [int]$Y,
  [int]$Width,
  [int]$Height,
  [string]$StatePath,
  [string]$StopPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:clickCount = 0
$script:statePath = $StatePath
$script:stopPath = $StopPath
$script:startedAt = [DateTime]::UtcNow
$script:form = New-Object System.Windows.Forms.Form
$script:button = New-Object System.Windows.Forms.Button
$script:form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$script:form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$script:form.Location = [System.Drawing.Point]::new($X, $Y)
$script:form.Size = [System.Drawing.Size]::new($Width, $Height)
$script:form.ShowInTaskbar = $false
$script:form.TopMost = $false
$script:button.Dock = [System.Windows.Forms.DockStyle]::Fill
$script:button.Text = 'Lower application test button: 0'
$script:form.Controls.Add($script:button)

function Write-State {
  $state = [ordered]@{
    processId = $PID
    formHandle = $script:form.Handle.ToInt64().ToString()
    buttonHandle = $script:button.Handle.ToInt64().ToString()
    clicks = $script:clickCount
  }
  $json = ConvertTo-Json -InputObject $state -Compress
  [System.IO.File]::WriteAllText($script:statePath, $json, [System.Text.UTF8Encoding]::new($false))
}

$script:button.Add_Click({
  $script:clickCount += 1
  $script:button.Text = 'Lower application test button: ' + $script:clickCount
  Write-State
})

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 100
$script:timer.Add_Tick({
  $expired = ([DateTime]::UtcNow - $script:startedAt).TotalSeconds -gt 90
  if ((Test-Path -LiteralPath $script:stopPath) -or $expired) {
    $script:timer.Stop()
    $script:form.Close()
  }
})
$script:form.Add_Shown({
  Write-State
  $script:timer.Start()
})

[System.Windows.Forms.Application]::Run($script:form)
