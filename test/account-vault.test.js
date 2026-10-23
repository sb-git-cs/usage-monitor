const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { load } = require("./helpers");

const homeDir = path.join("/home/tester");
const configDir = path.join(homeDir, "config");
const claudeCreds = path.join(homeDir, ".claude", ".credentials.json");
const claudeJson = path.join(homeDir, ".claude.json");
const codexAuth = path.join(homeDir, ".codex", "auth.json");
const geminiOAuth = path.join(homeDir, ".gemini", "oauth_creds.json");
const geminiToken = path.join(homeDir, ".gemini", "token");
const cursorAuth = path.join(homeDir, "cursor", "auth.json");
const cursorDb = path.join(homeDir, "cursor", "User", "globalStorage", "state.vscdb");

// An in-memory disk; the vault file and the CLI files live side by side.
function harness(files, codec) {
  const disk = { ...files };
  const written = [];
  const fs = {
    readFileSync: (file) => {
      if (!Object.hasOwn(disk, file)) throw new Error(`ENOENT ${file}`);
      return disk[file];
    },
    statSync: (file) => {
      if (!Object.hasOwn(disk, file)) throw new Error(`ENOENT ${file}`);
      return { isFile: () => true, size: disk[file].length };
    },
    writeFileSync: (file, text) => { disk[file] = text; written.push(file); },
    renameSync: (from, to) => { disk[to] = disk[from]; delete disk[from]; },
    mkdirSync() {},
  };
  const vault = load("src/account-vault.js", {
    fs,
    "./paths": {
      home: () => homeDir,
      configDir: () => configDir,
      claudeCredentials: () => claudeCreds,
      codexAuth: () => codexAuth,
      geminiOAuth: () => geminiOAuth,
      antigravityToken: () => geminiToken,
      cursorAuth: () => cursorAuth,
      cursorStateDb: () => cursorDb,
      writeSecretFile: (file, text) => { disk[file] = text; written.push(file); },
    },
  });
  vault.init(codec);
  return { vault, disk, written };
}

const keychain = {
  available: true,
  encrypt: (text) => Buffer.from(`enc:${text}`, "utf8"),
  decrypt: (buf) => buf.toString("utf8").replace(/^enc:/, ""),
};

test("sign-ins are saved per account, encrypted, and put back when activated", () => {
  const { vault, disk, written } = harness({
    [claudeCreds]: JSON.stringify({ claudeAiOauth: { accessToken: "alice-access", refreshToken: "alice-refresh" } }),
    [claudeJson]: JSON.stringify({ oauthAccount: { emailAddress: "alice@example.com" }, projects: { "/work": { allowed: true } } }),
  }, keychain);
  assert.equal(vault.capture("claude", { id: "alice@example.com", label: "alice@example.com" }), true);
  assert.equal(vault.capture("claude", { id: "alice@example.com", label: "alice@example.com" }), false, "an unchanged login is not rewritten");
  const stored = disk[path.join(configDir, "accounts.json")];
  assert.ok(stored, "the vault file is written");
  assert.equal(stored.includes("alice-refresh"), false, "tokens are stored encrypted");
  assert.equal(stored.includes("alice-access"), false);
  assert.deepEqual(vault.list("claude").map((e) => [e.id, e.label]), [["alice@example.com", "alice@example.com"]]);

  // Bob signs in through the CLI: his files replace Alice's, and are saved beside hers.
  disk[claudeCreds] = JSON.stringify({ claudeAiOauth: { accessToken: "bob-access", refreshToken: "bob-refresh" } });
  disk[claudeJson] = JSON.stringify({ oauthAccount: { emailAddress: "bob@example.com" }, projects: { "/work": { allowed: true }, "/new": {} } });
  assert.equal(vault.capture("claude", { id: "bob@example.com", label: "bob@example.com" }), true);
  assert.deepEqual(vault.list("claude").map((e) => e.id), ["bob@example.com", "alice@example.com"]);

  // Back to Alice: her credential file returns and only the account block of the config changes.
  const before = written.length;
  assert.deepEqual(vault.activate("claude", "alice@example.com"), { ok: true });
  assert.equal(JSON.parse(disk[claudeCreds]).claudeAiOauth.refreshToken, "alice-refresh");
  const config = JSON.parse(disk[claudeJson]);
  assert.equal(config.oauthAccount.emailAddress, "alice@example.com");
  assert.deepEqual(config.projects, { "/work": { allowed: true }, "/new": {} }, "unrelated settings stay as Bob left them");
  assert.ok(written.slice(before).includes(claudeCreds));
  assert.equal(vault.activate("claude", "nobody@example.com").ok, false);
  assert.equal(vault.activate("claude", "../etc/passwd").ok, false);
  assert.equal(vault.forget("claude", "bob@example.com"), true);
  assert.deepEqual(vault.list("claude").map((e) => e.id), ["alice@example.com"]);
  assert.equal(vault.forget("claude", "bob@example.com"), false);
});

test("a vault written without the keychain is not read as encrypted, and codec copies are dropped", () => {
  const files = { [codexAuth]: JSON.stringify({ tokens: { access_token: "plain-token" } }) };
  const plain = harness(files, { available: false });
  assert.equal(plain.vault.capture("codex", { id: "codex@example.com", label: "codex@example.com" }), true);
  const stored = plain.disk[path.join(configDir, "accounts.json")];
  assert.equal(JSON.parse(stored).codec, "plain");
  // The same file opened with the keychain available: its plain copies cannot be trusted as ciphertext.
  const upgraded = harness({ ...files, [path.join(configDir, "accounts.json")]: stored }, keychain);
  assert.deepEqual(upgraded.vault.list("codex"), []);
  assert.equal(upgraded.vault.capture("codex", { id: "codex@example.com", label: "codex@example.com" }), true);
  assert.equal(JSON.parse(upgraded.disk[path.join(configDir, "accounts.json")]).codec, "keychain");
});

test("only the tool's own credential paths are written back, and identities are validated", () => {
  const { vault, disk } = harness({ [cursorAuth]: JSON.stringify({ accessToken: "x".repeat(30) }) }, keychain);
  assert.equal(vault.capture("cursor", { id: "<script>", label: "bad" }), false);
  assert.equal(vault.capture("copilot", { id: "octocat", label: "octocat" }), false, "gh keeps its own list");
  assert.equal(vault.capture("cursor", { id: "user_1", label: "me@example.com" }), true);
  // A tampered vault entry naming another file is ignored on activation.
  const file = path.join(configDir, "accounts.json");
  const data = JSON.parse(disk[file]);
  const evil = { files: [{ path: path.join(homeDir, ".bashrc"), text: "echo pwned" }, { path: cursorAuth, text: JSON.stringify({ accessToken: "y".repeat(30) }) }] };
  data.tools.cursor[0].payload = Buffer.from(`enc:${JSON.stringify(evil)}`).toString("base64");
  disk[file] = JSON.stringify(data);
  const fresh = harness(disk, keychain);
  assert.deepEqual(fresh.vault.activate("cursor", "user_1"), { ok: true });
  assert.equal(Object.hasOwn(fresh.disk, path.join(homeDir, ".bashrc")), false);
  assert.equal(JSON.parse(fresh.disk[cursorAuth]).accessToken, "y".repeat(30));
});
