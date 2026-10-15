# Long-lived terminal helper for coding sessions. Usage Monitor keeps one copy running and writes
# one JSON request per line on stdin; each request gets one JSON line back. The loop ends when
# stdin closes, so the process never outlives the app.
#   {"op":"scan","pids":[1,2],"names":["codex"],"only":{"name":"node","cmd":"regex"}}  start time, folder,
#     command line and parent of those processes; "only" drops processes of that name whose command line does not match
#   {"op":"type","pid":1,"start":"...","text":"continue","expect":"regex"}  types the text, then Enter,
#     into that console, only while its screen shows text matching expect (the limit message,
#     or a permission prompt). Empty text sends Enter alone. "lines":N checks only the last N
#     non-blank lines. A miss returns shown:false and types nothing.
#   {"op":"peek","pid":1,"start":"...","expect":"regex","lines":N}  the same screen check, typing nothing
#   {"op":"screen","pid":1,"start":"...","lines":N}  the last N non-blank lines of that console, or null
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class SessionConsole {
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_BASIC_INFORMATION { public IntPtr Reserved1; public IntPtr PebBaseAddress; public IntPtr Reserved2a; public IntPtr Reserved2b; public IntPtr UniqueProcessId; public IntPtr Reserved3; }

  [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
  struct KEY_EVENT_RECORD {
    [FieldOffset(0)] public int bKeyDown;
    [FieldOffset(4)] public ushort wRepeatCount;
    [FieldOffset(6)] public ushort wVirtualKeyCode;
    [FieldOffset(8)] public ushort wVirtualScanCode;
    [FieldOffset(10)] public char UnicodeChar;
    [FieldOffset(12)] public uint dwControlKeyState;
  }

  [StructLayout(LayoutKind.Explicit)]
  struct INPUT_RECORD { [FieldOffset(0)] public ushort EventType; [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent; }

  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct SCREEN_INFO { public COORD Size; public COORD Cursor; public ushort Attributes; public SMALL_RECT Window; public COORD MaxSize; }
  [DllImport("kernel32.dll")] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out SCREEN_INFO info);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool ReadConsoleOutputCharacterW(IntPtr h, System.Text.StringBuilder buf, int len, COORD at, out int read);

  // The last non-blank lines of that console's screen, where a terminal app shows its latest message.
  static string ScreenText(int rows, int lastLines) {
    IntPtr output = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (output == new IntPtr(-1)) return null;
    try {
      SCREEN_INFO info;
      if (!GetConsoleScreenBufferInfo(output, out info)) return null;
      List<string> lines = new List<string>();
      for (int y = Math.Max(0, info.Window.Bottom - rows + 1); y <= info.Window.Bottom; y++) {
        System.Text.StringBuilder line = new System.Text.StringBuilder(info.Size.X);
        COORD at; at.X = 0; at.Y = (short)y; int read;
        if (!ReadConsoleOutputCharacterW(output, line, info.Size.X, at, out read)) continue;
        string text = line.ToString(0, read).Trim();
        if (text.Length > 0) lines.Add(text);
      }
      return String.Join("\n", lines.GetRange(Math.Max(0, lines.Count - lastLines), Math.Min(lines.Count, lastLines)));
    } finally { CloseHandle(output); }
  }

  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION info, int len, out int ret);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(int pid);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] recs, int n, out int written);
  [DllImport("user32.dll")] static extern short VkKeyScanW(char ch);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint type);

  const uint QUERY_INFO = 0x0400, VM_READ = 0x0010;

  static IntPtr ReadPtr(IntPtr h, IntPtr addr) {
    byte[] b = new byte[8]; IntPtr n;
    if (!ReadProcessMemory(h, addr, b, 8, out n)) return IntPtr.Zero;
    return new IntPtr(BitConverter.ToInt64(b, 0));
  }

  // A UNICODE_STRING inside RTL_USER_PROCESS_PARAMETERS (64-bit layout).
  static string ReadUnicode(IntPtr h, IntPtr addr) {
    byte[] head = new byte[16]; IntPtr n;
    if (!ReadProcessMemory(h, addr, head, 16, out n)) return null;
    int len = BitConverter.ToUInt16(head, 0);
    IntPtr buf = new IntPtr(BitConverter.ToInt64(head, 8));
    if (len == 0 || len > 65534 || buf == IntPtr.Zero) return null;
    byte[] text = new byte[len];
    if (!ReadProcessMemory(h, buf, text, len, out n)) return null;
    return System.Text.Encoding.Unicode.GetString(text);
  }

  // [folder, command line, parent id] of a 64-bit process owned by this user; nulls when unreadable.
  public static string[] Details(int pid) {
    string[] result = new string[3];
    IntPtr h = OpenProcess(QUERY_INFO | VM_READ, false, pid);
    if (h == IntPtr.Zero) return result;
    try {
      bool wow;
      if (IntPtr.Size != 8 || (IsWow64Process(h, out wow) && wow)) return result;
      PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION(); int ret;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return result;
      result[2] = pbi.Reserved3.ToInt64().ToString();
      IntPtr parameters = ReadPtr(h, pbi.PebBaseAddress + 0x20);
      if (parameters == IntPtr.Zero) return result;
      result[0] = ReadUnicode(h, parameters + 0x38);
      result[1] = ReadUnicode(h, parameters + 0x70);
    } finally { CloseHandle(h); }
    return result;
  }

  static INPUT_RECORD Key(char ch, ushort vk, bool down) {
    INPUT_RECORD r = new INPUT_RECORD();
    r.EventType = 1;
    r.KeyEvent.bKeyDown = down ? 1 : 0;
    r.KeyEvent.wRepeatCount = 1;
    r.KeyEvent.wVirtualKeyCode = vk;
    r.KeyEvent.wVirtualScanCode = (ushort)MapVirtualKeyW(vk, 0);
    r.KeyEvent.UnicodeChar = ch;
    return r;
  }

  static bool Write(IntPtr input, List<INPUT_RECORD> recs) {
    int written;
    return WriteConsoleInputW(input, recs.ToArray(), recs.Count, out written) && written == recs.Count;
  }

  // Types the text into the console of that process, then Enter. Enter is sent separately after
  // a pause: terminal apps treat a fast burst that ends in Enter as a paste and add a new line.
  // With expect set, nothing is typed unless the screen shows it: the limit was hit in this terminal.
  // Whether that console's screen shows text matching expect; null when it cannot be read.
  public static bool? Shows(int pid, string expect, int lastLines) {
    FreeConsole();
    if (!AttachConsole(pid)) return null;
    SetConsoleCtrlHandler(IntPtr.Zero, true);
    try {
      string screen = ScreenText(120, lastLines > 0 ? lastLines : 120);
      if (screen == null) return null;
      return System.Text.RegularExpressions.Regex.IsMatch(screen, expect, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    } finally {
      FreeConsole();
      SetConsoleCtrlHandler(IntPtr.Zero, false);
    }
  }

  // The newest non-blank lines of that console; null when it has none or cannot be read.
  public static string Screen(int pid, int lastLines) {
    FreeConsole();
    if (!AttachConsole(pid)) return null;
    SetConsoleCtrlHandler(IntPtr.Zero, true);
    try {
      string text = ScreenText(120, lastLines > 0 ? lastLines : 120);
      // Control characters left in a cell would break the JSON reply.
      return text == null ? null : System.Text.RegularExpressions.Regex.Replace(text, "[\x00-\x09\x0B-\x1F]", " ");
    } finally {
      FreeConsole();
      SetConsoleCtrlHandler(IntPtr.Zero, false);
    }
  }

  // lastLines limits the check to the newest lines, so an older message that scrolled up does not count.
  public static string Type(int pid, string text, int enterDelayMs, string expect, int lastLines) {
    FreeConsole();
    if (!AttachConsole(pid)) return "no console (" + Marshal.GetLastWin32Error() + ")";
    SetConsoleCtrlHandler(IntPtr.Zero, true);
    try {
      if (!String.IsNullOrEmpty(expect)) {
        string screen = ScreenText(120, lastLines > 0 ? lastLines : 120);
        if (screen == null) return "terminal screen unreadable";
        if (!System.Text.RegularExpressions.Regex.IsMatch(screen, expect, System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return "not shown";
      }
      IntPtr input = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (input == new IntPtr(-1)) return "console input unavailable (" + Marshal.GetLastWin32Error() + ")";
      try {
        List<INPUT_RECORD> recs = new List<INPUT_RECORD>();
        if (text != null) foreach (char ch in text) {
          ushort vk = (ushort)(VkKeyScanW(ch) & 0xff);
          if (vk == 0xff) vk = 0;
          recs.Add(Key(ch, vk, true));
          recs.Add(Key(ch, vk, false));
        }
        if (recs.Count > 0 && !Write(input, recs)) return "typing failed (" + Marshal.GetLastWin32Error() + ")";
        Thread.Sleep(enterDelayMs);
        List<INPUT_RECORD> enter = new List<INPUT_RECORD>();
        enter.Add(Key('\r', 0x0D, true));
        enter.Add(Key('\r', 0x0D, false));
        if (!Write(input, enter)) return "Enter failed (" + Marshal.GetLastWin32Error() + ")";
        return null;
      } finally { CloseHandle(input); }
    } finally {
      FreeConsole();
      SetConsoleCtrlHandler(IntPtr.Zero, false);
    }
  }
}
'@

function Get-Start($proc) {
  try { return $proc.StartTime.ToFileTimeUtc().ToString() } catch { return $null }
}

function Get-Scan($req) {
  $seen = @{}
  $procs = @()
  $found = @()
  foreach ($id in @($req.pids)) { try { $found += [Diagnostics.Process]::GetProcessById([int]$id) } catch {} }
  foreach ($name in @($req.names)) { try { $found += [Diagnostics.Process]::GetProcessesByName([string]$name) } catch {} }
  foreach ($p in $found) {
    if ($seen.ContainsKey($p.Id)) { continue }
    $seen[$p.Id] = $true
    $details = [SessionConsole]::Details($p.Id)
    # "only": a name whose command line must match, so other node.exe programs are not sent back.
    if ($req.only -and $p.ProcessName -eq [string]$req.only.name -and [string]$details[1] -notmatch [string]$req.only.cmd) { continue }
    $procs += @{ pid = $p.Id; name = $p.ProcessName; start = (Get-Start $p); cwd = $details[0]; cmd = $details[1]; ppid = [int]$details[2] }
  }
  @{ procs = $procs }
}

function Invoke-Peek($req) {
  try { $p = [Diagnostics.Process]::GetProcessById([int]$req.pid) } catch { return @{ shown = $false } }
  if ($req.start -and (Get-Start $p) -ne [string]$req.start) { return @{ shown = $false } }
  @{ shown = ([SessionConsole]::Shows([int]$req.pid, [string]$req.expect, [int]$req.lines) -eq $true) }
}

function Invoke-Screen($req) {
  try { $p = [Diagnostics.Process]::GetProcessById([int]$req.pid) } catch { return @{ text = $null } }
  if ($req.start -and (Get-Start $p) -ne [string]$req.start) { return @{ text = $null } }
  @{ text = [SessionConsole]::Screen([int]$req.pid, [int]$req.lines) }
}

function Invoke-Type($req) {
  try { $p = [Diagnostics.Process]::GetProcessById([int]$req.pid) } catch { return @{ ok = $false; error = 'terminal closed' } }
  # A reused process id belongs to another program; never type into it.
  if ($req.start -and (Get-Start $p) -ne [string]$req.start) { return @{ ok = $false; error = 'terminal closed' } }
  $err = [SessionConsole]::Type([int]$req.pid, [string]$req.text, 600, [string]$req.expect, [int]$req.lines)
  # shown:false is "the prompt is not on this screen", not a failure to type.
  if ($err -eq 'not shown') { return @{ ok = $false; shown = $false; error = 'limit message not on that terminal' } }
  if ($err) { return @{ ok = $false; error = $err } }
  @{ ok = $true }
}

# Folders, command lines and screen text can hold any character; Node reads the replies as UTF-8.
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line -eq 'exit') { break }
  try {
    $req = $line | ConvertFrom-Json
    if ($req.op -eq 'scan') { $result = Get-Scan $req }
    elseif ($req.op -eq 'type') { $result = Invoke-Type $req }
    elseif ($req.op -eq 'peek') { $result = Invoke-Peek $req }
    elseif ($req.op -eq 'screen') { $result = Invoke-Screen $req }
    else { $result = @{ error = 'unknown request' } }
    $json = $result | ConvertTo-Json -Depth 5 -Compress
  } catch { $json = '{"error":true}' }
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}
