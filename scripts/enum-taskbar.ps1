Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class TaskbarEnum {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cls, string name);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct RECT { public int L; public int T; public int R; public int B; }
}
"@

function Show($label, $hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { Write-Output "$label MISSING"; return }
  $r = New-Object TaskbarEnum+RECT
  [TaskbarEnum]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $sb = New-Object System.Text.StringBuilder 256
  [void][TaskbarEnum]::GetClassName($hwnd, $sb, 256)
  Write-Output ("{0} class={1} {2}x{3} @{4},{5} vis={6}" -f $label, $sb.ToString(), ($r.R-$r.L), ($r.B-$r.T), $r.L, $r.T, [TaskbarEnum]::IsWindowVisible($hwnd))
}

$tray = [TaskbarEnum]::FindWindow("Shell_TrayWnd", $null)
Show "Shell_TrayWnd" $tray
Show "TrayNotifyWnd" ([TaskbarEnum]::FindWindowEx($tray, [IntPtr]::Zero, "TrayNotifyWnd", $null))
Show "ReBarWindow32" ([TaskbarEnum]::FindWindowEx($tray, [IntPtr]::Zero, "ReBarWindow32", $null))
Show "MSTaskSwWClass" ([TaskbarEnum]::FindWindowEx($tray, [IntPtr]::Zero, "MSTaskSwWClass", $null))
Show "Start" ([TaskbarEnum]::FindWindowEx($tray, [IntPtr]::Zero, "Start", $null))

$tr = New-Object TaskbarEnum+RECT
[TaskbarEnum]::GetWindowRect($tray, [ref]$tr) | Out-Null
Write-Output "--- windows intersecting taskbar ---"
$script:count = 0
$cb = [TaskbarEnum+EnumProc] {
  param($h, $l)
  if (-not [TaskbarEnum]::IsWindowVisible($h)) { return $true }
  $r = New-Object TaskbarEnum+RECT
  [TaskbarEnum]::GetWindowRect($h, [ref]$r) | Out-Null
  $overlap = -not ($r.R -lt $tr.L -or $r.L -gt $tr.R -or $r.B -lt $tr.T -or $r.T -gt $tr.B)
  if (-not $overlap) { return $true }
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  if ($w -lt 8 -or $hh -lt 8) { return $true }
  $sb = New-Object System.Text.StringBuilder 256
  [void][TaskbarEnum]::GetClassName($h, $sb, 256)
  $pid = [uint32]0
  [void][TaskbarEnum]::GetWindowThreadProcessId($h, [ref]$pid)
  Write-Output ("pid={0} {1} {2}x{3} @{4},{5}" -f $pid, $sb.ToString(), $w, $hh, $r.L, $r.T)
  $script:count++
  $true
}
[TaskbarEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
Write-Output ("count=$script:count")
