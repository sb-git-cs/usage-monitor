const { spawn } = require("child_process");

const SCRIPT = `
$ErrorActionPreference = 'Stop'
if (-not ('WinCredRead' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinCredRead {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
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
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr cred);
  public static string ReadUtf8(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      var cred = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] bytes = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
      return Encoding.UTF8.GetString(bytes);
    } finally {
      CredFree(p);
    }
  }
}
"@
}
$raw = [WinCredRead]::ReadUtf8($env:USAGE_MONITOR_CRED_TARGET)
if ([string]::IsNullOrEmpty($raw)) { exit 2 }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.Write($raw)
`;

function readGenericCredential(target, timeoutMs = 12000) {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")],
      {
        windowsHide: true,
        env: { ...process.env, USAGE_MONITOR_CRED_TARGET: String(target) },
      }
    );
    let stdout = "";
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(val);
    };
    const killer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0 || !stdout) return finish(null);
      const start = stdout.indexOf("{");
      const json = start >= 0 ? stdout.slice(start) : stdout;
      try {
        finish(JSON.parse(json));
      } catch {
        finish(null);
      }
    });
  });
}

// Writes a generic credential's blob as UTF-8, the way the Antigravity CLI stores its sign-in.
const WRITE_SCRIPT = `
$ErrorActionPreference = 'Stop'
if (-not ('WinCredWrite' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinCredWrite {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
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
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL credential, int flags);
  public static bool WriteUtf8(string target, string text) {
    byte[] bytes = Encoding.UTF8.GetBytes(text);
    var cred = new CREDENTIAL();
    cred.Type = 1;
    cred.TargetName = target;
    cred.CredentialBlobSize = bytes.Length;
    cred.CredentialBlob = Marshal.AllocHGlobal(bytes.Length);
    cred.Persist = 2;
    cred.UserName = Environment.UserName;
    try {
      Marshal.Copy(bytes, 0, cred.CredentialBlob, bytes.Length);
      return CredWrite(ref cred, 0);
    } finally {
      Marshal.FreeHGlobal(cred.CredentialBlob);
    }
  }
}
"@
}
if (-not [WinCredWrite]::WriteUtf8($env:USAGE_MONITOR_CRED_TARGET, $env:USAGE_MONITOR_CRED_TEXT)) { exit 3 }
`;

function writeGenericCredential(target, text, timeoutMs = 12000) {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WRITE_SCRIPT, "utf16le").toString("base64")],
        { windowsHide: true, env: { ...process.env, USAGE_MONITOR_CRED_TARGET: String(target), USAGE_MONITOR_CRED_TEXT: String(text) } }
      );
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(val);
    };
    const killer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(false);
    }, timeoutMs);
    child.stdout.on("data", () => {});
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

module.exports = { readGenericCredential, writeGenericCredential };
