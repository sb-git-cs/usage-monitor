const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { load } = require("./helpers");

const homeDir = path.join("/home/tester");
const claudeJson = path.join(homeDir, ".claude.json");
const claudeCreds = path.join(homeDir, ".claude", ".credentials.json");
const codexAuth = path.join(homeDir, ".codex", "auth.json");
const grokAuth = path.join(homeDir, ".grok", "auth.json");
const geminiOAuth = path.join(homeDir, ".gemini", "oauth_creds.json");
const geminiToken = path.join(homeDir, ".gemini", "token");

function jwt(payload) {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

function harness(files, cred) {
  const opened = [];
  const accounts = load("src/accounts.js", {
    fs: {
      readFileSync: (file) => {
        if (!Object.hasOwn(files, file)) throw new Error("missing");
        return files[file];
      },
    },
    "./paths": {
      home: () => homeDir,
      claudeCredentials: () => claudeCreds,
      codexAuth: () => codexAuth,
      grokAuth: () => grokAuth,
      geminiOAuth: () => geminiOAuth,
      antigravityToken: () => geminiToken,
      fileExists: (file) => Object.hasOwn(files, file),
    },
    "./wincred": { readGenericCredential: async () => cred || null },
    "./github-auth": { token: async () => "", forget() {} },
    electron: { shell: { openExternal: async (url) => { opened.push(url); } } },
  });
  return { accounts, opened };
}

test("account labels come from saved sign-ins and never include tokens", async () => {
  const files = {
    [claudeJson]: JSON.stringify({ oauthAccount: { emailAddress: "claude@example.com", displayName: "Claude User" } }),
    [codexAuth]: JSON.stringify({ tokens: { access_token: "codex-secret", id_token: jwt({ email: "codex@example.com", name: "Codex User" }) } }),
    [grokAuth]: JSON.stringify({
      old: { key: "grok-old-secret", user_id: "old-user", email: "old@example.com", first_name: "Old", create_time: "2024-01-01" },
      current: { key: "grok-new-secret", user_id: "new-user", email: "new@example.com", first_name: "New", create_time: "2025-01-01" },
    }),
  };
  const { accounts } = harness(files, { id_token: jwt({ email: "gemini@example.com" }), token: { access_token: "gemini-secret" } });
  const rows = await accounts.refresh({ grok: "old-user" });
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.claude.account, "claude@example.com");
  assert.equal(byId.claude.detail, "Claude User");
  assert.equal(byId.codex.account, "codex@example.com");
  assert.equal(byId.gemini.account, "gemini@example.com");
  assert.equal(byId.grok.account, "old@example.com");
  assert.deepEqual(byId.grok.choices.map((choice) => [choice.label, choice.active]), [["new@example.com", false], ["old@example.com", true]]);
  const dumped = JSON.stringify(rows);
  for (const secret of ["codex-secret", "grok-old-secret", "grok-new-secret", "gemini-secret"]) {
    assert.equal(dumped.includes(secret), false);
  }
  assert.equal(accounts.select("grok", "new-user"), true);
  assert.equal(accounts.list().find((row) => row.id === "grok").account, "new@example.com");
  assert.equal(accounts.select("claude", "other@example.com"), false);
  const decorated = accounts.decorate({ id: "grok", display_name: "Grok Build", windows: [] });
  assert.equal(decorated.account, "new@example.com");
  assert.equal(decorated.accounts.length, 2);
  assert.equal(accounts.decorate({ id: "claude", windows: [] }).accounts, undefined);
});

test("sign-in opens the corresponding provider's browser page and rejects unknown tools", async () => {
  const { accounts, opened } = harness({}, null);
  for (const id of ["nope", "toString", "__proto__", "https://evil.example"]) {
    assert.deepEqual(await accounts.openLogin(id), { ok: false, error: "Unknown tool" });
  }
  assert.deepEqual(opened, []);
  for (const id of ["claude", "codex", "gemini", "grok", "cursor", "copilot"]) {
    assert.equal((await accounts.openLogin(id)).ok, true);
  }
  assert.deepEqual(opened, [
    "https://claude.ai/login", "https://chatgpt.com/auth/login/", "https://accounts.google.com/ServiceLogin",
    "https://accounts.x.ai/sign-in", "https://cursor.com/login", "https://github.com/login",
  ]);
});

test("sign-in waits for the browser and reports opening failures", async () => {
  const { accounts } = harness({}, null);
  let finish;
  const opening = accounts.openLogin("grok", () => new Promise((resolve) => { finish = resolve; }));
  let settled = false;
  opening.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  finish();
  assert.deepEqual(await opening, { ok: true });
  const failed = { ok: false, error: "Couldn't open the sign-in page in your browser." };
  assert.deepEqual(await accounts.openLogin("grok", async () => { throw new Error("failed"); }), failed);
  assert.deepEqual(await accounts.openLogin("grok", () => { throw new Error("failed"); }), failed);
});
