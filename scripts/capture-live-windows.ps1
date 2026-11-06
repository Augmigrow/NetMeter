 # Captures the on-screen rectangles of the running NetMeter windows for visual acceptance.
param(
  [int]$ProcessId = 0,
  [string]$OutDir = 'C:\Users\augmigrow\projects\NetMeter\docs\screenshots'
)

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32Cap {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$found = New-Object System.Collections.ArrayList
$callback = [Win32Cap+EnumWindowsProc]{
  param($h, $l)
  $pid2 = 0
  [void][Win32Cap]::GetWindowThreadProcessId($h, [ref]$pid2)
  if ($ProcessId -eq 0 -or $pid2 -eq $ProcessId) {
    if ([Win32Cap]::IsWindowVisible($h)) {
      $len = [Win32Cap]::GetWindowTextLength($h)
      if ($len -gt 0) {
        $sb = New-Object System.Text.StringBuilder ($len + 2)
        [void][Win32Cap]::GetWindowText($h, $sb, $sb.Capacity)
        $rect = New-Object Win32Cap+RECT
        [void][Win32Cap]::GetWindowRect($h, [ref]$rect)
        [void]$found.Add([pscustomobject]@{
          Handle = $h; Title = $sb.ToString(); Pid = $pid2
          Left = $rect.Left; Top = $rect.Top
          Width = $rect.Right - $rect.Left; Height = $rect.Bottom - $rect.Top
        })
      }
    }
  }
  return $true
}
[void][Win32Cap]::EnumWindows($callback, [IntPtr]::Zero)

foreach ($win in $found) {
  if ($win.Width -le 0 -or $win.Height -le 0) { continue }
  $name = ($win.Title -replace '[\\/:*?"<>| ]', '_')
  $path = Join-Path $OutDir ('live-' + $name + '.png')
  $bitmap = New-Object System.Drawing.Bitmap $win.Width, $win.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($win.Left, $win.Top, 0, 0, $bitmap.Size)
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
  Write-Output ('captured pid=' + $win.Pid + ' title=' + $win.Title + ' -> ' + $path)
}
