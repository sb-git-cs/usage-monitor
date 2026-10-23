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

// A vault with no disk: entries live in memory and activation reports which account was put back.
function memoryVault() {
  const tools = { claude: [], codex: [], gemini: [], cursor: [] };
  const activated = [];
  return {
    tools, activated,
    TOOLS: Object.keys(tools),
    capture: (tool, identity) => {
      const rows = tools[tool];
      const existing = rows.find((row) => row.id === identity.id);
      if (existing) { existing.label = identity.label; return false; }
      rows.unshift({ id: identity.id, label: identity.label, detail: identity.detail || null });
      return true;
    },
    list: (tool) => tools[tool].map((row) => ({ ...row })),
    has: (tool, id) => !!tools[tool] && tools[tool].some((row) => row.id === id),
    forget: (tool, id) => { const i = tools[tool].findIndex((row) => row.id === id); if (i < 0) return false; tools[tool].splice(i, 1); return true; },
    activate: (tool, id) => { activated.push([tool, id]); return { ok: true }; },
  };
}

function harness(files, cred, extra = {}) {
  const opened = [];
  const vault = extra.vault || memoryVault();
  const accounts = load("src/accounts.js", {
    "./account-vault": vault,
    "./adapters/gemini": extra.gemini || { knownIdentity: () => null },
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
    "./github-auth": extra.github || { token: async () => "", forget() {}, users: () => ({ active: null, logins: [] }), switchUser: async () => false },
    electron: { shell: { openExternal: async (url) => { opened.push(url); } } },
  });
  return { accounts, opened, vault };
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
  assert.deepEqual(await accounts.select("grok", "new-user"), { ok: true });
  assert.equal(accounts.list().find((row) => row.id === "grok").account, "new@example.com");
  assert.equal((await accounts.select("claude", "other@example.com")).ok, false);
  const decorated = accounts.decorate({ id: "grok", display_name: "Grok Build", windows: [] });
  assert.equal(decorated.account, "new@example.com");
  assert.equal(decorated.accounts.length, 2);
  // The current Claude sign-in is saved on refresh and offered as its one choice.
  const claude = accounts.decorate({ id: "claude", windows: [] });
  assert.deepEqual(claude.accounts, [{ id: "claude@example.com", label: "claude@example.com", active: true }]);
  assert.equal(accounts.decorate({ id: "cursor", windows: [] }).accounts, undefined, "a tool that is not signed in offers nothing");
});

test("saved sign-ins are kept across logins, switch the tool's files back and can be forgotten", async () => {
  const files = {
    [claudeJson]: JSON.stringify({ oauthAccount: { emailAddress: "alice@example.com" } }),
    [codexAuth]: JSON.stringify({ tokens: { access_token: "codex-secret", id_token: jwt({ email: "codex@example.com" }) } }),
  };
  const { accounts, vault } = harness(files, null);
  await accounts.refresh({});
  assert.deepEqual(vault.tools.claude.map((row) => row.id), ["alice@example.com"]);
  assert.deepEqual(vault.tools.codex.map((row) => row.id), ["codex@example.com"]);
  // Bob signs in through the CLI; Alice's copy stays and both are offered, Bob marked current.
  files[claudeJson] = JSON.stringify({ oauthAccount: { emailAddress: "bob@example.com", displayName: "Bob" } });
  await accounts.refresh({});
  const claude = accounts.list().find((row) => row.id === "claude");
  assert.deepEqual(claude.choices.map((c) => [c.id, c.active]), [["bob@example.com", true], ["alice@example.com", false]]);
  assert.equal(claude.removable, true);
  assert.equal(accounts.hasChoice("claude", "alice@example.com"), true);
  assert.equal(accounts.hasChoice("claude", "nobody@example.com"), false);
  // Switching puts Alice's files back; the tool is read again right away.
  files[claudeJson] = JSON.stringify({ oauthAccount: { emailAddress: "alice@example.com" } });
  assert.deepEqual(await accounts.select("claude", "alice@example.com"), { ok: true });
  assert.deepEqual(vault.activated, [["claude", "alice@example.com"]]);
  assert.equal(accounts.list().find((row) => row.id === "claude").account, "alice@example.com");
  assert.equal(accounts.forget("claude", "alice@example.com"), false, "the account in use stays");
  assert.equal(accounts.forget("claude", "bob@example.com"), true);
  assert.deepEqual(accounts.list().find((row) => row.id === "claude").choices.map((c) => c.id), ["alice@example.com"]);
  assert.equal(accounts.forget("grok", "anything"), false, "Grok's own list is not edited here");
  const dumped = JSON.stringify(accounts.list());
  assert.equal(dumped.includes("codex-secret"), false);
});

test("gh logins are offered as Copilot accounts and switched with gh itself", async () => {
  const switched = [];
  const github = {
    token: async () => "gho_token", forget() {},
    users: () => ({ active: "octocat", logins: ["octocat", "other-user"] }),
    switchUser: async (login) => { switched.push(login); return login === "other-user"; },
  };
  const { accounts } = harness({}, null, { github });
  await accounts.refresh({});
  const copilot = accounts.list().find((row) => row.id === "copilot");
  assert.equal(copilot.account, "octocat");
  assert.deepEqual(copilot.choices.map((c) => [c.id, c.active]), [["octocat", true], ["other-user", false]]);
  assert.equal(copilot.removable, false);
  assert.equal(accounts.hasChoice("copilot", "other-user"), true);
  assert.equal((await accounts.select("copilot", "ghost")).ok, false);
  assert.deepEqual(await accounts.select("copilot", "other-user"), { ok: true });
  assert.deepEqual(switched, ["other-user"]);
});

test("gh hosts.yml lists every saved login and the active one", () => {
  const hosts = path.join(homeDir, "hosts.yml");
  const text = [
    "github.com:", "    users:", "        octocat:", "            oauth_token: gho_a", "        other-user:",
    "            oauth_token: gho_b", "    git_protocol: https", "    oauth_token: gho_a", "    user: octocat", "",
  ].join("\n");
  const github = load("src/github-auth.js", {
    fs: { readFileSync: (file) => { if (file !== hosts) throw new Error("missing"); return text; } },
    "./paths": { ghHosts: () => [hosts], cliPath: () => null, cliOnPath: () => false },
  });
  assert.deepEqual(github.users(), { active: "octocat", logins: ["octocat", "other-user"] });
  const single = load("src/github-auth.js", {
    fs: { readFileSync: () => "github.com:\n    oauth_token: gho_a\n    user: solo\n" },
    "./paths": { ghHosts: () => [hosts], cliPath: () => null, cliOnPath: () => false },
  });
  assert.deepEqual(single.users(), { active: "solo", logins: ["solo"] });
  const none = load("src/github-auth.js", {
    fs: { readFileSync: () => { throw new Error("missing"); } },
    "./paths": { ghHosts: () => [hosts], cliPath: () => null, cliOnPath: () => false },
  });
  assert.deepEqual(none.users(), { active: null, logins: [] });
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

test("a Gemini sign-in without an ID token is named by what the usage reader learned about its token", async () => {
  const files = { [geminiToken]: JSON.stringify({ token: { access_token: "antigravity-access", refresh_token: "r" } }) };
  const unknown = harness(files, null);
  await unknown.accounts.refresh({});
  let gemini = unknown.accounts.list().find((row) => row.id === "gemini");
  assert.equal(gemini.signed_in, true);
  assert.equal(gemini.account_id, null, "no identity yet: nothing is saved under a guessed name");
  assert.deepEqual(unknown.vault.tools.gemini, []);
  const known = harness(files, null, { gemini: { knownIdentity: (token) => (token === "antigravity-access" ? { email: "g@example.com", sub: "1234" } : null) } });
  await known.accounts.refresh({});
  gemini = known.accounts.list().find((row) => row.id === "gemini");
  assert.equal(gemini.account, "g@example.com");
  assert.equal(gemini.account_id, "g@example.com");
  assert.deepEqual(known.vault.tools.gemini.map((row) => row.id), ["g@example.com"]);
  assert.equal(JSON.stringify(known.accounts.list()).includes("antigravity-access"), false);
});
