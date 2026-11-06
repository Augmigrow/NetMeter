 # Live visual acceptance: open the history panel in the running widget window by
 # clicking the domain text, hover the average-speed curve and capture the result.
param(
  [int]$ProcessId = 0,
  [string]$OutFile = 'C:\Users\augmigrow\projects\NetMeter\docs\screenshots\live-history-hover.png'
)

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LiveCheck {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

function Get-WidgetWindow {
  $found = $null
  $callback = [LiveCheck+EnumWindowsProc]{
    param($h, $l)
    $pid2 = 0
    [void][LiveCheck]::GetWindowThreadProcessId($h, [ref]$pid2)
    if ($ProcessId -eq 0 -or $pid2 -eq $ProcessId) {
      if ([LiveCheck]::IsWindowVisible($h)) {
        $len = [LiveCheck]::GetWindowTextLength($h)
        if ($len -gt 0) {
          $sb = New-Object System.Text.StringBuilder ($len + 2)
          [void][LiveCheck]::GetWindowText($h, $sb, $sb.Capacity)
          # The widget window is the small one; the settings window is much wider.
          if ($sb.ToString() -like 'NetMeter*') {
            $rect = New-Object LiveCheck+RECT
            [void][LiveCheck]::GetWindowRect($h, [ref]$rect)
            $width = $rect.Right - $rect.Left
            # Skip minimised windows: their rect is reported at -32000 with a stub size.
            if ($width -lt 500 -and $rect.Left -gt -1000) {
              if (-not $script:found -or $width -gt $script:found.Width) {
                $script:found = [pscustomobject]@{
                  Handle = $h; Title = $sb.ToString(); Left = $rect.Left; Top = $rect.Top
                  Width = $width; Height = $rect.Bottom - $rect.Top
                }
              }
            }
          }
        }
      }
    }
    return $true
  }
  [void][LiveCheck]::EnumWindows($callback, [IntPtr]::Zero)
  return $script:found
}

$widget = Get-WidgetWindow
if (-not $widget) { Write-Output 'widget window not found'; exit 1 }
Write-Output ('widget before: ' + $widget.Width + 'x' + $widget.Height + ' at ' + $widget.Left + ',' + $widget.Top)

if ($widget.Width -lt 300) {
  # Click the first tile's domain text, the only history entry point.
  $clickX = $widget.Left + 55
  $clickY = $widget.Top + 15
  [void][LiveCheck]::SetCursorPos($clickX, $clickY)
  Start-Sleep -Milliseconds 200
  [LiveCheck]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [LiveCheck]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 1200
}

$widget = Get-WidgetWindow
Write-Output ('widget after: ' + $widget.Width + 'x' + $widget.Height + ' at ' + $widget.Left + ',' + $widget.Top)

# Switch to the average speed tab (the second button of the tab row).
[void][LiveCheck]::SetCursorPos($widget.Left + 100, $widget.Top + 121)
Start-Sleep -Milliseconds 200
[LiveCheck]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[LiveCheck]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 900

# Hover the average speed curve: the svg fills the chart area of the 380x306 panel.
$hoverX = $widget.Left + 16 + [int](348 * 0.62)
$hoverY = $widget.Top + 166 + [int](126 * 0.45)
[void][LiveCheck]::SetCursorPos($hoverX, $hoverY)
Start-Sleep -Milliseconds 700
[LiveCheck]::mouse_event(0x0001, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
[void][LiveCheck]::SetCursorPos($hoverX, $hoverY)
Start-Sleep -Milliseconds 200
[LiveCheck]::mouse_event(0x0001, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 700

$bitmap = New-Object System.Drawing.Bitmap $widget.Width, $widget.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($widget.Left, $widget.Top, 0, 0, $bitmap.Size)
$bitmap.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output ('captured ' + $OutFile)
