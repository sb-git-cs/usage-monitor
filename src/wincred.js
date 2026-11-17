// Generic Windows credentials whose blob is UTF-8 text, the way the Antigravity CLI stores its
// sign-in. They are read and written by the resident Windows helper ("cred" channel); each read
// used to start PowerShell and compile a small C# reader.
const winhelper = require("./winhelper");

// The credential's JSON (from its first "{"), or null when it is missing, unreadable or not JSON.
function readGenericCredential(target, timeoutMs = 12000) {
  if (process.platform !== "win32") return Promise.resolve(null);
  return winhelper.request("cred", JSON.stringify({ op: "read", target: String(target) }), { timeoutMs })
    .then((line) => {
      const text = JSON.parse(line).text;
      if (typeof text !== "string" || !text) return null;
      const start = text.indexOf("{");
      return JSON.parse(start >= 0 ? text.slice(start) : text);
    })
    .catch(() => null);
}

function writeGenericCredential(target, text, timeoutMs = 12000) {
  if (process.platform !== "win32") return Promise.resolve(false);
  return winhelper.request("cred", JSON.stringify({ op: "write", target: String(target), text: String(text) }), { timeoutMs })
    .then((line) => JSON.parse(line).ok === true)
    .catch(() => false);
}

module.exports = { readGenericCredential, writeGenericCredential };
