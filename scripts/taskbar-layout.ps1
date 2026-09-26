param([string]$Hwnd = "", [int]$Own = 0, [int]$AppPid = 0)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TaskbarLayout {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cls, string name);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public struct RECT { public int L; public int T; public int R; public int B; }
}
"@

function Rect($hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  $r = New-Object TaskbarLayout+RECT
  if (-not [TaskbarLayout]::GetWindowRect($hwnd, [ref]$r)) { return $null }
  return @{ x = $r.L; y = $r.T; w = ($r.R - $r.L); h = ($r.B - $r.T) }
}

# GetWindowRect must return physical pixels; Electron converts them to DIP.
[void][TaskbarLayout]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$trayHwnd = [TaskbarLayout]::FindWindow("Shell_TrayWnd", $null)
$tray = Rect $trayHwnd
$occupied = @()
if ($trayHwnd -ne [IntPtr]::Zero) {
  foreach ($cls in @("TrayNotifyWnd", "ReBarWindow32", "MSTaskSwWClass", "Start")) {
    $child = [TaskbarLayout]::FindWindowEx($trayHwnd, [IntPtr]::Zero, $cls, $null)
    $rr = Rect $child
    if ($rr -and $rr.w -gt 8 -and $rr.h -gt 8) {
      $occupied += @{ name = $cls; x = $rr.x; y = $rr.y; w = $rr.w; h = $rr.h }
    }
  }
}

# Owning the chips by the taskbar keeps them visible when Windows raises the taskbar above
# other windows (Start menu, Quick Settings). Only a window of the calling process is touched.
$ownerApplied = $false
if ($Hwnd -match '^\d+$') {
  $chips = [IntPtr]::new([Int64]$Hwnd)
  $windowPid = [uint32]0
  [void][TaskbarLayout]::GetWindowThreadProcessId($chips, [ref]$windowPid)
  if ($AppPid -gt 0 -and $windowPid -eq $AppPid) {
    $target = if ($Own -eq 1) { $trayHwnd } else { [IntPtr]::Zero }
    if ([TaskbarLayout]::GetWindowLongPtr($chips, -8) -ne $target) { [void][TaskbarLayout]::SetWindowLongPtr($chips, -8, $target) }
    $ownerApplied = ([TaskbarLayout]::GetWindowLongPtr($chips, -8) -eq $target)
  }
}

$result = @{
  tray = $tray
  occupied = $occupied
  ownerApplied = $ownerApplied
}
$result | ConvertTo-Json -Compress -Depth 4
