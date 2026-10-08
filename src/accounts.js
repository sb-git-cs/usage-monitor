// Which account each plan meter is reading, and how to sign in as a different one.
// Tokens never leave this module. Callers get an email or a name, and sign-in instructions.
const fs = require("fs");
const path = require("path");
const {
  home,
  claudeCredentials,
  codexAuth,
  grokAuth,
  geminiOAuth,
  antigravityToken,
  cursorAuth,
  cursorStateDb,
  fileExists,
} = require("./paths");
const { readGenericCredential } = require("./wincred");
const { readValue } = require("./cursor-local");
const githubAuth = require("./github-auth");

const TOOLS = {
  claude: { label: "Claude Code", url: "https://claude.ai/login", file: "claude", args: ["auth", "login"] },
  codex: { label: "Codex", url: "https://chatgpt.com/auth/login/", file: "codex", args: ["login"] },
  gemini: { label: "Gemini", url: "https://accounts.google.com/ServiceLogin", file: "agy", args: [] },
  grok: { label: "Grok Build", url: "https://accounts.x.ai/sign-in", file: "grok", args: ["login"] },
  cursor: { label: "Cursor", url: "https://cursor.com/login", file: "cursor-agent", args: ["login"] },
  copilot: { label: "Copilot", url: "https://github.com/login", file: "gh", args: ["auth", "login"] },
};

const ACCOUNT_ID = /^[A-Za-z0-9_.:@-]{1,200}$/;

function blank(id) {
  return { id, label: TOOLS[id].label, login_command: [TOOLS[id].file, ...TOOLS[id].args].join(" "), signed_in: false, account: null, account_id: null, detail: null, choices: [] };
}

function clean(value) {
  const text = String(value || "").replace(/[\u0000-\u001f]/g, "").trim();
  return text.length > 80 ? text.slice(0, 80) : text;
}

function emailOf(claims) {
  const email = clean(claims && claims.email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function jwtClaims(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readClaude() {
  const base = blank("claude");
  const json = readJson(path.join(home(), ".claude.json"));
  const acct = json && json.oauthAccount && typeof json.oauthAccount === "object" ? json.oauthAccount : null;
  const email = acct ? emailOf({ email: acct.emailAddress }) : "";
  const name = acct ? clean(acct.displayName || acct.fullName) : "";
  if (!email && !name && !fileExists(claudeCredentials())) return base;
  return {
    ...base,
    signed_in: true,
    account: email || name || null,
    account_id: email || null,
    detail: name && email && name !== email ? name : null,
  };
}

function readCodex() {
  const base = blank("codex");
  const auth = readJson(codexAuth());
  if (!auth || typeof auth !== "object") return base;
  const tokens = auth.tokens && typeof auth.tokens === "object" ? auth.tokens : {};
  const claims = jwtClaims(tokens.id_token);
  const email = emailOf(claims);
  const name = clean(claims && (claims.name || claims.preferred_username));
  if (tokens.access_token || email) {
    return {
      ...base,
      signed_in: true,
      account: email || name || "ChatGPT account",
      account_id: email || null,
      detail: name && email && name !== email ? name : null,
    };
  }
  if (auth.api_key || auth.OPENAI_API_KEY) {
    return { ...base, signed_in: true, account: "API key", detail: "Subscription meters need a ChatGPT sign-in" };
  }
  return base;
}

function readGrok(preferred) {
  const base = blank("grok");
  const json = readJson(grokAuth());
  if (!json || typeof json !== "object") return base;
  const found = [];
  for (const entry of Object.values(json)) {
    if (!entry || typeof entry !== "object" || !entry.key) continue;
    const email = emailOf({ email: entry.email });
    const name = clean(entry.first_name);
    const id = clean(entry.user_id) || email;
    if (!ACCOUNT_ID.test(id)) continue;
    found.push({ id, label: email || name || "Signed in", name, create_time: String(entry.create_time || "") });
  }
  found.sort((a, b) => b.create_time.localeCompare(a.create_time));
  const choices = [];
  const seen = new Set();
  for (const entry of found) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    choices.push(entry);
  }
  if (!choices.length) return base;
  const want = typeof preferred === "string" ? preferred : "";
  const active = choices.find((entry) => entry.id === want) || choices[0];
  return {
    ...base,
    signed_in: true,
    account: active.label,
    account_id: active.id,
    detail: active.name && active.label !== active.name ? active.name : null,
    choices: choices.map((entry) => ({ id: entry.id, label: entry.label, active: entry.id === active.id })),
  };
}

function geminiIdentity(json) {
  if (!json || typeof json !== "object") return null;
  const email = emailOf(jwtClaims(json.id_token)) || emailOf(jwtClaims(json.token && json.token.id_token));
  const token = json.token && typeof json.token === "object" ? json.token : json;
  const access = token && (token.access_token || token.accessToken || token.refresh_token || token.refreshToken);
  if (!email && !access) return null;
  return { ...blank("gemini"), signed_in: true, account: email || null, account_id: email || null };
}

function readCursor() {
  const base = blank("cursor");
  let token = false;
  let email = "";
  try {
    const auth = readJson(cursorAuth());
    token = !!(auth && typeof auth.accessToken === "string" && auth.accessToken.length > 20);
  } catch {
    token = false;
  }
  try {
    email = emailOf({ email: readValue(cursorStateDb(), "cursorAuth/cachedEmail") });
  } catch {
    email = "";
  }
  if (!token && !email) return base;
  return { ...base, signed_in: true, account: email || null, account_id: email || null };
}

async function readCopilot() {
  const base = blank("copilot");
  let found = "";
  try { found = await githubAuth.token(); } catch { found = ""; }
  if (!found) return base;
  const prev = cached.copilot;
  return {
    ...base,
    signed_in: true,
    account: prev && prev.account ? prev.account : null,
    account_id: prev && prev.account_id ? prev.account_id : null,
  };
}

async function readGemini() {
  for (const file of [antigravityToken(), geminiOAuth()]) {
    const found = geminiIdentity(readJson(file));
    if (found) return found;
  }
  try {
    const found = geminiIdentity(await readGenericCredential("gemini:antigravity"));
    if (found) return found;
  } catch {
    /* Credential Manager can be unavailable; the meter still works. */
  }
  return blank("gemini");
}

let cached = Object.fromEntries(Object.keys(TOOLS).map((id) => [id, blank(id)]));

function list() {
  return Object.keys(TOOLS).map((id) => ({ ...cached[id], choices: cached[id].choices.map((choice) => ({ ...choice })) }));
}

function hasChoice(provider, accountId) {
  if (provider !== "grok" || !ACCOUNT_ID.test(accountId || "")) return false;
  return readGrok(accountId).choices.some((choice) => choice.id === accountId);
}

// Remembers the saved sign-in the meters should read. The CLI file is left as it is.
function select(provider, accountId) {
  if (!hasChoice(provider, accountId)) return false;
  cached.grok = readGrok(accountId);
  return true;
}

async function refresh(preferred) {
  const next = {
    claude: readClaude(),
    codex: readCodex(),
    gemini: blank("gemini"),
    grok: readGrok(preferred && preferred.grok),
    cursor: readCursor(),
    copilot: blank("copilot"),
  };
  try {
    next.gemini = await readGemini();
  } catch {
    next.gemini = blank("gemini");
  }
  try {
    next.copilot = await readCopilot();
  } catch {
    next.copilot = blank("copilot");
  }
  if (next.copilot.signed_in && !next.copilot.account && cached.copilot && cached.copilot.account) {
    next.copilot.account = cached.copilot.account;
    next.copilot.account_id = cached.copilot.account_id;
  }
  cached = next;
  return list();
}

function observe(id, account, accountId) {
  if (!TOOLS[id]) return;
  const label = clean(account);
  if (!label) return;
  const current = cached[id] || blank(id);
  const chosen = ACCOUNT_ID.test(String(accountId || "")) ? String(accountId) : current.account_id;
  cached[id] = { ...current, signed_in: true, account: label, account_id: chosen || null, choices: current.choices || [] };
}

function decorate(provider) {
  if (!provider || !TOOLS[provider.id]) return provider;
  const row = cached[provider.id];
  const next = { ...provider };
  if (row.signed_in && row.account) next.account = row.account;
  else delete next.account;
  if (row.choices.length > 1) next.accounts = row.choices.map(({ id, label, active }) => ({ id, label, active }));
  else delete next.accounts;
  return next;
}

// Only fixed provider sign-in URLs can be opened; browser cookies do not replace CLI logins.
async function openLogin(id, openExternal = (url) => require("electron").shell.openExternal(url)) {
  if (!Object.hasOwn(TOOLS, id)) return { ok: false, error: "Unknown tool" };
  const spec = TOOLS[id];
  try {
    await openExternal(spec.url);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't open the sign-in page in your browser." };
  }
}

module.exports = { list, refresh, decorate, select, hasChoice, observe, openLogin, TOOLS };
