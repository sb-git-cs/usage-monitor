// Usage Monitor's one resident Windows helper. It answers every Windows query of the app from a
// single small process: hardware and battery samples, coding-session processes and consoles, the
// taskbar, and Credential Manager. It replaced three resident PowerShell processes (70-110 MB each)
// and a PowerShell start, with a C# compile, for every credential read.
//
// Lines on stdin are "<channel> <payload>"; replies are "<channel> <payload>" on stdout, one per
// request and in order within a channel. Each channel has its own thread, so a slow console read
// never holds up a hardware sample.
//   sys   "sample" | "sample storage" | "battery"                       -> one JSON line each
//   sess  {"op":"scan"|"peek"|"screen"|"type", ...}                      -> one JSON line each
//   cred  {"op":"read","target":..} | {"op":"write","target":..,"text":..} -> one JSON line each
//   bar   "watch" | "own <hwnd> <own> <capture> <apppid>" | "probe" | "stop"
//         -> "shown=0|1" when the taskbar slides away or back, "layout=<json>" every 8 s and on change
// The process ends when stdin closes, so it never outlives the app.
//
// Built by scripts/build-helper.js with the C# compiler that ships with Windows (.NET Framework 4),
// so it is limited to C# 5.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class Program {
  static readonly object OutLock = new object();
  static TextWriter Out;

  public static void Send(string channel, string payload) {
    lock (OutLock) {
      Out.Write(channel);
      Out.Write(' ');
      Out.Write(payload);
      Out.Write('\n');
      Out.Flush();
    }
  }

  static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "--selftest") return SelfTest.Run();
    TextReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    // Folders, command lines and screen text can hold any character; Node reads the replies as UTF-8.
    Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    Lane sys = new Lane("sys", Hardware.Handle);
    Lane sess = new Lane("sess", Sessions.Handle);
    Lane cred = new Lane("cred", Credentials.Handle);
    string line;
    while ((line = input.ReadLine()) != null) {
      if (line == "exit") break;
      int space = line.IndexOf(' ');
      string channel = space < 0 ? line : line.Substring(0, space);
      string payload = space < 0 ? "" : line.Substring(space + 1);
      if (channel == "sys") sys.Post(payload);
      else if (channel == "sess") sess.Post(payload);
      else if (channel == "cred") cred.Post(payload);
      else if (channel == "bar") Taskbar.Command(payload);
    }
    return 0;
  }
}

// Requests of one channel, answered in order on the channel's own thread.
sealed class Lane {
  readonly string name;
  readonly Func<string, string> handle;
  readonly Queue<string> queue = new Queue<string>();
  Thread thread;

  public Lane(string name, Func<string, string> handle) { this.name = name; this.handle = handle; }

  public void Post(string payload) {
    lock (queue) {
      queue.Enqueue(payload);
      if (thread == null) {
        thread = new Thread(Run);
        thread.IsBackground = true;
        thread.Start();
      }
      Monitor.Pulse(queue);
    }
  }

  void Run() {
    while (true) {
      string payload;
      lock (queue) {
        while (queue.Count == 0) Monitor.Wait(queue);
        payload = queue.Dequeue();
      }
      string reply;
      try { reply = handle(payload); } catch { reply = "{\"error\":true}"; }
      Program.Send(name, reply);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Hardware: GPU and disk load from the performance counters Task Manager uses, the local drives,
// and the battery. Counters are read through PDH, which costs far less than the WMI classes.
static class Hardware {
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern int PdhOpenQueryW(string source, IntPtr user, out IntPtr query);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern int PdhAddEnglishCounterW(IntPtr query, string path, IntPtr user, out IntPtr counter);
  [DllImport("pdh.dll")] static extern int PdhCollectQueryData(IntPtr query);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern int PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint size, out uint count, IntPtr items);

  [StructLayout(LayoutKind.Sequential)]
  struct SP_DEVINFO_DATA { public uint cbSize; public Guid ClassGuid; public uint DevInst; public IntPtr Reserved; }
  [DllImport("setupapi.dll", SetLastError = true)] static extern IntPtr SetupDiGetClassDevsW(ref Guid cls, IntPtr enumerator, IntPtr parent, uint flags);
  [DllImport("setupapi.dll", SetLastError = true)] static extern bool SetupDiEnumDeviceInfo(IntPtr set, uint index, ref SP_DEVINFO_DATA data);
  [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);

  const uint PDH_FMT_DOUBLE = 0x00000200, PDH_FMT_NOCAP100 = 0x00008000;
  const int PDH_MORE_DATA = unchecked((int)0x800007D2);
  static Guid DisplayClass = new Guid("4d36e968-e325-11ce-bfc1-08002be10318");
  static readonly Regex EnginePid = new Regex("^pid_\\d+_", RegexOptions.Compiled);

  static IntPtr query = IntPtr.Zero, gpuCounter = IntPtr.Zero, diskCounter = IntPtr.Zero;
  static DateTime collectedAt = DateTime.MinValue;
  static object gpuPresent = null;
  static DateTime gpuCheckedAt = DateTime.MinValue;

  public static string Handle(string request) {
    if (request == "battery") return Json.Write(Battery());
    if (request == "sample" || request == "sample storage") return Json.Write(Sample(request == "sample storage"));
    return "{\"error\":\"unknown request\"}";
  }

  static Dictionary<string, object> Sample(bool withStorage) {
    Dictionary<string, object> result = new Dictionary<string, object>();
    result["gpuPresent"] = null;
    result["gpu"] = null;
    if (withStorage) {
      // Local fixed drives, as Win32_LogicalDisk DriveType=3 lists them.
      List<object> volumes = new List<object>();
      try {
        foreach (DriveInfo d in DriveInfo.GetDrives()) {
          try {
            if (d.DriveType != DriveType.Fixed || !d.IsReady || d.TotalSize <= 0) continue;
            Dictionary<string, object> v = new Dictionary<string, object>();
            v["mount"] = d.Name.TrimEnd('\\');
            v["size"] = (double)d.TotalSize;
            v["used"] = (double)(d.TotalSize - d.TotalFreeSpace);
            volumes.Add(v);
          } catch { /* a drive that went away */ }
        }
      } catch { /* none readable */ }
      result["volumes"] = volumes;
    }
    // Graphics adapters rarely change, so the adapter list is refreshed every 5 minutes.
    if ((DateTime.UtcNow - gpuCheckedAt).TotalMinutes >= 5) {
      try { gpuPresent = DisplayAdapters() > 0; } catch { }
      gpuCheckedAt = DateTime.UtcNow;
    }
    result["gpuPresent"] = gpuPresent;
    Collect();
    // Sum processes sharing an engine, then take the busiest engine (Task Manager semantics).
    Dictionary<string, double> engines = new Dictionary<string, double>();
    foreach (KeyValuePair<string, double> item in Read(gpuCounter)) {
      string engine = EnginePid.Replace(item.Key, "");
      double sum;
      engines.TryGetValue(engine, out sum);
      engines[engine] = sum + item.Value;
    }
    if (engines.Count > 0) {
      double max = 0;
      foreach (double v in engines.Values) max = Math.Max(max, v);
      result["gpu"] = Math.Min(100, max);
      result["gpuPresent"] = true;
    }
    List<object> disks = new List<object>();
    foreach (KeyValuePair<string, double> item in Read(diskCounter)) {
      if (item.Key == "_Total") continue;
      Dictionary<string, object> d = new Dictionary<string, object>();
      d["name"] = item.Key;
      d["busy"] = Math.Max(0, Math.Min(100, 100 - item.Value));
      disks.Add(d);
    }
    result["disks"] = disks;
    return result;
  }

  // Rate counters need two collections; the first sample waits briefly for its second.
  static void Collect() {
    if (query == IntPtr.Zero) {
      if (PdhOpenQueryW(null, IntPtr.Zero, out query) != 0) { query = IntPtr.Zero; return; }
      IntPtr c;
      if (PdhAddEnglishCounterW(query, "\\GPU Engine(*)\\Utilization Percentage", IntPtr.Zero, out c) == 0) gpuCounter = c;
      if (PdhAddEnglishCounterW(query, "\\PhysicalDisk(*)\\% Idle Time", IntPtr.Zero, out c) == 0) diskCounter = c;
      PdhCollectQueryData(query);
      collectedAt = DateTime.UtcNow;
    }
    double since = (DateTime.UtcNow - collectedAt).TotalMilliseconds;
    if (since < 500) Thread.Sleep((int)(500 - since));
    PdhCollectQueryData(query);
    collectedAt = DateTime.UtcNow;
  }

  // Each instance of a wildcard counter with its value; instances without valid data are left out.
  static List<KeyValuePair<string, double>> Read(IntPtr counter) {
    List<KeyValuePair<string, double>> list = new List<KeyValuePair<string, double>>();
    if (counter == IntPtr.Zero) return list;
    uint format = PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, size = 0, count;
    if (PdhGetFormattedCounterArrayW(counter, format, ref size, out count, IntPtr.Zero) != PDH_MORE_DATA || size == 0) return list;
    IntPtr buffer = Marshal.AllocHGlobal((int)size);
    try {
      if (PdhGetFormattedCounterArrayW(counter, format, ref size, out count, buffer) != 0) return list;
      // PDH_FMT_COUNTERVALUE_ITEM_W: the name pointer, then PDH_FMT_COUNTERVALUE, whose value union
      // is 8-byte aligned on x86 and x64 alike: CStatus at 8, the double at 16, 24 bytes per item.
      for (int i = 0; i < count; i++) {
        IntPtr item = new IntPtr(buffer.ToInt64() + (long)i * 24);
        int status = Marshal.ReadInt32(item, 8);
        if (status != 0 && status != 1) continue;
        string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(item));
        double value = BitConverter.Int64BitsToDouble(Marshal.ReadInt64(item, 16));
        if (name != null && !double.IsNaN(value) && !double.IsInfinity(value)) list.Add(new KeyValuePair<string, double>(name, value));
      }
    } finally { Marshal.FreeHGlobal(buffer); }
    return list;
  }

  // Present devices of the Display class, as Win32_VideoController lists them.
  static int DisplayAdapters() {
    IntPtr set = SetupDiGetClassDevsW(ref DisplayClass, IntPtr.Zero, IntPtr.Zero, 0x2 /* DIGCF_PRESENT */);
    if (set == new IntPtr(-1)) throw new Exception("no device list");
    try {
      SP_DEVINFO_DATA data = new SP_DEVINFO_DATA();
      data.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
      uint n = 0;
      while (SetupDiEnumDeviceInfo(set, n, ref data)) n++;
      return (int)n;
    } finally { SetupDiDestroyDeviceInfoList(set); }
  }

  [StructLayout(LayoutKind.Sequential)] struct PowerState {
    public byte Ac, Present, Charging, Discharging, Spare0, Spare1, Spare2, Tag;
    public uint MaxCapacity, RemainingCapacity;
    public int Rate;
    public uint EstimatedTime, Alert1, Alert2;
  }
  [StructLayout(LayoutKind.Sequential)] struct PowerStatus {
    public byte Ac, Flags, Percent, Saver;
    public uint Life, FullLife;
  }
  [DllImport("powrprof.dll")] static extern uint CallNtPowerInformation(int level, IntPtr input, uint inputSize, out PowerState state, uint size);
  [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out PowerStatus status);

  // Read-only native power information.
  static Dictionary<string, object> Battery() {
    Dictionary<string, object> result = new Dictionary<string, object>();
    PowerState state;
    PowerStatus status;
    if (CallNtPowerInformation(5 /* SystemBatteryState */, IntPtr.Zero, 0, out state, (uint)Marshal.SizeOf(typeof(PowerState))) != 0 || !GetSystemPowerStatus(out status)) {
      result["error"] = true;
      return result;
    }
    result["hasBattery"] = state.Present != 0;
    result["percent"] = status.Percent <= 100 ? (object)(double)status.Percent : null;
    result["isCharging"] = state.Charging != 0;
    result["acConnected"] = state.Ac != 0 && state.Discharging == 0;
    result["estimatedSeconds"] = state.Discharging != 0 && state.EstimatedTime > 0 && state.EstimatedTime != uint.MaxValue ? (object)(double)state.EstimatedTime : null;
    result["currentCapacity"] = (double)state.RemainingCapacity;
    result["powerRate"] = (double)state.Rate;
    result["capacityUnit"] = "mWh";
    return result;
  }
}

// ---------------------------------------------------------------------------------------------
// Coding sessions: the processes of those tools, and their terminals' screens.
//   {"op":"scan","pids":[1,2],"names":["codex"],"only":{"name":"node","cmd":"regex"}}  start time, folder,
//     command line and parent of those processes; "only" drops processes of that name whose command line does not match
//   {"op":"type","pid":1,"start":"...","text":"continue","expect":"regex"}  types the text, then Enter,
//     into that console, only while its screen shows text matching expect (the limit message,
//     or a permission prompt). Empty text sends Enter alone. "lines":N checks only the last N
//     non-blank lines. A miss returns shown:false and types nothing.
//   {"op":"peek","pid":1,"start":"...","expect":"regex","lines":N}  the same screen check, typing nothing
//   {"op":"screen","pid":1,"start":"...","lines":N}  the last N non-blank lines of that console, or null
static class Sessions {
  public static string Handle(string payload) {
    Dictionary<string, object> req = Json.Parse(payload) as Dictionary<string, object>;
    if (req == null) return "{\"error\":true}";
    string op = Json.Str(req, "op");
    Dictionary<string, object> result;
    if (op == "scan") result = Scan(req);
    else if (op == "type") result = TypeInto(req);
    else if (op == "peek") result = Peek(req);
    else if (op == "screen") result = ScreenOf(req);
    else { result = new Dictionary<string, object>(); result["error"] = "unknown request"; }
    return Json.Write(result);
  }

  static string StartOf(Process p) {
    try { return p.StartTime.ToFileTimeUtc().ToString(CultureInfo.InvariantCulture); } catch { return null; }
  }

  static Dictionary<string, object> Scan(Dictionary<string, object> req) {
    List<Process> found = new List<Process>();
    foreach (object id in Json.List(req, "pids")) {
      try { found.Add(Process.GetProcessById(Json.ToInt(id))); } catch { }
    }
    foreach (object name in Json.List(req, "names")) {
      try { found.AddRange(Process.GetProcessesByName(Convert.ToString(name, CultureInfo.InvariantCulture))); } catch { }
    }
    Dictionary<string, object> only = req.ContainsKey("only") ? req["only"] as Dictionary<string, object> : null;
    string onlyName = only != null ? Json.Str(only, "name") ?? "" : null;
    string onlyCmd = only != null ? Json.Str(only, "cmd") ?? "" : null;
    Dictionary<int, bool> seen = new Dictionary<int, bool>();
    List<object> procs = new List<object>();
    try {
      foreach (Process p in found) {
        if (seen.ContainsKey(p.Id)) continue;
        seen[p.Id] = true;
        string[] details = SessionConsole.Details(p.Id);
        string processName;
        try { processName = p.ProcessName; } catch { continue; }
        // "only": a name whose command line must match, so other node.exe programs are not sent back.
        if (only != null && string.Equals(processName, onlyName, StringComparison.OrdinalIgnoreCase) &&
            !Regex.IsMatch(details[1] ?? "", onlyCmd, RegexOptions.IgnoreCase)) continue;
        Dictionary<string, object> row = new Dictionary<string, object>();
        row["pid"] = p.Id;
        row["name"] = processName;
        row["start"] = StartOf(p);
        row["cwd"] = details[0];
        row["cmd"] = details[1];
        int ppid;
        row["ppid"] = int.TryParse(details[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out ppid) ? ppid : 0;
        procs.Add(row);
      }
    } finally {
      foreach (Process p in found) p.Dispose();
    }
    Dictionary<string, object> result = new Dictionary<string, object>();
    result["procs"] = procs;
    return result;
  }

  // The process, unless it is gone or its id now belongs to another program (start time differs).
  static bool Same(Dictionary<string, object> req) {
    try {
      using (Process p = Process.GetProcessById(Json.Int(req, "pid"))) {
        string start = Json.Str(req, "start");
        return string.IsNullOrEmpty(start) || StartOf(p) == start;
      }
    } catch { return false; }
  }

  static Dictionary<string, object> Peek(Dictionary<string, object> req) {
    Dictionary<string, object> result = new Dictionary<string, object>();
    bool? shown = Same(req) ? SessionConsole.Shows(Json.Int(req, "pid"), Json.Str(req, "expect") ?? "", Json.Int(req, "lines")) : false;
    result["shown"] = shown == true;
    return result;
  }

  static Dictionary<string, object> ScreenOf(Dictionary<string, object> req) {
    Dictionary<string, object> result = new Dictionary<string, object>();
    result["text"] = Same(req) ? SessionConsole.Screen(Json.Int(req, "pid"), Json.Int(req, "lines")) : null;
    return result;
  }

  static Dictionary<string, object> TypeInto(Dictionary<string, object> req) {
    Dictionary<string, object> result = new Dictionary<string, object>();
    // A reused process id belongs to another program; never type into it.
    if (!Same(req)) { result["ok"] = false; result["error"] = "terminal closed"; return result; }
    string err = SessionConsole.Type(Json.Int(req, "pid"), Json.Str(req, "text") ?? "", 600, Json.Str(req, "expect") ?? "", Json.Int(req, "lines"));
    // shown:false is "the prompt is not on this screen", not a failure to type.
    if (err == "not shown") { result["ok"] = false; result["shown"] = false; result["error"] = "limit message not on that terminal"; return result; }
    if (err != null) { result["ok"] = false; result["error"] = err; return result; }
    result["ok"] = true;
    return result;
  }
}

static class SessionConsole {
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
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder buf, int len, COORD at, out int read);
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
  static readonly IntPtr Invalid = new IntPtr(-1);

  // The last non-blank lines of that console's screen, where a terminal app shows its latest message.
  static string ScreenText(int rows, int lastLines) {
    IntPtr output = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (output == Invalid) return null;
    try {
      SCREEN_INFO info;
      if (!GetConsoleScreenBufferInfo(output, out info)) return null;
      List<string> lines = new List<string>();
      for (int y = Math.Max(0, info.Window.Bottom - rows + 1); y <= info.Window.Bottom; y++) {
        StringBuilder line = new StringBuilder(info.Size.X);
        COORD at; at.X = 0; at.Y = (short)y; int read;
        if (!ReadConsoleOutputCharacterW(output, line, info.Size.X, at, out read)) continue;
        string text = line.ToString(0, read).Trim();
        if (text.Length > 0) lines.Add(text);
      }
      return String.Join("\n", lines.GetRange(Math.Max(0, lines.Count - lastLines), Math.Min(lines.Count, lastLines)));
    } finally { CloseHandle(output); }
  }

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
    return Encoding.Unicode.GetString(text);
  }

  static IntPtr Offset(IntPtr p, int by) { return new IntPtr(p.ToInt64() + by); }

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
      result[2] = pbi.Reserved3.ToInt64().ToString(CultureInfo.InvariantCulture);
      IntPtr parameters = ReadPtr(h, Offset(pbi.PebBaseAddress, 0x20));
      if (parameters == IntPtr.Zero) return result;
      result[0] = ReadUnicode(h, Offset(parameters, 0x38));
      result[1] = ReadUnicode(h, Offset(parameters, 0x70));
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

  // Whether that console's screen shows text matching expect; null when it cannot be read.
  public static bool? Shows(int pid, string expect, int lastLines) {
    FreeConsole();
    if (!AttachConsole(pid)) return null;
    SetConsoleCtrlHandler(IntPtr.Zero, true);
    try {
      string screen = ScreenText(120, lastLines > 0 ? lastLines : 120);
      if (screen == null) return null;
      return Regex.IsMatch(screen, expect, RegexOptions.IgnoreCase);
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
      return text == null ? null : Regex.Replace(text, "[\x00-\x09\x0B-\x1F]", " ");
    } finally {
      FreeConsole();
      SetConsoleCtrlHandler(IntPtr.Zero, false);
    }
  }

  // Types the text into the console of that process, then Enter. Enter is sent separately after
  // a pause: terminal apps treat a fast burst that ends in Enter as a paste and add a new line.
  // With expect set, nothing is typed unless the screen shows it: the limit was hit in this terminal.
  // lastLines limits the check to the newest lines, so an older message that scrolled up does not count.
  public static string Type(int pid, string text, int enterDelayMs, string expect, int lastLines) {
    FreeConsole();
    if (!AttachConsole(pid)) return "no console (" + Marshal.GetLastWin32Error() + ")";
    SetConsoleCtrlHandler(IntPtr.Zero, true);
    try {
      if (!String.IsNullOrEmpty(expect)) {
        string screen = ScreenText(120, lastLines > 0 ? lastLines : 120);
        if (screen == null) return "terminal screen unreadable";
        if (!Regex.IsMatch(screen, expect, RegexOptions.IgnoreCase)) return "not shown";
      }
      IntPtr input = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (input == Invalid) return "console input unavailable (" + Marshal.GetLastWin32Error() + ")";
      try {
        List<INPUT_RECORD> recs = new List<INPUT_RECORD>();
        foreach (char ch in text) {
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

// ---------------------------------------------------------------------------------------------
// Taskbar: where it is and what occupies it, whether an auto-hide taskbar is shown, and keeping
// the docked chips owned by and above it. Only a window of the calling process is ever touched.
static class Taskbar {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowW(string cls, string name);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string name);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr h, ref MONITORINFO info);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h, uint affinity);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h, out uint affinity);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }

  static readonly Queue<string> commands = new Queue<string>();
  static Thread thread;
  static readonly Regex Digits = new Regex("^\\d+$");
  static readonly string[] Parts = { "TrayNotifyWnd", "ReBarWindow32", "MSTaskSwWClass", "Start" };
  // Windows are looked up by an empty title, as the PowerShell helper did (it passed "" for $null):
  // the Start button has a title, so it is not counted as occupied, which the docking was tuned on.

  // Any command starts the watch loop; "stop" ends it unless a later command follows.
  public static void Command(string line) {
    lock (commands) {
      commands.Enqueue(line);
      if (thread == null) {
        thread = new Thread(Loop);
        thread.IsBackground = true;
        thread.Start();
      }
    }
  }

  static Dictionary<string, object> Rect(IntPtr h) {
    if (h == IntPtr.Zero) return null;
    RECT r;
    if (!GetWindowRect(h, out r)) return null;
    Dictionary<string, object> o = new Dictionary<string, object>();
    o["x"] = r.L; o["y"] = r.T; o["w"] = r.R - r.L; o["h"] = r.B - r.T;
    return o;
  }

  // A collapsed auto-hide taskbar leaves only a sliver on the monitor. The chips follow that:
  // while the taskbar is off screen they hide, instead of sitting on a shared screen alone.
  static bool Shown() {
    IntPtr tray = FindWindowW("Shell_TrayWnd", "");
    if (tray == IntPtr.Zero) return true;
    if (!IsWindowVisible(tray)) return false;
    RECT b;
    if (!GetWindowRect(tray, out b)) return true;
    MONITORINFO info = new MONITORINFO();
    info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfoW(MonitorFromWindow(tray, 2), ref info)) return true;
    RECT m = info.rcMonitor;
    int iw = Math.Min(b.R, m.R) - Math.Max(b.L, m.L);
    int ih = Math.Min(b.B, m.B) - Math.Max(b.T, m.T);
    if (iw <= 0 || ih <= 0) return false;
    int thick = (b.R - b.L) >= (b.B - b.T) ? ih : iw;
    return thick >= 12;
  }

  // The chips window, if it is a window of the calling process.
  static IntPtr Chips(string hwnd, int appPid) {
    if (hwnd == null || !Digits.IsMatch(hwnd) || appPid <= 0) return IntPtr.Zero;
    IntPtr chips = new IntPtr(long.Parse(hwnd, CultureInfo.InvariantCulture));
    uint windowPid;
    GetWindowThreadProcessId(chips, out windowPid);
    return windowPid == (uint)appPid ? chips : IntPtr.Zero;
  }

  // Reads the taskbar rectangles and, when a chips window is given, applies its taskbar ownership
  // and capture exclusion. GetWindowRect returns physical pixels; Electron converts them to DIP.
  static Dictionary<string, object> Layout(string hwnd, int own, int appPid, int capture) {
    IntPtr tray = FindWindowW("Shell_TrayWnd", "");
    List<object> occupied = new List<object>();
    if (tray != IntPtr.Zero) {
      foreach (string cls in Parts) {
        Dictionary<string, object> r = Rect(FindWindowExW(tray, IntPtr.Zero, cls, ""));
        if (r == null || (int)r["w"] <= 8 || (int)r["h"] <= 8) continue;
        Dictionary<string, object> o = new Dictionary<string, object>();
        o["name"] = cls; o["x"] = r["x"]; o["y"] = r["y"]; o["w"] = r["w"]; o["h"] = r["h"];
        occupied.Add(o);
      }
    }
    // Owning the chips by the taskbar keeps them visible when Windows raises the taskbar above
    // other windows (Start menu, Quick Settings), and re-attaches them after Explorer replaces the
    // taskbar.
    bool applied = false;
    string tag = null;
    if (hwnd != null && Digits.IsMatch(hwnd)) {
      tag = hwnd + ":" + own + ":" + capture;
      IntPtr chips = Chips(hwnd, appPid);
      if (chips != IntPtr.Zero) {
        IntPtr target = own == 1 ? tray : IntPtr.Zero;
        if (GetWindowLongPtr(chips, -8) != target) SetWindowLongPtr(chips, -8, target);
        applied = GetWindowLongPtr(chips, -8) == target;
        // 0x11 excludes the window from screen capture, so docked chips are not a separate bar in a
        // share that leaves out the taskbar; 0 puts a floating strip back in. Set only when it
        // differs: setting it again makes DWM redraw the strip, which showed as a flicker.
        uint affinity = capture == 1 ? 0x11u : 0u, current;
        if (!GetWindowDisplayAffinity(chips, out current) || current != affinity) SetWindowDisplayAffinity(chips, affinity);
      }
    }
    Dictionary<string, object> result = new Dictionary<string, object>();
    result["tray"] = Rect(tray);
    result["occupied"] = occupied;
    result["owner"] = tag;
    result["ownerApplied"] = applied;
    result["shown"] = Shown();
    return result;
  }

  // Windows 11 restacks the taskbar above the docked strip whenever the taskbar loses activation,
  // although the strip is owned by it and always on top. Put the strip back above the taskbar only
  // when it is below it: restacking it on every pass made it flicker.
  static void Lift(string hwnd, int appPid) {
    IntPtr chips = Chips(hwnd, appPid);
    if (chips == IntPtr.Zero || !IsWindowVisible(chips)) return;
    IntPtr tray = FindWindowW("Shell_TrayWnd", "");
    if (tray == IntPtr.Zero) return;
    // GW_HWNDPREV (3) walks toward the top of the z-order.
    for (IntPtr above = GetWindow(chips, 3); above != IntPtr.Zero; above = GetWindow(above, 3)) {
      if (above != tray) continue;
      // HWND_TOPMOST, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
      SetWindowPos(chips, new IntPtr(-1), 0, 0, 0, 0, 0x0013);
      return;
    }
  }

  // Reports when the taskbar slides away or comes back (a 200 ms poll), and the layout every
  // 8 seconds, when it changes and when asked ("probe"), keeping the owner given by "own".
  static void Loop() {
    // Physical pixels, whatever the scaling of the monitor the taskbar is on.
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { }
    string hwnd = ""; int own = 0, capture = 0, appPid = 0;
    bool? previous = null;
    DateTime lastLayout = DateTime.MinValue;
    while (true) {
      bool force = false;
      lock (commands) {
        bool stop = false;
        while (commands.Count > 0) {
          string[] parts = commands.Dequeue().Split(' ');
          stop = parts[0] == "stop";
          if (parts[0] == "own" && parts.Length >= 5) {
            hwnd = parts[1];
            int.TryParse(parts[2], out own);
            int.TryParse(parts[3], out capture);
            int.TryParse(parts[4], out appPid);
            force = true;
          } else if (parts[0] == "probe" || parts[0] == "watch") force = true;
        }
        if (stop) { thread = null; return; }
      }
      try {
        if (own == 1) Lift(hwnd, appPid);
        bool shown = Shown();
        if (previous == null || shown != previous.Value) {
          Program.Send("bar", shown ? "shown=1" : "shown=0");
          previous = shown;
          force = true;
        }
        if (force || (DateTime.UtcNow - lastLayout).TotalSeconds >= 8) {
          Program.Send("bar", "layout=" + Json.Write(Layout(hwnd, own, appPid, capture)));
          lastLayout = DateTime.UtcNow;
        }
      } catch { /* the next pass tries again */ }
      Thread.Sleep(200);
    }
  }

  public static Dictionary<string, object> Once() { return Layout(null, 0, 0, 0); }
}

// ---------------------------------------------------------------------------------------------
// Credential Manager: generic credentials whose blob is UTF-8 text, the way the Antigravity CLI
// stores its sign-in.
static class Credentials {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);

  public static string Handle(string payload) {
    Dictionary<string, object> req = Json.Parse(payload) as Dictionary<string, object>;
    Dictionary<string, object> result = new Dictionary<string, object>();
    string op = req == null ? null : Json.Str(req, "op");
    string target = req == null ? null : Json.Str(req, "target");
    if (string.IsNullOrEmpty(target)) { result["error"] = "no target"; return Json.Write(result); }
    if (op == "read") result["text"] = Read(target);
    else if (op == "write") result["ok"] = Write(target, Json.Str(req, "text") ?? "");
    else result["error"] = "unknown request";
    return Json.Write(result);
  }

  static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1 /* CRED_TYPE_GENERIC */, 0, out p)) return null;
    try {
      CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      if (cred.CredentialBlobSize <= 0 || cred.CredentialBlob == IntPtr.Zero) return null;
      byte[] bytes = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
      return Encoding.UTF8.GetString(bytes);
    } finally { CredFree(p); }
  }

  static bool Write(string target, string text) {
    byte[] bytes = Encoding.UTF8.GetBytes(text);
    CREDENTIAL cred = new CREDENTIAL();
    cred.Type = 1;
    cred.TargetName = target;
    cred.CredentialBlobSize = bytes.Length;
    cred.CredentialBlob = Marshal.AllocHGlobal(Math.Max(1, bytes.Length));
    cred.Persist = 2; // CRED_PERSIST_LOCAL_MACHINE
    cred.UserName = Environment.UserName;
    try {
      Marshal.Copy(bytes, 0, cred.CredentialBlob, bytes.Length);
      return CredWriteW(ref cred, 0);
    } finally { Marshal.FreeHGlobal(cred.CredentialBlob); }
  }
}

// ---------------------------------------------------------------------------------------------
// Just enough JSON for the requests the app sends and the replies it reads.
static class Json {
  public static object Parse(string s) {
    int i = 0;
    object v = Value(s, ref i);
    Space(s, ref i);
    if (i != s.Length) throw new FormatException("trailing text");
    return v;
  }

  public static string Str(Dictionary<string, object> d, string key) {
    object v;
    if (!d.TryGetValue(key, out v) || v == null) return null;
    return v as string ?? Convert.ToString(v, CultureInfo.InvariantCulture);
  }

  public static int Int(Dictionary<string, object> d, string key) {
    object v;
    return d.TryGetValue(key, out v) ? ToInt(v) : 0;
  }

  public static int ToInt(object v) {
    if (v is double) return (int)(double)v;
    int n;
    return v is string && int.TryParse((string)v, NumberStyles.Integer, CultureInfo.InvariantCulture, out n) ? n : 0;
  }

  public static List<object> List(Dictionary<string, object> d, string key) {
    object v;
    return d.TryGetValue(key, out v) && v is List<object> ? (List<object>)v : new List<object>();
  }

  static void Space(string s, ref int i) {
    while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
  }

  static void Expect(string s, ref int i, char c) {
    if (i >= s.Length || s[i] != c) throw new FormatException("expected " + c);
    i++;
  }

  static void Literal(string s, ref int i, string word) {
    if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) throw new FormatException("expected " + word);
    i += word.Length;
  }

  static object Value(string s, ref int i) {
    Space(s, ref i);
    if (i >= s.Length) throw new FormatException("unexpected end");
    char c = s[i];
    if (c == '{') {
      i++;
      Dictionary<string, object> d = new Dictionary<string, object>();
      Space(s, ref i);
      if (i < s.Length && s[i] == '}') { i++; return d; }
      while (true) {
        Space(s, ref i);
        string key = ReadString(s, ref i);
        Space(s, ref i);
        Expect(s, ref i, ':');
        d[key] = Value(s, ref i);
        Space(s, ref i);
        if (i < s.Length && s[i] == ',') { i++; continue; }
        Expect(s, ref i, '}');
        return d;
      }
    }
    if (c == '[') {
      i++;
      List<object> list = new List<object>();
      Space(s, ref i);
      if (i < s.Length && s[i] == ']') { i++; return list; }
      while (true) {
        list.Add(Value(s, ref i));
        Space(s, ref i);
        if (i < s.Length && s[i] == ',') { i++; continue; }
        Expect(s, ref i, ']');
        return list;
      }
    }
    if (c == '"') return ReadString(s, ref i);
    if (c == 't') { Literal(s, ref i, "true"); return true; }
    if (c == 'f') { Literal(s, ref i, "false"); return false; }
    if (c == 'n') { Literal(s, ref i, "null"); return null; }
    int start = i;
    while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
    if (start == i) throw new FormatException("unexpected character");
    return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
  }

  static string ReadString(string s, ref int i) {
    Expect(s, ref i, '"');
    StringBuilder sb = new StringBuilder();
    while (true) {
      if (i >= s.Length) throw new FormatException("unterminated string");
      char c = s[i++];
      if (c == '"') return sb.ToString();
      if (c != '\\') { sb.Append(c); continue; }
      if (i >= s.Length) throw new FormatException("unterminated escape");
      char e = s[i++];
      switch (e) {
        case '"': sb.Append('"'); break;
        case '\\': sb.Append('\\'); break;
        case '/': sb.Append('/'); break;
        case 'b': sb.Append('\b'); break;
        case 'f': sb.Append('\f'); break;
        case 'n': sb.Append('\n'); break;
        case 'r': sb.Append('\r'); break;
        case 't': sb.Append('\t'); break;
        case 'u':
          if (i + 4 > s.Length) throw new FormatException("short escape");
          sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
          i += 4;
          break;
        default: throw new FormatException("bad escape");
      }
    }
  }

  public static string Write(object v) {
    StringBuilder sb = new StringBuilder();
    WriteValue(sb, v);
    return sb.ToString();
  }

  static void WriteValue(StringBuilder sb, object v) {
    if (v == null) { sb.Append("null"); return; }
    string s = v as string;
    if (s != null) { Quote(sb, s); return; }
    if (v is bool) { sb.Append((bool)v ? "true" : "false"); return; }
    if (v is int || v is long) { sb.Append(Convert.ToInt64(v).ToString(CultureInfo.InvariantCulture)); return; }
    if (v is double) {
      double d = (double)v;
      sb.Append(double.IsNaN(d) || double.IsInfinity(d) ? "null" : d.ToString("R", CultureInfo.InvariantCulture));
      return;
    }
    Dictionary<string, object> map = v as Dictionary<string, object>;
    if (map != null) {
      sb.Append('{');
      bool first = true;
      foreach (KeyValuePair<string, object> kv in map) {
        if (!first) sb.Append(',');
        first = false;
        Quote(sb, kv.Key);
        sb.Append(':');
        WriteValue(sb, kv.Value);
      }
      sb.Append('}');
      return;
    }
    List<object> list = v as List<object>;
    if (list != null) {
      sb.Append('[');
      for (int i = 0; i < list.Count; i++) {
        if (i > 0) sb.Append(',');
        WriteValue(sb, list[i]);
      }
      sb.Append(']');
      return;
    }
    Quote(sb, Convert.ToString(v, CultureInfo.InvariantCulture));
  }

  static void Quote(StringBuilder sb, string s) {
    sb.Append('"');
    foreach (char c in s) {
      if (c == '"') sb.Append("\\\"");
      else if (c == '\\') sb.Append("\\\\");
      else if (c < 0x20 || c == (char)0x2028 || c == (char)0x2029) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
      else sb.Append(c);
    }
    sb.Append('"');
  }
}

// ---------------------------------------------------------------------------------------------
// --selftest [file]: one answer from each channel, for CI. Exit code 0 when all of them are sane.
static class SelfTest {
  public static int Run() {
    string[] args = Environment.GetCommandLineArgs();
    Dictionary<string, object> report = new Dictionary<string, object>();
    bool ok = true;
    try {
      Hardware.Handle("sample storage");
      Dictionary<string, object> sample = Json.Parse(Hardware.Handle("sample storage")) as Dictionary<string, object>;
      report["sample"] = sample;
      ok &= sample != null && sample.ContainsKey("disks") && sample.ContainsKey("volumes");
      Dictionary<string, object> battery = Json.Parse(Hardware.Handle("battery")) as Dictionary<string, object>;
      report["battery"] = battery;
      ok &= battery != null && (battery.ContainsKey("hasBattery") || battery.ContainsKey("error"));
      Dictionary<string, object> scan = Json.Parse(Sessions.Handle("{\"op\":\"scan\",\"pids\":[" + Process.GetCurrentProcess().Id + "],\"names\":[]}")) as Dictionary<string, object>;
      List<object> procs = scan == null ? null : scan["procs"] as List<object>;
      report["scanFoundSelf"] = procs != null && procs.Count == 1;
      ok &= procs != null && procs.Count == 1;
      report["layout"] = Taskbar.Once();
      Dictionary<string, object> cred = Json.Parse(Credentials.Handle("{\"op\":\"read\",\"target\":\"usage-monitor:selftest:missing\"}")) as Dictionary<string, object>;
      report["credMissingIsNull"] = cred != null && cred.ContainsKey("text") && cred["text"] == null;
      ok &= cred != null && cred.ContainsKey("text") && cred["text"] == null;
    } catch (Exception e) {
      report["exception"] = e.ToString();
      ok = false;
    }
    report["ok"] = ok;
    string text = Json.Write(report);
    if (args.Length > 2) File.WriteAllText(args[2], text, new UTF8Encoding(false));
    else Console.Out.WriteLine(text);
    return ok ? 0 : 1;
  }
}
