// A GitHub token the Copilot meter can reuse. The token stays in memory and is never logged.
const fs = require("fs");
const { spawn } = require("child_process");
const { ghHosts, cliPath, cliOnPath } = require("./paths");

const TOKEN = /^(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]+$/;
const CACHE_MS = 60_000;
let cache = { token: "", at: 0 };

function usable(value) {
  const token = String(value || "").replace(/\0/g, "").trim();
  return TOKEN.test(token) ? token : "";
}

function fromHosts() {
  for (const file of ghHosts()) {
    try {
      const match = /oauth_token:\s*(\S+)/.exec(fs.readFileSync(file, "utf8"));
      const token = usable(match && match[1]);
      if (token) return token;
    } catch {
      /* the next file may exist */
    }
  }
  return "";
}

function run(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch {
      resolve("");
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(value);
    };
    const killer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish("");
    }, 8000);
    if (child.stdout) child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => finish(""));
    child.on("close", (code) => finish(code === 0 ? stdout.trim() : ""));
  });
}

async function fromGh() {
  const bin = cliPath("gh");
  if (!bin) return "";
  const args = ["auth", "token"];
  const stdout = bin.endsWith(".cmd") || bin.endsWith(".bat")
    ? await run("cmd.exe", ["/d", "/c", bin, ...args])
    : await run(bin, args);
  return usable(stdout);
}

// Windows Credential Manager stores this blob as UTF-16LE. Ask PowerShell for base64 so NULs survive.
const CRED_SCRIPT = `
$ErrorActionPreference = 'Stop'
if (-not ('UsageMonitorGitHubCred' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class UsageMonitorGitHubCred {
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
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);
  public static string ReadBase64() {
    IntPtr p;
    if (!CredRead("git:https://github.com", 1, 0, out p)) return "";
    try {
      var cred = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      if (cred.CredentialBlobSize <= 0 || cred.CredentialBlob == IntPtr.Zero) return "";
      byte[] bytes = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
      return Convert.ToBase64String(bytes);
    } finally { CredFree(p); }
  }
}
"@
}
[Console]::Out.Write([UsageMonitorGitHubCred]::ReadBase64())
`;

function decodeBlob(encoded) {
  try {
    const buf = Buffer.from(String(encoded || "").trim(), "base64");
    if (!buf.length) return "";
    const utf16 = buf.length >= 4 && buf[1] === 0 && buf[3] === 0;
    return usable(utf16 ? buf.toString("utf16le") : buf.toString("utf8"));
  } catch {
    return "";
  }
}

async function fromWindows() {
  if (process.platform !== "win32") return "";
  const encoded = Buffer.from(CRED_SCRIPT, "utf16le").toString("base64");
  return decodeBlob(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]));
}

// The gh logins saved for github.com in hosts.yml, and which one is active. gh keeps one
// token per login, so switching between them needs no new sign-in.
function users() {
  for (const file of ghHosts()) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const host = /^github\.com:\s*\n((?:[ \t]+.*\n?)*)/m.exec(text);
    if (!host) continue;
    const block = host[1];
    const active = (/^[ \t]+user:[ \t]*([A-Za-z0-9-]{1,39})[ \t]*$/m.exec(block) || [])[1] || null;
    const logins = [];
    const section = /^([ \t]+)users:[ \t]*\n((?:\1[ \t]+.*\n?)*)/m.exec(block);
    if (section) {
      const indent = section[1].length;
      for (const line of section[2].split("\n")) {
        const m = /^([ \t]+)([A-Za-z0-9-]{1,39}):[ \t]*$/.exec(line);
        if (m && m[1].length > indent && !logins.includes(m[2])) logins.push(m[2]);
      }
    }
    if (active && !logins.includes(active)) logins.unshift(active);
    if (logins.length) return { active, logins };
  }
  return { active: null, logins: [] };
}

// gh auth switch: the saved token for that login becomes the active one.
async function switchUser(login) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(String(login || ""))) return false;
  const bin = cliPath("gh");
  if (!bin) return false;
  const args = ["auth", "switch", "--hostname", "github.com", "--user", login];
  const ok = await new Promise((resolve) => {
    let child;
    try {
      child = bin.endsWith(".cmd") || bin.endsWith(".bat")
        ? spawn("cmd.exe", ["/d", "/c", bin, ...args], { windowsHide: true })
        : spawn(bin, args, { windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve(value);
    };
    const killer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(false);
    }, 8000);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
  if (ok) forget();
  return ok;
}

async function token() {
  const now = Date.now();
  if (cache.at && now - cache.at < CACHE_MS) return cache.token;
  let found = fromHosts();
  if (!found && cliOnPath("gh")) found = await fromGh();
  if (!found) found = await fromWindows();
  cache = { token: found, at: now };
  return found;
}

function forget() {
  cache = { token: "", at: 0 };
}

module.exports = { token, forget, usable, decodeBlob, users, switchUser };
