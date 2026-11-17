const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { claudeConfigDir, codexHome } = require("./paths");
const { costOf, PRICES_CHECKED } = require("./pricing");
const fileCache = new Map();
const MAX_CACHED_ROWS = 20_000;
let cachedRows = 0;
const MAX_FILES = 1000, MAX_BYTES = 32 * 1024 * 1024;
const count = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
const modelName = (value, fallback) => typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 160) : fallback;
const digest = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const empty = () => ({ total: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, turns: 0, cost: 0, unpriced: 0 });
function parse(text) { try { return JSON.parse(text); } catch { return null; } }
// Token fields of one response. cache_write_1h is the part of cache_write kept for an hour (Claude).
// Codex counts cached and newly cached tokens within input_tokens; they are split out here.
function usage(u, codex = false) {
  const input = count(u.input_tokens), output = count(u.output_tokens);
  const cached = codex ? Math.min(input, count(u.cached_input_tokens)) : count(u.cache_read_input_tokens);
  const written = codex ? Math.min(input - cached, count(u.cache_write_input_tokens)) : count(u.cache_creation_input_tokens);
  return { input: codex ? input - cached - written : input, output, cache_read: cached, cache_write: written,
    cache_write_1h: codex ? 0 : Math.min(written, count(u.cache_creation?.ephemeral_1h_input_tokens)),
    reasoning: Math.min(output, count(codex ? u.reasoning_output_tokens : u.output_tokens_details?.thinking_tokens)) };
}
const text = (value, max = 200) => typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : null;
// meta collects what names the session: its folder and the title the tool gave it. Never message content.
async function claudeRows(lines, meta = {}) {
  const messages = new Map();
  let index = 0;
  for await (const line of lines) {
    index++;
    const j = parse(line);
    if (!j) continue;
    if (!meta.cwd && text(j.cwd, 1024)) meta.cwd = text(j.cwd, 1024);
    if (j.type === "ai-title" && text(j.aiTitle)) meta.title = text(j.aiTitle);
    if (j.type && j.type !== "assistant") continue;
    const u = j.message?.usage || j.usage;
    if (!u) continue;
    const value = usage(u), key = j.message?.id || j.uuid || `row:${index}`;
    const prior = messages.get(key);
    if (prior) for (const field of Object.keys(value)) value[field] = Math.max(value[field], prior[field]);
    // The same response is repeated in a resumed session's file; the id and request identify it across files.
    messages.set(key, { t: prior?.t || Date.parse(j.timestamp || j.created_at), ...value,
      key: j.message?.id ? `${j.message.id}:${j.requestId || ""}` : null,
      model: modelName(j.message?.model || j.model, "claude-unknown").replace(/^claude-/, ""),
      // Priced differently: fast mode and US-only inference.
      ...(u.speed === "fast" ? { speed: "fast" } : {}), ...(u.inference_geo === "us" ? { geo: "us" } : {}) });
  }
  return [...messages.values()].filter((m) => m.input || m.output || m.cache_read || m.cache_write);
}
async function codexRows(lines, meta = {}) {
  const items = [];
  let model = "Unknown Codex model", previous = null;
  const seen = new Set();
  for await (const line of lines) {
    const j = parse(line); if (!j) continue;
    if (["turn_context", "session_meta"].includes(j.type) && j.payload?.model) model = modelName(j.payload.model, model);
    if (j.type === "session_meta" && j.payload) {
      if (text(j.payload.id)) meta.id = text(j.payload.id);
      if (text(j.payload.cwd, 1024)) meta.cwd = text(j.payload.cwd, 1024);
    } else if (j.type === "turn_context" && !meta.cwd && text(j.payload?.cwd, 1024)) meta.cwd = text(j.payload.cwd, 1024);
    if (j.payload?.type !== "token_count" || !j.payload.info) continue;
    const info = j.payload.info, cumulative = info.total_token_usage;
    let u = info.last_token_usage;
    if (cumulative) {
      const current = Object.fromEntries(["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens"].map((k) => [k, count(cumulative[k])]));
      if (previous && Object.keys(current).every((k) => current[k] === previous[k])) continue;
      if (previous && current.input_tokens >= previous.input_tokens && current.output_tokens >= previous.output_tokens)
        u = Object.fromEntries(Object.keys(current).map((k) => [k, Math.max(0, current[k] - previous[k])]));
      // An initial cumulative snapshot may include an earlier, resumed conversation.
      previous = current;
    } else {
      const key = `${j.timestamp}|${JSON.stringify(u)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (!u) continue;
    const value = usage(u, true);
    if (!value.input && !value.output && !value.cache_read && !value.cache_write) continue;
    items.push({ t: Date.parse(j.timestamp), model, ...value });
  }
  return items;
}
// Reads run asynchronously and yield after each parsed file, so a first scan of weeks of
// transcripts does not freeze the chips and flyout, which share the main process.
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
async function* transcriptLines(file, state) {
  const input = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 8 * 1024 * 1024) state.truncated = true;
      else if (line.length) yield line;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function cacheFile(file, value) {
  if (fileCache.has(file)) {
    cachedRows -= fileCache.get(file).items.length;
    fileCache.delete(file);
  }
  // Large reports still include every row, but do not retain them between scans.
  if (value.items.length > MAX_CACHED_ROWS) return;
  while (fileCache.size && (cachedRows + value.items.length > MAX_CACHED_ROWS || fileCache.size >= MAX_FILES * 2)) {
    const oldest = fileCache.keys().next().value;
    cachedRows -= fileCache.get(oldest).items.length;
    fileCache.delete(oldest);
  }
  fileCache.set(file, value);
  cachedRows += value.items.length;
}
async function filesIn(root, since, coverage, depth = 0, files = []) {
  let entries; try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    if (files.length >= MAX_FILES * 5) { coverage.truncated = true; break; }
    const file = path.join(root, entry.name);
    if (entry.isDirectory() && depth < 3) await filesIn(file, since, coverage, depth + 1, files);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try { const stat = await fs.promises.stat(file); if (stat.mtimeMs >= since) files.push({ file, stat }); } catch { coverage.skipped_files++; }
    }
  }
  return files;
}
// A Claude sub-agent's transcript (<project>/<session>/subagents/agent-*.jsonl) belongs to the
// session that started it, whose own transcript is <project>/<session>.jsonl.
function sessionFile(provider, file) {
  if (provider !== "claude" || path.basename(path.dirname(file)) !== "subagents") return { file, agent: false };
  const dir = path.dirname(path.dirname(file));
  return { file: path.join(path.dirname(dir), `${path.basename(dir)}.jsonl`), agent: true };
}
// metas: session id -> { cwd, title, codexId, agents }, from the transcripts read.
async function scan(provider, root, since, now, coverage, metas) {
  const files = (await filesIn(root, since, coverage)).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (files.length > MAX_FILES) coverage.truncated = true;
  const result = [];
  for (const { file, stat } of files.slice(0, MAX_FILES)) {
    if (stat.size > MAX_BYTES) { coverage.skipped_files++; continue; }
    let cached = fileCache.get(file);
    if (!cached || cached.mtime !== stat.mtimeMs || cached.size !== stat.size) {
      try {
        const state = { truncated: false }, meta = {};
        const lines = transcriptLines(file, state);
        const owner = sessionFile(provider, file);
        const session = digest(`${provider}|${owner.file}`);
        const items = await (provider === "claude" ? claudeRows(lines, meta) : codexRows(lines, meta));
        cached = { mtime: stat.mtimeMs, size: stat.size, truncated: state.truncated, session, agent: owner.agent, meta,
          items: items.map((item) => ({ ...item, provider, session })) };
        cacheFile(file, cached);
      } catch { coverage.skipped_files++; continue; }
      await yieldTurn();
    }
    if (cached.truncated) coverage.truncated = true;
    let used = false;
    for (const item of cached.items) if (Number.isFinite(item.t) && item.t >= since && item.t <= now) { result.push(item); used = true; }
    if (!used || !cached.session) continue;
    // The session's own transcript names it; a sub-agent's only fills in a missing folder.
    const m = metas.get(cached.session) || { cwd: null, title: null, codexId: null, agents: 0 };
    if (cached.agent) { m.agents++; m.cwd ||= cached.meta.cwd || null; } else {
      m.cwd = cached.meta.cwd || m.cwd; m.title = cached.meta.title || m.title; m.codexId = cached.meta.id || m.codexId;
    }
    metas.set(cached.session, m);
  }
  return result;
}
const TOKEN_FIELDS = ["input", "output", "cache_read", "cache_write", "reasoning"];
// cost: USD at list prices of the responses that have one; unpriced: tokens of those that do not.
function add(target, item) {
  for (const field of TOKEN_FIELDS) target[field] += item[field];
  const tokens = item.input + item.output + item.cache_read + item.cache_write;
  target.total += tokens; target.turns++;
  if (item.cost == null) target.unpriced += tokens; else target.cost += item.cost;
}
// Codex's thread names, the titles its own session list shows.
async function codexTitles(codexDir) {
  const titles = new Map();
  let raw = "";
  try { raw = await fs.promises.readFile(path.join(codexDir, "session_index.jsonl"), "utf8"); } catch { return titles; }
  for (const line of raw.split("\n")) {
    const e = parse(line);
    if (e && typeof e.id === "string" && text(e.thread_name)) titles.set(e.id, text(e.thread_name));
  }
  return titles;
}
const round = (usd) => Math.round(usd * 1e6) / 1e6;
// The last part of the folder; a drive or file-system root keeps its own name (D:, /).
function folderName(cwd) {
  if (!cwd) return null;
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return path.win32.basename(path.posix.basename(trimmed)) || trimmed || cwd;
}
const finish = (x) => ({ ...x, cost: round(x.cost), priced: x.unpriced === 0 });
function dayKey(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
async function scanTokens({ days = 7, claudeDir = claudeConfigDir, codexDir = codexHome, now = Date.now } = {}) {
  const nowMs = typeof now === "function" ? now() : now;
  const numDays = [1, 7, 14, 30].includes(Number(days)) ? Number(days) : 7;
  // The period is whole local calendar days ending today, so every bar covers a full day.
  const today = new Date(nowMs), firstDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() - numDays + 1), since = firstDay.getTime();
  const coverage = { providers: ["claude", "codex"], skipped_files: 0, truncated: false };
  const root = (value) => typeof value === "function" ? value() : value;
  // Files are newest first, so the copy in the resumed session is the one kept.
  const seenKeys = new Set(), metas = new Map();
  const claude = (await scan("claude", path.join(root(claudeDir), "projects"), since, nowMs, coverage, metas))
    .filter((i) => !i.key || (!seenKeys.has(i.key) && seenKeys.add(i.key)));
  const items = [...claude, ...await scan("codex", path.join(root(codexDir), "sessions"), since, nowMs, coverage, metas)];
  const titles = await codexTitles(root(codexDir));
  const summary = empty(), byProvider = { claude: empty(), codex: empty() }, models = new Map(), sessions = new Map(), daily = new Map();
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, label: `${hour}:00`, tokens: 0, turns: 0 }));
  for (const raw of items) {
    const item = { ...raw, cost: costOf(raw.provider, raw.model, raw) };
    add(summary, item); add(byProvider[item.provider], item);
    const key = `${item.provider}:${item.model}`, date = dayKey(item.t);
    const m = models.get(key) || { ...empty(), id: digest(key), provider: item.provider, model: item.model, days: new Map(), sessions: new Set() };
    add(m, item); m.sessions.add(item.session);
    const md = m.days.get(date) || { ...empty(), date }; add(md, item); m.days.set(date, md); models.set(key, m);
    const d = daily.get(date) || { ...empty(), date, label: new Date(item.t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) };
    add(d, item); daily.set(date, d);
    const session = sessions.get(item.session) || { ...empty(), id: item.session, provider: item.provider, first: item.t, last: item.t, models: new Map() };
    add(session, item); session.first = Math.min(session.first, item.t); session.last = Math.max(session.last, item.t);
    const sm = session.models.get(key) || { ...empty(), id: digest(key), model: item.model };
    add(sm, item); session.models.set(key, sm); sessions.set(item.session, session);
    hourly[new Date(item.t).getHours()].tokens += item.input + item.output + item.cache_read + item.cache_write;
    hourly[new Date(item.t).getHours()].turns++;
  }
  const prompt = summary.input + summary.cache_read + summary.cache_write;
  summary.cache_efficiency_pct = prompt > 0 ? Math.round(summary.cache_read / prompt * 1000) / 10 : 0;
  for (let day = new Date(firstDay); day <= today; day.setDate(day.getDate() + 1)) {
    const date = dayKey(day.getTime());
    if (!daily.has(date)) daily.set(date, { ...empty(), date, label: day.toLocaleDateString(undefined, { month: "short", day: "numeric" }) });
  }
  summary.avg_turn_tokens = summary.turns ? Math.round(summary.total / summary.turns) : 0;
  summary.sessions = sessions.size;
  const pricing = { basis: "API list prices", checked: PRICES_CHECKED, unpriced_tokens: summary.unpriced,
    priced_pct: summary.total ? Math.round((summary.total - summary.unpriced) / summary.total * 1000) / 10 : 100 };
  return { days: numDays, summary: finish(summary), coverage, pricing,
    by_provider: { claude: finish(byProvider.claude), codex: finish(byProvider.codex) },
    // Cumulative per model: every session that used it, and what an average session spent on it.
    by_model: [...models.values()].map(({ days, sessions: used, ...m }) => ({ ...finish(m), cached: m.cache_read,
      pct: summary.total ? Math.round(m.total / summary.total * 100) : 0, sessions: used.size,
      avg_session_tokens: Math.round(m.total / used.size), avg_session_cost: round(m.cost / used.size),
      daily: [...days.values()].map(finish).sort((a, b) => a.date.localeCompare(b.date)) })).sort((a, b) => b.total - a.total),
    // Each session with its folder and title (as the tool named it) and what each model used in it.
    by_session: [...sessions.values()].map((s) => {
      const meta = metas.get(s.id) || {};
      return { ...finish(s), folder: folderName(meta.cwd), cwd: meta.cwd || null,
        title: meta.title || (meta.codexId && titles.get(meta.codexId)) || null, agents: meta.agents || 0,
        models: [...s.models.values()].map(finish).sort((a, b) => b.total - a.total) };
    }).sort((a, b) => b.last - a.last),
    daily: [...daily.values()].map((d) => ({ ...finish(d), cached: d.cache_read })).sort((a, b) => a.date.localeCompare(b.date)), hourly };
}
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/^[=+@-]/, "'$&")}"`;
// Blank when nothing in the row has a list price.
const usd = (x) => (Number.isFinite(x.cost) && (x.priced || x.cost > 0) ? x.cost.toFixed(4) : "");
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : "");
// Exports. A selected model limits every format to that model, and sessions to their use of it.
function modelExport(tokens, format, selected = "all") {
  const all = !selected || selected === "all";
  const models = (tokens?.by_model || []).filter((m) => all || m.id === selected);
  const sessions = (tokens?.by_session || []).map((s) => ({ ...s, models: (s.models || []).filter((m) => all || m.id === selected) }))
    .filter((s) => s.models.length);
  const name = (s) => ({ provider: s.provider, session: s.id, folder: s.folder, title: s.title, first: iso(s.first), last: iso(s.last) });
  if (format === "models-json") {
    return JSON.stringify({ unit: "observed_tokens", cost_unit: "USD at API list prices; subscription plans are not billed per token", days: tokens?.days,
      coverage: tokens?.coverage, pricing: tokens?.pricing, by_model: models,
      by_session: sessions.map((s) => ({ ...name(s), agents: s.agents, total: s.total, cost: s.cost, priced: s.priced, models: s.models })) }, null, 2);
  }
  const fields = (m) => [m.turns, m.total, m.input, m.cache_read, m.cache_write, m.output, m.reasoning, usd(m)];
  const head = ["observations", "total_tokens", "input_uncached", "cache_read", "cache_write", "output", "reasoning_subset", "api_cost_usd"];
  let header, rows;
  if (format === "sessions-csv") {
    header = ["provider", "session", "folder", "title", "first_seen", "last_seen", "model", ...head];
    rows = sessions.flatMap((s) => s.models.map((m) => { const n = name(s); return [n.provider, n.session, n.folder, n.title, n.first, n.last, m.model, ...fields(m)]; }));
  } else if (format === "models-daily-csv") {
    header = ["provider", "model", "date", ...head];
    rows = models.flatMap((m) => m.daily.map((d) => [m.provider, m.model, d.date, ...fields(d)]));
  } else {
    header = ["provider", "model", "sessions", ...head];
    rows = models.map((m) => [m.provider, m.model, m.sessions, ...fields(m)]);
  }
  return [header.join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\n");
}
module.exports = { scanTokens, modelExport };
