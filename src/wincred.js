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

module.exports = { readGenericCredential };
