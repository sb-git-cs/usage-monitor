param([string]$Hwnd = "", [int]$Own = 0, [int]$AppPid = 0, [int]$Capture = 0, [switch]$Watch)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TaskbarLayout {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cls, string name);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFO info);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint affinity);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public struct RECT { public int L; public int T; public int R; public int B; }
  public struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public int dwFlags;
  }
}
"@

function Rect($hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  $r = New-Object TaskbarLayout+RECT
  if (-not [TaskbarLayout]::GetWindowRect($hwnd, [ref]$r)) { return $null }
  return @{ x = $r.L; y = $r.T; w = ($r.R - $r.L); h = ($r.B - $r.T) }
}

# A collapsed auto-hide taskbar leaves only a sliver on the monitor. The chips follow that:
# while the taskbar is off screen they hide, instead of sitting on a shared screen alone.
function Get-TaskbarShown {
  [void][TaskbarLayout]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
  $hwnd = [TaskbarLayout]::FindWindow("Shell_TrayWnd", $null)
  if ($hwnd -eq [IntPtr]::Zero) { return $true }
  if (-not [TaskbarLayout]::IsWindowVisible($hwnd)) { return $false }
  $bounds = Rect $hwnd
  if (-not $bounds) { return $true }
  $monitor = [TaskbarLayout]::MonitorFromWindow($hwnd, 2)
  $info = New-Object TaskbarLayout+MONITORINFO
  $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][TaskbarLayout+MONITORINFO])
  if (-not [TaskbarLayout]::GetMonitorInfo($monitor, [ref]$info)) { return $true }
  $m = $info.rcMonitor
  $left = [Math]::Max($bounds.x, $m.L)
  $top = [Math]::Max($bounds.y, $m.T)
  $right = [Math]::Min($bounds.x + $bounds.w, $m.R)
  $bottom = [Math]::Min($bounds.y + $bounds.h, $m.B)
  $iw = $right - $left
  $ih = $bottom - $top
  if ($iw -le 0 -or $ih -le 0) { return $false }
  $thick = if ($bounds.w -ge $bounds.h) { $ih } else { $iw }
  return $thick -ge 12
}

# Reads the taskbar rectangles and, when a chips window is given, applies its taskbar ownership
# and capture exclusion. GetWindowRect must return physical pixels; Electron converts them to DIP.
function Get-Layout($hwnd, $own, $apppid, $capture) {
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
  # other windows (Start menu, Quick Settings), and re-attaches them after Explorer replaces the
  # taskbar. Only a window of the calling process is touched.
  $ownerApplied = $false
  $ownerTag = $null
  if ("$hwnd" -match '^\d+$') {
    $ownerTag = "$hwnd`:$own`:$capture"
    $chips = [IntPtr]::new([Int64]$hwnd)
    $windowPid = [uint32]0
    [void][TaskbarLayout]::GetWindowThreadProcessId($chips, [ref]$windowPid)
    if ($apppid -gt 0 -and $windowPid -eq $apppid) {
      $target = if ($own -eq 1) { $trayHwnd } else { [IntPtr]::Zero }
      if ([TaskbarLayout]::GetWindowLongPtr($chips, -8) -ne $target) { [void][TaskbarLayout]::SetWindowLongPtr($chips, -8, $target) }
      $ownerApplied = ([TaskbarLayout]::GetWindowLongPtr($chips, -8) -eq $target)
      # 0x11 excludes the window from screen capture. Docked chips then are not a separate
      # bar in a share that does not include the taskbar. 0 puts a floating strip back in.
      $affinity = if ($capture -eq 1) { [uint32]0x11 } else { [uint32]0 }
      [void][TaskbarLayout]::SetWindowDisplayAffinity($chips, $affinity)
    }
  }

  return @{
    tray = $tray
    occupied = $occupied
    owner = $ownerTag
    ownerApplied = $ownerApplied
    shown = [bool](Get-TaskbarShown)
  }
}

if ($Watch) {
  # The one long-lived process also answers layout requests, so steady state spawns no new
  # PowerShell. Owner changes arrive on stdin ("own <hwnd> <own> <capture> <apppid>", "probe");
  # the async reader never blocks the 200 ms poll that reports when the taskbar slides away.
  $stdin = New-Object IO.StreamReader ([Console]::OpenStandardInput()), (New-Object Text.UTF8Encoding $false)
  $pending = $stdin.ReadLineAsync()
  $curHwnd = $Hwnd; $curOwn = $Own; $curCapture = $Capture; $curPid = $AppPid
  $previous = $null
  $lastLayout = [DateTime]::MinValue
  while ($true) {
    $force = $false
    while ($pending -and $pending.IsCompleted) {
      $line = $pending.Result
      # A closed stdin means the app is gone; do not linger as an orphan.
      if ($null -eq $line) { exit }
      $pending = $stdin.ReadLineAsync()
      $parts = $line.Split(' ')
      if ($parts[0] -eq 'own' -and $parts.Count -ge 5) {
        $curHwnd = $parts[1]; $curOwn = [int]$parts[2]; $curCapture = [int]$parts[3]; $curPid = [int]$parts[4]
        $force = $true
      } elseif ($parts[0] -eq 'probe') { $force = $true }
    }
    $shown = Get-TaskbarShown
    if ($shown -ne $previous) {
      [Console]::Out.WriteLine($(if ($shown) { "shown=1" } else { "shown=0" }))
      $previous = $shown
      $force = $true
    }
    if ($force -or ([DateTime]::UtcNow - $lastLayout).TotalSeconds -ge 8) {
      [Console]::Out.WriteLine("layout=" + ((Get-Layout $curHwnd $curOwn $curPid $curCapture) | ConvertTo-Json -Compress -Depth 4))
      $lastLayout = [DateTime]::UtcNow
    }
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds 200
  }
}

Get-Layout $Hwnd $Own $AppPid $Capture | ConvertTo-Json -Compress -Depth 4
