// Usage Monitor network capture helper (Windows).
//
// setup.ps1 compiles this file once (Windows PowerShell Add-Type, C# 5) into an
// administrator-only folder, and a scheduled task runs it as SYSTEM. It connects to
// the signed-in user's Usage Monitor over a named pipe and reports per-app byte counts
// from kernel ETW network events, DNS answers, and Windows Firewall block rules.
// It never reads packet contents.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace UsageMonitorNet
{
    public static class Program
    {
        public const int Protocol = 1;

        public static int Main(string[] args)
        {
            string pipe = null, sid = null, selftest = null;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--pipe" && i + 1 < args.Length) pipe = args[++i];
                else if (args[i] == "--sid" && i + 1 < args.Length) sid = args[++i];
                else if (args[i] == "--selftest" && i + 1 < args.Length) selftest = args[++i];
            }
            if (selftest != null) return SelfTest.Run(selftest);
            if (pipe == null || sid == null) return 2;
            Log.Init(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "helper.log"));
            bool created;
            using (var mutex = new Mutex(true, "Global\\UsageMonitorNetHelper-" + sid, out created))
            {
                if (!created) return 0;
                Log.Write("helper started, protocol " + Protocol);
                new Host(pipe, sid).Run();
            }
            return 0;
        }
    }

    static class Log
    {
        static string file;
        static readonly object sync = new object();

        public static void Init(string path) { file = path; }

        public static void Write(string message)
        {
            if (file == null) return;
            lock (sync)
            {
                try
                {
                    var info = new FileInfo(file);
                    if (info.Exists && info.Length > 512 * 1024) File.Delete(file);
                    File.AppendAllText(file, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + message + Environment.NewLine);
                }
                catch { }
            }
        }
    }

    static class Json
    {
        public static string Str(string value)
        {
            if (value == null) return "null";
            var sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c == (char)0x2028 || c == (char)0x2029) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string StrArray(IEnumerable<string> values)
        {
            var parts = new List<string>();
            foreach (var v in values) parts.Add(Str(v));
            return "[" + string.Join(",", parts) + "]";
        }
    }

    // Serialises writes from the tick thread and the command thread onto the pipe.
    sealed class LineWriter
    {
        readonly Stream stream;
        readonly object sync = new object();
        static readonly Encoding Utf8 = new UTF8Encoding(false);
        public volatile bool Broken;

        public LineWriter(Stream stream) { this.stream = stream; }

        public void Send(string json)
        {
            if (Broken) return;
            byte[] bytes = Utf8.GetBytes(json + "\n");
            lock (sync)
            {
                try
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush();
                }
                catch (Exception)
                {
                    Broken = true;
                }
            }
        }
    }

    sealed class Host
    {
        readonly string pipeName;
        readonly string sid;

        public Host(string pipeName, string sid)
        {
            this.pipeName = pipeName;
            this.sid = sid;
        }

        public void Run()
        {
            while (true)
            {
                // WaitNamedPipe fails fast when the app is not running; NamedPipeClientStream.Connect
                // would spin a CPU core for the whole timeout instead.
                if (!Native.WaitNamedPipe("\\\\.\\pipe\\" + pipeName, 0) && Marshal.GetLastWin32Error() == Native.ERROR_FILE_NOT_FOUND)
                {
                    Thread.Sleep(1500);
                    continue;
                }
                NamedPipeClientStream client = null;
                try
                {
                    client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
                    client.Connect(2000);
                    if (!ServerBelongsToUser(client))
                    {
                        Log.Write("rejected a pipe server that does not belong to " + sid);
                        client.Dispose();
                        Thread.Sleep(5000);
                        continue;
                    }
                    Serve(client);
                }
                catch (Exception ex)
                {
                    Log.Write("session ended: " + ex.Message);
                }
                finally
                {
                    if (client != null) client.Dispose();
                }
                Thread.Sleep(1000);
            }
        }

        bool ServerBelongsToUser(NamedPipeClientStream client)
        {
            uint pid;
            if (!Native.GetNamedPipeServerProcessId(client.SafePipeHandle.DangerousGetHandle(), out pid)) return false;
            IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, (int)pid);
            if (process == IntPtr.Zero) return false;
            try
            {
                IntPtr token;
                if (!Native.OpenProcessToken(process, Native.TOKEN_QUERY, out token)) return false;
                try
                {
                    using (var identity = new WindowsIdentity(token))
                    {
                        return identity.User != null && string.Equals(identity.User.Value, sid, StringComparison.OrdinalIgnoreCase);
                    }
                }
                finally { Native.CloseHandle(token); }
            }
            finally { Native.CloseHandle(process); }
        }

        void Serve(NamedPipeClientStream client)
        {
            var writer = new LineWriter(client);
            var capture = new Capture(sid);
            string startError = null;
            try { capture.Start(); }
            catch (Exception ex) { startError = ex.Message; Log.Write("capture failed: " + ex.Message); }

            writer.Send("{\"t\":\"hello\",\"protocol\":" + Program.Protocol +
                ",\"capture\":" + (startError == null ? "true" : "false") +
                ",\"error\":" + Json.Str(startError) +
                ",\"firewall\":" + (Firewall.IsEnabled() ? "true" : "false") + "}");
            SendBlocked(writer, true);

            var stop = new ManualResetEvent(false);
            var ticker = new Thread(delegate ()
            {
                while (!stop.WaitOne(1000))
                {
                    capture.Flush(writer);
                    if (writer.Broken) { try { client.Dispose(); } catch { } break; }
                }
            });
            ticker.IsBackground = true;
            ticker.Start();

            try
            {
                var reader = new StreamReader(client, new UTF8Encoding(false));
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    Handle(line, writer, capture);
                }
            }
            catch (Exception) { }
            finally
            {
                stop.Set();
                ticker.Join(3000);
                capture.Stop();
            }
        }

        // Listing every firewall rule is slow, so the list is read once and then kept current.
        List<string> blockedCache;

        void SendBlocked(LineWriter writer, bool refresh)
        {
            try
            {
                if (refresh || blockedCache == null) blockedCache = Firewall.Blocked(sid);
                writer.Send("{\"t\":\"blocked\",\"paths\":" + Json.StrArray(blockedCache) + "}");
            }
            catch (Exception ex) { Log.Write("firewall list failed: " + ex.Message); }
        }

        void UpdateBlockedCache(string path, bool blocked)
        {
            if (blockedCache == null) return;
            blockedCache.RemoveAll(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
            if (blocked) blockedCache.Add(path);
        }

        void Handle(string line, LineWriter writer, Capture capture)
        {
            string[] parts = line.Split('\t');
            if (parts.Length < 2) return;
            string id = parts[0];
            string command = parts[1];
            string arg = parts.Length > 2 ? parts[2] : "";
            string error = null;
            try
            {
                switch (command)
                {
                    case "BLOCK":
                        RequireProgram(arg);
                        Firewall.Block(arg, sid);
                        UpdateBlockedCache(arg, true);
                        TcpReset.CloseConnections(capture.PidsForPath(arg));
                        break;
                    case "UNBLOCK":
                        Firewall.Unblock(arg, sid);
                        UpdateBlockedCache(arg, false);
                        break;
                    case "LIST":
                        break;
                    case "FLOWS":
                        capture.SetFlowKeys(arg.Length == 0 ? new string[0] : arg.Split('|'));
                        break;
                    case "UNINSTALL":
                        capture.Stop();
                        Uninstall(writer, id);
                        return;
                    default:
                        error = "unknown command";
                        break;
                }
            }
            catch (Exception ex)
            {
                error = ex.Message;
            }
            writer.Send("{\"t\":\"result\",\"id\":" + Json.Str(id) + ",\"ok\":" + (error == null ? "true" : "false") + ",\"error\":" + Json.Str(error) + "}");
            if (command == "BLOCK" || command == "UNBLOCK" || command == "LIST") SendBlocked(writer, command == "LIST");
        }

        static void RequireProgram(string path)
        {
            if (string.IsNullOrEmpty(path) || !Path.IsPathRooted(path) || !path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(path))
                throw new ArgumentException("Only an existing .exe path can be blocked.");
        }

        void Uninstall(LineWriter writer, string id)
        {
            foreach (string path in Firewall.Blocked(sid)) Firewall.Unblock(path, sid);
            RunHidden("schtasks.exe", "/Delete /TN \"\\UsageMonitor\\NetCapture-" + sid + "\" /F");
            writer.Send("{\"t\":\"result\",\"id\":" + Json.Str(id) + ",\"ok\":true,\"error\":null}");
            string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            // Only ever delete our own install folder: ...\Usage Monitor Network Helper\<sid>.
            if (string.Equals(Path.GetFileName(dir), sid, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(Path.GetFileName(Path.GetDirectoryName(dir)), "Usage Monitor Network Helper", StringComparison.OrdinalIgnoreCase))
            {
                RunHidden("cmd.exe", "/d /c ping -n 4 127.0.0.1 >nul & rmdir /s /q \"" + dir + "\"");
            }
            Log.Write("uninstalled");
            Environment.Exit(0);
        }

        static void RunHidden(string file, string arguments)
        {
            var info = new ProcessStartInfo(file, arguments);
            info.CreateNoWindow = true;
            info.UseShellExecute = false;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            using (var p = Process.Start(info)) { p.WaitForExit(15000); }
        }
    }

    sealed class ProcInfo
    {
        public int Pid;
        public DateTime Seen;
        public string Key;
        public string Path;
        public string Exe;
        public string Name;
    }

    struct FlowKey : IEquatable<FlowKey>
    {
        public ProcInfo Proc;
        public string Ip;
        public int Port;
        public bool Udp;

        public bool Equals(FlowKey other)
        {
            return ReferenceEquals(Proc, other.Proc) && Port == other.Port && Udp == other.Udp && Ip == other.Ip;
        }

        public override bool Equals(object obj) { return obj is FlowKey && Equals((FlowKey)obj); }

        public override int GetHashCode()
        {
            unchecked { return ((Proc.GetHashCode() * 397) ^ Ip.GetHashCode()) * 31 + Port * 2 + (Udp ? 1 : 0); }
        }
    }

    // Kernel network/process events plus DNS-Client answers, aggregated per second.
    sealed class Capture
    {
        readonly string KernelSession;
        readonly string UserSession;
        static readonly Guid DnsClientProvider = new Guid("1c95126e-7eea-49a9-a3fe-a378b03ddb4d");
        static readonly Guid KernelProcessProvider = new Guid("22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716");
        const int DnsClientData1 = 0x1c95126e;
        const int KernelProcessData1 = 0x22fb2cd6;
        const ulong KernelProcessKeyword = 0x10;
        // Traffic from a process we cannot open yet waits this long for its start event.
        const double PendingSeconds = 3;
        const int TcpIpData1 = unchecked((int)0x9a280ac0);
        const int UdpIpData1 = unchecked((int)0xbf3a50c5);
        const int ProcessData1 = unchecked((int)0x3d6fa8d0);
        static readonly int UserDataOffset = 88 + IntPtr.Size;

        readonly object sync = new object();
        readonly Dictionary<int, ProcInfo> procs = new Dictionary<int, ProcInfo>();
        readonly List<int> ended = new List<int>();
        Dictionary<ProcInfo, long[]> usage = new Dictionary<ProcInfo, long[]>();
        Dictionary<FlowKey, long[]> flows = new Dictionary<FlowKey, long[]>();
        readonly List<string> dnsLines = new List<string>();
        readonly Dictionary<string, string> names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        // Image paths from process-start events; they outlive short-lived processes.
        readonly Dictionary<int, KeyValuePair<string, DateTime>> starts = new Dictionary<int, KeyValuePair<string, DateTime>>();
        volatile HashSet<string> flowKeys = new HashSet<string>();
        readonly ProcInfo systemProc = new ProcInfo { Pid = 4, Key = "system", Name = "System" };
        readonly ProcInfo unknownProc = new ProcInfo { Pid = -1, Key = "unknown", Name = "Unknown process" };

        HashSet<uint> localV4 = new HashSet<uint>();
        List<byte[]> localV6 = new List<byte[]>();
        DateTime localsAt = DateTime.MinValue;

        ulong kernelTrace = Native.INVALID_TRACE;
        ulong userTrace = Native.INVALID_TRACE;
        Thread kernelThread, userThread;
        // Kept in fields so the garbage collector never frees the native callback thunks.
        Native.EventRecordCallback kernelCallback, userCallback;
        IntPtr queryName, queryResults, queryStatus, processIdName, imageName;

        public Capture(string owner)
        {
            // Session names are machine-wide, so each signed-in user gets their own pair.
            string suffix = owner.Replace("-", "");
            if (suffix.Length > 40) suffix = suffix.Substring(suffix.Length - 40);
            KernelSession = "UsageMonitorNetKernel-" + suffix;
            UserSession = "UsageMonitorNetUser-" + suffix;
        }

        public void Start()
        {
            RefreshLocals();
            EtwSession.Stop(KernelSession);
            EtwSession.Stop(UserSession);
            uint rc = EtwSession.StartKernel(KernelSession, Guid.NewGuid(), Native.EVENT_TRACE_FLAG_NETWORK_TCPIP | Native.EVENT_TRACE_FLAG_PROCESS);
            if (rc == Native.ERROR_ACCESS_DENIED) throw new InvalidOperationException("Administrator rights are required to read network events.");
            if (rc != 0) throw new InvalidOperationException("Could not start the kernel network trace (error " + rc + ").");
            kernelCallback = OnKernelEvent;
            kernelTrace = EtwSession.Open(KernelSession, kernelCallback);
            if (kernelTrace == Native.INVALID_TRACE)
            {
                EtwSession.Stop(KernelSession);
                throw new InvalidOperationException("Could not open the kernel network trace (error " + Marshal.GetLastWin32Error() + ").");
            }
            kernelThread = EtwSession.Pump(kernelTrace, "etw-kernel");

            try
            {
                queryName = Marshal.StringToHGlobalUni("QueryName");
                queryResults = Marshal.StringToHGlobalUni("QueryResults");
                queryStatus = Marshal.StringToHGlobalUni("QueryStatus");
                processIdName = Marshal.StringToHGlobalUni("ProcessID");
                imageName = Marshal.StringToHGlobalUni("ImageName");
                rc = EtwSession.StartUser(UserSession,
                    new[] { DnsClientProvider, KernelProcessProvider },
                    new[] { ulong.MaxValue, KernelProcessKeyword });
                if (rc != 0) throw new InvalidOperationException("error " + rc);
                userCallback = OnUserEvent;
                userTrace = EtwSession.Open(UserSession, userCallback);
                if (userTrace == Native.INVALID_TRACE) throw new InvalidOperationException("open error " + Marshal.GetLastWin32Error());
                userThread = EtwSession.Pump(userTrace, "etw-user");
            }
            catch (Exception ex)
            {
                // Domains and short-lived process names are extras; byte counting works without them.
                Log.Write("DNS/process trace unavailable: " + ex.Message);
                EtwSession.Stop(UserSession);
            }
        }

        public void Stop()
        {
            EtwSession.Stop(KernelSession);
            EtwSession.Stop(UserSession);
            if (kernelTrace != Native.INVALID_TRACE) { Native.CloseTrace(kernelTrace); kernelTrace = Native.INVALID_TRACE; }
            if (userTrace != Native.INVALID_TRACE) { Native.CloseTrace(userTrace); userTrace = Native.INVALID_TRACE; }
            if (kernelThread != null) kernelThread.Join(3000);
            if (userThread != null) userThread.Join(3000);
        }

        public void SetFlowKeys(string[] keys)
        {
            var next = new HashSet<string>(StringComparer.Ordinal);
            foreach (var k in keys) if (k.Length > 0) next.Add(k);
            flowKeys = next;
        }

        public List<int> PidsForPath(string path)
        {
            var pids = new List<int>();
            lock (sync)
            {
                foreach (var p in procs.Values)
                    if (p.Path != null && string.Equals(p.Path, path, StringComparison.OrdinalIgnoreCase)) pids.Add(p.Pid);
            }
            return pids;
        }

        ProcInfo Resolve(int pid)
        {
            if (pid == 0 || pid == 4) return systemProc;
            if (pid < 0) return unknownProc;
            ProcInfo p;
            if (procs.TryGetValue(pid, out p)) return p;
            p = new ProcInfo { Pid = pid, Seen = DateTime.UtcNow };
            string path = Native.ProcessPath(pid);
            KeyValuePair<string, DateTime> start;
            if (path == null && starts.TryGetValue(pid, out start)) path = start.Key;
            // Events arrive about a second late, so a short-lived process may already be gone.
            // Its key stays null until Flush finds the path from its start event.
            if (path != null) SetPath(p, path);
            procs[pid] = p;
            return p;
        }

        static void SetPath(ProcInfo p, string path)
        {
            p.Path = path;
            p.Exe = System.IO.Path.GetFileName(path);
            p.Key = path.ToLowerInvariant();
        }

        // Called from Flush for processes that could not be identified when first seen.
        bool Finish(ProcInfo p, DateTime now)
        {
            KeyValuePair<string, DateTime> start;
            bool found;
            lock (sync) { found = starts.TryGetValue(p.Pid, out start); }
            if (found)
            {
                SetPath(p, start.Key);
                return true;
            }
            if ((now - p.Seen).TotalSeconds < PendingSeconds) return false;
            string name = null;
            try { using (var proc = Process.GetProcessById(p.Pid)) name = proc.ProcessName; }
            catch { }
            if (name != null)
            {
                p.Key = "proc:" + name.ToLowerInvariant();
                p.Exe = name;
                p.Name = name;
            }
            else
            {
                p.Key = unknownProc.Key;
                p.Name = unknownProc.Name;
            }
            return true;
        }

        void OnKernelEvent(IntPtr rec)
        {
            try
            {
                int provider = Marshal.ReadInt32(rec, 24);
                int opcode = Marshal.ReadByte(rec, 45);
                IntPtr data = Marshal.ReadIntPtr(rec, UserDataOffset);
                int length = (ushort)Marshal.ReadInt16(rec, 86);
                if (provider == TcpIpData1 || provider == UdpIpData1)
                {
                    bool v6;
                    bool send;
                    if (opcode == 10) { send = true; v6 = false; }
                    else if (opcode == 11) { send = false; v6 = false; }
                    else if (opcode == 26) { send = true; v6 = true; }
                    else if (opcode == 27) { send = false; v6 = true; }
                    else return;
                    if (length < (v6 ? 44 : 20)) return;
                    OnTraffic(data, v6, send, provider == UdpIpData1);
                }
                else if (provider == ProcessData1 && opcode == 2)
                {
                    int flags = (ushort)Marshal.ReadInt16(rec, 4);
                    int pointer = (flags & 0x20) != 0 ? 4 : (flags & 0x40) != 0 ? 8 : IntPtr.Size;
                    if (length < pointer + 4) return;
                    int pid = Marshal.ReadInt32(data, pointer);
                    lock (sync) ended.Add(pid);
                }
            }
            catch (Exception) { }
        }

        void OnTraffic(IntPtr data, bool v6, bool send, bool udp)
        {
            int pid = Marshal.ReadInt32(data, 0);
            int size = Marshal.ReadInt32(data, 4);
            if (size <= 0) return;
            string remote;
            int port;
            if (!v6)
            {
                uint d = (uint)Marshal.ReadInt32(data, 8);
                uint s = (uint)Marshal.ReadInt32(data, 12);
                int dport = (Marshal.ReadByte(data, 16) << 8) | Marshal.ReadByte(data, 17);
                int sport = (Marshal.ReadByte(data, 18) << 8) | Marshal.ReadByte(data, 19);
                uint r = d;
                port = dport;
                // The kernel logs daddr as the remote end; swap if a build ever reports it the other way.
                if (localV4.Contains(d) && !localV4.Contains(s)) { r = s; port = sport; }
                if ((r & 0xff) == 127 || d == s) return;
                remote = (r & 0xff) + "." + ((r >> 8) & 0xff) + "." + ((r >> 16) & 0xff) + "." + (r >> 24);
            }
            else
            {
                byte[] d = new byte[16];
                byte[] s = new byte[16];
                Marshal.Copy(IntPtr.Add(data, 8), d, 0, 16);
                Marshal.Copy(IntPtr.Add(data, 24), s, 0, 16);
                int dport = (Marshal.ReadByte(data, 40) << 8) | Marshal.ReadByte(data, 41);
                int sport = (Marshal.ReadByte(data, 42) << 8) | Marshal.ReadByte(data, 43);
                byte[] r = d;
                port = dport;
                if (IsLocalV6(d) && !IsLocalV6(s)) { r = s; port = sport; }
                var address = new IPAddress(r);
                if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
                if (IPAddress.IsLoopback(address)) return;
                remote = address.ToString();
            }

            lock (sync)
            {
                ProcInfo proc = Resolve(pid);
                long[] totals;
                if (!usage.TryGetValue(proc, out totals)) { totals = new long[2]; usage[proc] = totals; }
                totals[send ? 1 : 0] += size;
                if (flowKeys.Count > 0 && flowKeys.Contains(proc.Key))
                {
                    var key = new FlowKey { Proc = proc, Ip = remote, Port = port, Udp = udp };
                    long[] flow;
                    if (!flows.TryGetValue(key, out flow)) { flow = new long[2]; flows[key] = flow; }
                    flow[send ? 1 : 0] += size;
                }
            }
        }

        bool IsLocalV6(byte[] address)
        {
            foreach (var local in localV6)
            {
                bool same = true;
                for (int i = 0; i < 16 && same; i++) same = local[i] == address[i];
                if (same) return true;
            }
            return false;
        }

        void RefreshLocals()
        {
            var v4 = new HashSet<uint>();
            var v6 = new List<byte[]>();
            try
            {
                foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
                {
                    foreach (var ua in nic.GetIPProperties().UnicastAddresses)
                    {
                        byte[] b = ua.Address.GetAddressBytes();
                        if (ua.Address.AddressFamily == AddressFamily.InterNetwork) v4.Add(BitConverter.ToUInt32(b, 0));
                        else if (ua.Address.AddressFamily == AddressFamily.InterNetworkV6) v6.Add(b);
                    }
                }
            }
            catch (Exception) { }
            localV4 = v4;
            localV6 = v6;
            localsAt = DateTime.UtcNow;
        }

        void OnUserEvent(IntPtr rec)
        {
            int provider = Marshal.ReadInt32(rec, 24);
            if (provider == DnsClientData1) OnDnsEvent(rec);
            else if (provider == KernelProcessData1) OnProcessStart(rec);
        }

        void OnProcessStart(IntPtr rec)
        {
            try
            {
                if ((ushort)Marshal.ReadInt16(rec, 40) != 1) return;
                uint pid;
                if (!Tdh.UInt32(rec, processIdName, out pid)) return;
                string path = Native.DosPath(Tdh.String(rec, imageName));
                if (path == null) return;
                lock (sync) { starts[(int)pid] = new KeyValuePair<string, DateTime>(path, DateTime.UtcNow); }
            }
            catch (Exception) { }
        }

        void OnDnsEvent(IntPtr rec)
        {
            try
            {
                int id = (ushort)Marshal.ReadInt16(rec, 40);
                if (id != 3008) return;
                uint status;
                if (!Tdh.UInt32(rec, queryStatus, out status) || status != 0) return;
                string name = Tdh.String(rec, queryName);
                string results = Tdh.String(rec, queryResults);
                if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(results)) return;
                var ips = new List<string>();
                foreach (string token in results.Split(';'))
                {
                    IPAddress address;
                    if (!IPAddress.TryParse(token.Trim(), out address)) continue;
                    if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
                    ips.Add(address.ToString());
                }
                if (ips.Count == 0) return;
                string line = "{\"t\":\"dns\",\"name\":" + Json.Str(name.TrimEnd('.').ToLowerInvariant()) + ",\"ips\":" + Json.StrArray(ips) + "}";
                lock (sync) { if (dnsLines.Count < 2000) dnsLines.Add(line); }
            }
            catch (Exception) { }
        }

        public void Flush(LineWriter writer)
        {
            Dictionary<ProcInfo, long[]> u;
            Dictionary<FlowKey, long[]> f;
            List<string> dns;
            lock (sync)
            {
                u = usage;
                f = flows;
                usage = new Dictionary<ProcInfo, long[]>();
                flows = new Dictionary<FlowKey, long[]>();
                dns = new List<string>(dnsLines);
                dnsLines.Clear();
                foreach (int pid in ended) procs.Remove(pid);
                ended.Clear();
            }
            if ((DateTime.UtcNow - localsAt).TotalSeconds > 30) RefreshLocals();
            foreach (var line in dns) writer.Send(line);

            // Identify processes seen before their start event; hold their bytes briefly if needed.
            DateTime now = DateTime.UtcNow;
            var waiting = new List<KeyValuePair<ProcInfo, long[]>>();
            foreach (var pair in u)
                if (pair.Key.Key == null && !Finish(pair.Key, now)) waiting.Add(pair);
            foreach (var pair in waiting) u.Remove(pair.Key);
            lock (sync)
            {
                foreach (var pair in waiting)
                {
                    long[] totals;
                    if (!usage.TryGetValue(pair.Key, out totals)) { totals = new long[2]; usage[pair.Key] = totals; }
                    totals[0] += pair.Value[0];
                    totals[1] += pair.Value[1];
                }
                var stale = new List<int>();
                foreach (var pair in starts) if ((now - pair.Value.Value).TotalSeconds > 60) stale.Add(pair.Key);
                foreach (int pid in stale) starts.Remove(pid);
            }

            // Group every instance of the same program into one row.
            var apps = new Dictionary<string, AppTotals>(StringComparer.Ordinal);
            foreach (var pair in u)
            {
                ProcInfo p = pair.Key;
                AppTotals t;
                if (!apps.TryGetValue(p.Key, out t))
                {
                    t = new AppTotals { Proc = p, Pids = new List<int>() };
                    apps[p.Key] = t;
                }
                t.Rx += pair.Value[0];
                t.Tx += pair.Value[1];
                if (!t.Pids.Contains(p.Pid)) t.Pids.Add(p.Pid);
            }
            var sb = new StringBuilder();
            sb.Append("{\"t\":\"tick\",\"ts\":").Append((long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds).Append(",\"apps\":[");
            bool first = true;
            foreach (var t in apps.Values)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"k\":").Append(Json.Str(t.Proc.Key))
                  .Append(",\"p\":").Append(Json.Str(t.Proc.Path))
                  .Append(",\"n\":").Append(Json.Str(NameOf(t.Proc)))
                  .Append(",\"x\":").Append(Json.Str(t.Proc.Exe))
                  .Append(",\"rx\":").Append(t.Rx)
                  .Append(",\"tx\":").Append(t.Tx)
                  .Append(",\"pids\":[").Append(string.Join(",", t.Pids)).Append("]}");
            }
            sb.Append("],\"flows\":[");
            first = true;
            foreach (var pair in f)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"k\":").Append(Json.Str(pair.Key.Proc.Key))
                  .Append(",\"ip\":").Append(Json.Str(pair.Key.Ip))
                  .Append(",\"port\":").Append(pair.Key.Port)
                  .Append(",\"proto\":").Append(pair.Key.Udp ? "\"udp\"" : "\"tcp\"")
                  .Append(",\"rx\":").Append(pair.Value[0])
                  .Append(",\"tx\":").Append(pair.Value[1]).Append('}');
            }
            sb.Append("]}");
            writer.Send(sb.ToString());
        }

        string NameOf(ProcInfo p)
        {
            if (p.Name != null) return p.Name;
            string name;
            if (!names.TryGetValue(p.Path, out name))
            {
                try
                {
                    var info = FileVersionInfo.GetVersionInfo(p.Path);
                    name = (info.FileDescription ?? "").Trim();
                    if (name.Length == 0) name = (info.ProductName ?? "").Trim();
                }
                catch (Exception) { name = ""; }
                if (name.Length == 0) name = System.IO.Path.GetFileNameWithoutExtension(p.Path);
                names[p.Path] = name;
            }
            p.Name = name;
            return name;
        }

        sealed class AppTotals
        {
            public ProcInfo Proc;
            public long Rx;
            public long Tx;
            public List<int> Pids;
        }
    }

    static class EtwSession
    {
        const int NameBytes = 1024;

        static IntPtr Properties(uint logFileMode, uint enableFlags, Guid guid, out int size)
        {
            int structSize = Marshal.SizeOf(typeof(Native.EVENT_TRACE_PROPERTIES));
            size = structSize + NameBytes * 2;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            for (int i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
            var props = new Native.EVENT_TRACE_PROPERTIES();
            props.Wnode.BufferSize = (uint)size;
            props.Wnode.Guid = guid;
            props.Wnode.ClientContext = 1;
            props.Wnode.Flags = Native.WNODE_FLAG_TRACED_GUID;
            props.BufferSize = 64;
            props.MinimumBuffers = 4;
            props.MaximumBuffers = 64;
            props.LogFileMode = logFileMode;
            props.FlushTimer = 1;
            props.EnableFlags = enableFlags;
            props.LogFileNameOffset = 0;
            props.LoggerNameOffset = (uint)structSize;
            Marshal.StructureToPtr(props, buffer, false);
            return buffer;
        }

        public static uint StartKernel(string name, Guid guid, uint flags)
        {
            int size;
            IntPtr props = Properties(Native.EVENT_TRACE_REAL_TIME_MODE | Native.EVENT_TRACE_SYSTEM_LOGGER_MODE, flags, guid, out size);
            try
            {
                ulong handle;
                return Native.StartTraceW(out handle, name, props);
            }
            finally { Marshal.FreeHGlobal(props); }
        }

        // Starts a real-time session for user-mode providers; succeeds if at least one enables.
        public static uint StartUser(string name, Guid[] providers, ulong[] keywords)
        {
            int size;
            IntPtr props = Properties(Native.EVENT_TRACE_REAL_TIME_MODE, 0, Guid.NewGuid(), out size);
            try
            {
                ulong handle;
                uint rc = Native.StartTraceW(out handle, name, props);
                if (rc != 0) return rc;
                int enabled = 0;
                for (int i = 0; i < providers.Length; i++)
                {
                    Guid provider = providers[i];
                    uint r = Native.EnableTraceEx2(handle, ref provider, 1, 4, keywords[i], 0, 0, IntPtr.Zero);
                    if (r == 0) enabled++;
                    else { rc = r; Log.Write("provider " + provider + " not enabled: " + r); }
                }
                if (enabled > 0) return 0;
                Stop(name);
                return rc;
            }
            finally { Marshal.FreeHGlobal(props); }
        }

        public static void Stop(string name)
        {
            int size;
            IntPtr props = Properties(0, 0, Guid.Empty, out size);
            try { Native.ControlTraceW(0, name, props, Native.EVENT_TRACE_CONTROL_STOP); }
            finally { Marshal.FreeHGlobal(props); }
        }

        public static ulong Open(string name, Native.EventRecordCallback callback)
        {
            var logfile = new Native.EVENT_TRACE_LOGFILE();
            logfile.LoggerName = name;
            logfile.ProcessTraceMode = Native.PROCESS_TRACE_MODE_REAL_TIME | Native.PROCESS_TRACE_MODE_EVENT_RECORD;
            logfile.EventRecordCallback = callback;
            return Native.OpenTraceW(ref logfile);
        }

        public static Thread Pump(ulong trace, string name)
        {
            var thread = new Thread(delegate ()
            {
                uint rc = Native.ProcessTrace(new[] { trace }, 1, IntPtr.Zero, IntPtr.Zero);
                if (rc != 0 && rc != Native.ERROR_CANCELLED) Log.Write(name + " stopped: " + rc);
            });
            thread.IsBackground = true;
            thread.Name = name;
            thread.Start();
            return thread;
        }
    }

    static class Tdh
    {
        static bool Read(IntPtr rec, IntPtr name, out IntPtr buffer, out uint size)
        {
            buffer = IntPtr.Zero;
            var descriptor = new Native.PROPERTY_DATA_DESCRIPTOR();
            descriptor.PropertyName = (ulong)name.ToInt64();
            descriptor.ArrayIndex = uint.MaxValue;
            if (Native.TdhGetPropertySize(rec, 0, IntPtr.Zero, 1, ref descriptor, out size) != 0 || size == 0 || size > 65536) return false;
            buffer = Marshal.AllocHGlobal((int)size);
            if (Native.TdhGetProperty(rec, 0, IntPtr.Zero, 1, ref descriptor, size, buffer) == 0) return true;
            Marshal.FreeHGlobal(buffer);
            buffer = IntPtr.Zero;
            return false;
        }

        public static string String(IntPtr rec, IntPtr name)
        {
            IntPtr buffer;
            uint size;
            if (!Read(rec, name, out buffer, out size)) return null;
            try { return Marshal.PtrToStringUni(buffer, (int)(size / 2)).TrimEnd('\0'); }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        public static bool UInt32(IntPtr rec, IntPtr name, out uint value)
        {
            value = 0;
            IntPtr buffer;
            uint size;
            if (!Read(rec, name, out buffer, out size)) return false;
            try
            {
                if (size < 4) return false;
                value = (uint)Marshal.ReadInt32(buffer);
                return true;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }

    static class Firewall
    {
        const string Group = "Usage Monitor";

        static dynamic Policy()
        {
            return Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2", true));
        }

        public static bool IsEnabled()
        {
            try
            {
                object policy = Policy();
                Type type = policy.GetType();
                int current = (int)type.InvokeMember("CurrentProfileTypes", System.Reflection.BindingFlags.GetProperty, null, policy, null);
                foreach (int profile in new[] { 1, 2, 4 })
                {
                    if ((current & profile) == 0) continue;
                    object on = type.InvokeMember("FirewallEnabled", System.Reflection.BindingFlags.GetProperty, null, policy, new object[] { profile });
                    if (!(bool)on) return false;
                }
                return true;
            }
            catch (Exception) { return false; }
        }

        static string Marker(string sid) { return "[usage-monitor " + sid + "]"; }

        static bool Ours(dynamic rule, string sid)
        {
            string grouping = rule.Grouping as string;
            string description = rule.Description as string;
            return grouping == Group && description != null && description.Contains(Marker(sid));
        }

        public static List<string> Blocked(string sid)
        {
            var paths = new List<string>();
            dynamic policy = Policy();
            foreach (dynamic rule in policy.Rules)
            {
                if (!Ours(rule, sid) || (int)rule.Direction != 2) continue;
                string app = rule.ApplicationName as string;
                if (!string.IsNullOrEmpty(app) && !paths.Exists(p => string.Equals(p, app, StringComparison.OrdinalIgnoreCase))) paths.Add(app);
            }
            return paths;
        }

        public static void Block(string path, string sid)
        {
            Unblock(path, sid);
            dynamic policy = Policy();
            Type ruleType = Type.GetTypeFromProgID("HNetCfg.FWRule", true);
            foreach (int direction in new[] { 2, 1 })
            {
                dynamic rule = Activator.CreateInstance(ruleType);
                rule.Name = "Usage Monitor - block " + Path.GetFileName(path) + (direction == 2 ? " (outbound)" : " (inbound)");
                rule.Description = "Internet blocked by Usage Monitor for " + path + " " + Marker(sid);
                rule.ApplicationName = path;
                rule.Protocol = 256;
                rule.Direction = direction;
                rule.Action = 0;
                rule.Grouping = Group;
                rule.Profiles = 0x7FFFFFFF;
                rule.InterfaceTypes = "All";
                rule.Enabled = true;
                policy.Rules.Add(rule);
            }
        }

        public static void Unblock(string path, string sid)
        {
            dynamic policy = Policy();
            // Rules are removed by name, so rename matches to a unique name first.
            var doomed = new List<dynamic>();
            foreach (dynamic rule in policy.Rules)
            {
                if (!Ours(rule, sid)) continue;
                string app = rule.ApplicationName as string;
                if (string.Equals(app, path, StringComparison.OrdinalIgnoreCase)) doomed.Add(rule);
            }
            foreach (dynamic rule in doomed)
            {
                string unique = "Usage Monitor - removing " + Guid.NewGuid().ToString("N");
                rule.Name = unique;
                policy.Rules.Remove(unique);
            }
        }
    }

    // Resets established IPv4 TCP connections so a new block rule applies immediately.
    static class TcpReset
    {
        public static void CloseConnections(List<int> pids)
        {
            if (pids.Count == 0) return;
            int size = 0;
            Native.GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 4, 0);
            if (size <= 0) return;
            IntPtr table = Marshal.AllocHGlobal(size);
            try
            {
                if (Native.GetExtendedTcpTable(table, ref size, false, 2, 4, 0) != 0) return;
                int count = Marshal.ReadInt32(table);
                for (int i = 0; i < count; i++)
                {
                    IntPtr row = IntPtr.Add(table, 4 + i * 24);
                    int state = Marshal.ReadInt32(row, 0);
                    int pid = Marshal.ReadInt32(row, 20);
                    if (state != 5 || !pids.Contains(pid)) continue;
                    var entry = new Native.MIB_TCPROW
                    {
                        State = 12,
                        LocalAddr = (uint)Marshal.ReadInt32(row, 4),
                        LocalPort = (uint)Marshal.ReadInt32(row, 8),
                        RemoteAddr = (uint)Marshal.ReadInt32(row, 12),
                        RemotePort = (uint)Marshal.ReadInt32(row, 16),
                    };
                    Native.SetTcpEntry(ref entry);
                }
            }
            finally { Marshal.FreeHGlobal(table); }
        }
    }

    static class SelfTest
    {
        public static int Run(string output)
        {
            var sb = new StringBuilder();
            sb.Append("{\"pointer\":").Append(IntPtr.Size)
              .Append(",\"logfile\":").Append(Marshal.SizeOf(typeof(Native.EVENT_TRACE_LOGFILE)))
              .Append(",\"properties\":").Append(Marshal.SizeOf(typeof(Native.EVENT_TRACE_PROPERTIES)))
              .Append(",\"header\":").Append(Marshal.SizeOf(typeof(Native.TRACE_LOGFILE_HEADER)))
              .Append(",\"elevated\":").Append(new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator) ? "true" : "false");
            try
            {
                var capture = new Capture("selftest");
                capture.Start();
                var buffer = new MemoryStream();
                var writer = new LineWriter(buffer);
                for (int i = 0; i < 5; i++) { Thread.Sleep(1000); capture.Flush(writer); }
                capture.Stop();
                sb.Append(",\"capture\":true,\"lines\":").Append(Json.Str(Encoding.UTF8.GetString(buffer.ToArray())));
            }
            catch (Exception ex)
            {
                sb.Append(",\"capture\":false,\"error\":").Append(Json.Str(ex.Message));
            }
            try { sb.Append(",\"firewall\":").Append(Firewall.IsEnabled() ? "true" : "false"); }
            catch (Exception ex) { sb.Append(",\"firewallError\":").Append(Json.Str(ex.Message)); }
            sb.Append('}');
            File.WriteAllText(output, sb.ToString());
            return 0;
        }
    }

    static class Native
    {
        public const uint ERROR_ACCESS_DENIED = 5;
        public const uint ERROR_CANCELLED = 1223;
        public const int ERROR_FILE_NOT_FOUND = 2;
        public const uint EVENT_TRACE_REAL_TIME_MODE = 0x00000100;
        public const uint EVENT_TRACE_SYSTEM_LOGGER_MODE = 0x02000000;
        public const uint EVENT_TRACE_FLAG_PROCESS = 0x00000001;
        public const uint EVENT_TRACE_FLAG_NETWORK_TCPIP = 0x00010000;
        public const uint EVENT_TRACE_CONTROL_STOP = 1;
        public const uint WNODE_FLAG_TRACED_GUID = 0x00020000;
        public const uint PROCESS_TRACE_MODE_REAL_TIME = 0x00000100;
        public const uint PROCESS_TRACE_MODE_EVENT_RECORD = 0x10000000;
        public const ulong INVALID_TRACE = ulong.MaxValue;
        public const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const uint TOKEN_QUERY = 0x0008;

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate void EventRecordCallback(IntPtr eventRecord);

        [StructLayout(LayoutKind.Sequential)]
        public struct WNODE_HEADER
        {
            public uint BufferSize;
            public uint ProviderId;
            public ulong HistoricalContext;
            public long TimeStamp;
            public Guid Guid;
            public uint ClientContext;
            public uint Flags;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct EVENT_TRACE_PROPERTIES
        {
            public WNODE_HEADER Wnode;
            public uint BufferSize;
            public uint MinimumBuffers;
            public uint MaximumBuffers;
            public uint MaximumFileSize;
            public uint LogFileMode;
            public uint FlushTimer;
            public uint EnableFlags;
            public int AgeLimit;
            public uint NumberOfBuffers;
            public uint FreeBuffers;
            public uint EventsLost;
            public uint BuffersWritten;
            public uint LogBuffersLost;
            public uint RealTimeBuffersLost;
            public IntPtr LoggerThreadId;
            public uint LogFileNameOffset;
            public uint LoggerNameOffset;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct EVENT_TRACE_HEADER
        {
            public ushort Size;
            public ushort FieldTypeFlags;
            public uint Version;
            public uint ThreadId;
            public uint ProcessId;
            public long TimeStamp;
            public Guid Guid;
            public ulong ProcessorTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct EVENT_TRACE
        {
            public EVENT_TRACE_HEADER Header;
            public uint InstanceId;
            public uint ParentInstanceId;
            public Guid ParentGuid;
            public IntPtr MofData;
            public uint MofLength;
            public uint ClientContext;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SYSTEMTIME
        {
            public ushort Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct TIME_ZONE_INFORMATION
        {
            public int Bias;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string StandardName;
            public SYSTEMTIME StandardDate;
            public int StandardBias;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DaylightName;
            public SYSTEMTIME DaylightDate;
            public int DaylightBias;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct TRACE_LOGFILE_HEADER
        {
            public uint BufferSize;
            public uint Version;
            public uint ProviderVersion;
            public uint NumberOfProcessors;
            public long EndTime;
            public uint TimerResolution;
            public uint MaximumFileSize;
            public uint LogFileMode;
            public uint BuffersWritten;
            public Guid LogInstanceGuid;
            public IntPtr LoggerName;
            public IntPtr LogFileName;
            public TIME_ZONE_INFORMATION TimeZone;
            public long BootTime;
            public long PerfFreq;
            public long StartTime;
            public uint ReservedFlags;
            public uint BuffersLost;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct EVENT_TRACE_LOGFILE
        {
            [MarshalAs(UnmanagedType.LPWStr)] public string LogFileName;
            [MarshalAs(UnmanagedType.LPWStr)] public string LoggerName;
            public long CurrentTime;
            public uint BuffersRead;
            public uint ProcessTraceMode;
            public EVENT_TRACE CurrentEvent;
            public TRACE_LOGFILE_HEADER LogfileHeader;
            public IntPtr BufferCallback;
            public uint BufferSize;
            public uint Filled;
            public uint EventsLost;
            public EventRecordCallback EventRecordCallback;
            public uint IsKernelTrace;
            public IntPtr Context;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROPERTY_DATA_DESCRIPTOR
        {
            public ulong PropertyName;
            public uint ArrayIndex;
            public uint Reserved;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MIB_TCPROW
        {
            public uint State;
            public uint LocalAddr;
            public uint LocalPort;
            public uint RemoteAddr;
            public uint RemotePort;
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        public static extern uint StartTraceW(out ulong sessionHandle, string sessionName, IntPtr properties);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        public static extern uint ControlTraceW(ulong sessionHandle, string sessionName, IntPtr properties, uint controlCode);

        [DllImport("advapi32.dll")]
        public static extern uint EnableTraceEx2(ulong traceHandle, ref Guid providerId, uint controlCode, byte level,
            ulong matchAnyKeyword, ulong matchAllKeyword, uint timeout, IntPtr enableParameters);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern ulong OpenTraceW(ref EVENT_TRACE_LOGFILE logfile);

        [DllImport("advapi32.dll")]
        public static extern uint ProcessTrace(ulong[] handleArray, uint handleCount, IntPtr startTime, IntPtr endTime);

        [DllImport("advapi32.dll")]
        public static extern uint CloseTrace(ulong traceHandle);

        [DllImport("tdh.dll")]
        public static extern uint TdhGetPropertySize(IntPtr eventRecord, uint contextCount, IntPtr context,
            uint propertyDataCount, ref PROPERTY_DATA_DESCRIPTOR propertyData, out uint propertySize);

        [DllImport("tdh.dll")]
        public static extern uint TdhGetProperty(IntPtr eventRecord, uint contextCount, IntPtr context,
            uint propertyDataCount, ref PROPERTY_DATA_DESCRIPTOR propertyData, uint bufferSize, IntPtr buffer);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(int access, bool inherit, int pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool WaitNamedPipe(string name, int timeout);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint QueryDosDeviceW(string deviceName, StringBuilder targetPath, int max);

        static Dictionary<string, string> devices;
        static DateTime devicesAt = DateTime.MinValue;

        static Dictionary<string, string> LoadDevices()
        {
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var sb = new StringBuilder(1024);
            foreach (string drive in Environment.GetLogicalDrives())
            {
                string letter = drive.Substring(0, 2);
                if (QueryDosDeviceW(letter, sb, sb.Capacity) != 0 && !map.ContainsKey(sb.ToString())) map[sb.ToString()] = letter;
            }
            devices = map;
            devicesAt = DateTime.UtcNow;
            return map;
        }

        // \Device\HarddiskVolume3\Windows\x.exe -> C:\Windows\x.exe
        public static string DosPath(string nt)
        {
            if (string.IsNullOrEmpty(nt)) return null;
            if (nt.StartsWith("\\??\\")) nt = nt.Substring(4);
            if (nt.Length > 2 && nt[1] == ':') return nt;
            if (nt.StartsWith("\\SystemRoot\\", StringComparison.OrdinalIgnoreCase))
                return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), nt.Substring(12));
            if (nt.StartsWith("\\Device\\Mup\\", StringComparison.OrdinalIgnoreCase)) return "\\\\" + nt.Substring(12);
            for (int attempt = 0; attempt < 2; attempt++)
            {
                var map = devices;
                if (map == null || attempt == 1)
                {
                    if (attempt == 1 && (DateTime.UtcNow - devicesAt).TotalSeconds < 30) break;
                    map = LoadDevices();
                }
                foreach (var pair in map)
                    if (nt.StartsWith(pair.Key + "\\", StringComparison.OrdinalIgnoreCase)) return pair.Value + nt.Substring(pair.Key.Length);
            }
            return null;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("iphlpapi.dll")]
        public static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, int reserved);

        [DllImport("iphlpapi.dll")]
        public static extern uint SetTcpEntry(ref MIB_TCPROW row);

        public static string ProcessPath(int pid)
        {
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return null;
            try
            {
                var sb = new StringBuilder(1024);
                int size = sb.Capacity;
                return QueryFullProcessImageNameW(process, 0, sb, ref size) ? sb.ToString(0, size) : null;
            }
            finally { CloseHandle(process); }
        }
    }
}
