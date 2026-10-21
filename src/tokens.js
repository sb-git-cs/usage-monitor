const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { claudeConfigDir, codexHome } = require("./paths");
const fileCache = new Map();
const MAX_FILES = 1000, MAX_BYTES = 32 * 1024 * 1024;
const count = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
const modelName = (value, fallback) => typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 160) : fallback;
const digest = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const empty = () => ({ total: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, turns: 0 });
function parse(text) { try { return JSON.parse(text); } catch { return null; } }
function usage(u, codex = false) {
  const input = count(u.input_tokens), output = count(u.output_tokens);
  const cached = codex ? Math.min(input, count(u.cached_input_tokens)) : count(u.cache_read_input_tokens);
  return { input: codex ? input - cached : input, output, cache_read: cached,
    cache_write: codex ? 0 : count(u.cache_creation_input_tokens),
    reasoning: Math.min(output, count(codex ? u.reasoning_output_tokens : u.output_tokens_details?.thinking_tokens)) };
}
function claudeRows(lines) {
  const messages = new Map();
  for (let index = 0; index < lines.length; index++) {
    const j = parse(lines[index]);
    if (!j || (j.type && j.type !== "assistant")) continue;
    const u = j.message?.usage || j.usage;
    if (!u) continue;
    const value = usage(u), key = j.message?.id || j.uuid || `row:${index}`;
    const prior = messages.get(key);
    if (prior) for (const field of Object.keys(value)) value[field] = Math.max(value[field], prior[field]);
    // The same response is repeated in a resumed session's file; the id and request identify it across files.
    messages.set(key, { t: prior?.t || Date.parse(j.timestamp || j.created_at), ...value,
      key: j.message?.id ? `${j.message.id}:${j.requestId || ""}` : null,
      model: modelName(j.message?.model || j.model, "claude-unknown").replace(/^claude-/, "") });
  }
  return [...messages.values()].filter((m) => m.input || m.output || m.cache_read || m.cache_write);
}
function codexRows(lines) {
  const items = [];
  let model = "Unknown Codex model", previous = null;
  const seen = new Set();
  for (const line of lines) {
    const j = parse(line); if (!j) continue;
    if (["turn_context", "session_meta"].includes(j.type) && j.payload?.model) model = modelName(j.payload.model, model);
    if (j.payload?.type !== "token_count" || !j.payload.info) continue;
    const info = j.payload.info, cumulative = info.total_token_usage;
    let u = info.last_token_usage;
    if (cumulative) {
      const current = Object.fromEntries(["input_tokens", "output_tokens", "cached_input_tokens", "reasoning_output_tokens"].map((k) => [k, count(cumulative[k])]));
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
    if (!value.input && !value.output && !value.cache_read) continue;
    items.push({ t: Date.parse(j.timestamp), model, ...value });
  }
  return items;
}
// Reads run asynchronously and yield after each parsed file, so a first scan of weeks of
// transcripts does not freeze the chips and flyout, which share the main process.
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
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
async function scan(provider, root, since, now, coverage) {
  const files = (await filesIn(root, since, coverage)).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (files.length > MAX_FILES) coverage.truncated = true;
  const result = [];
  for (const { file, stat } of files.slice(0, MAX_FILES)) {
    if (stat.size > MAX_BYTES) { coverage.skipped_files++; continue; }
    let cached = fileCache.get(file);
    if (!cached || cached.mtime !== stat.mtimeMs || cached.size !== stat.size) {
      try {
        const rawLines = (await fs.promises.readFile(file, "utf8")).split("\n");
        const truncated = rawLines.some((line) => line.length > 8 * 1024 * 1024);
        const lines = rawLines.filter((line) => line.length && line.length <= 8 * 1024 * 1024);
        const session = digest(`${provider}|${file}`);
        cached = { mtime: stat.mtimeMs, size: stat.size, truncated,
          items: (provider === "claude" ? claudeRows(lines) : codexRows(lines)).map((item) => ({ ...item, provider, session })) };
        fileCache.set(file, cached);
        if (fileCache.size > MAX_FILES * 2) fileCache.delete(fileCache.keys().next().value);
      } catch { coverage.skipped_files++; continue; }
      await yieldTurn();
    }
    if (cached.truncated) coverage.truncated = true;
    result.push(...cached.items.filter((item) => Number.isFinite(item.t) && item.t >= since && item.t <= now));
  }
  return result;
}
function add(target, item) {
  for (const field of ["input", "output", "cache_read", "cache_write", "reasoning"]) target[field] += item[field];
  target.total += item.input + item.output + item.cache_read + item.cache_write; target.turns++;
}
function dayKey(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
async function scanTokens({ days = 7, claudeDir = claudeConfigDir, codexDir = codexHome, now = Date.now } = {}) {
  const nowMs = typeof now === "function" ? now() : now;
  const numDays = [1, 7, 14, 30].includes(Number(days)) ? Number(days) : 7;
  // The period is whole local calendar days ending today, so every bar covers a full day.
  const today = new Date(nowMs), firstDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() - numDays + 1), since = firstDay.getTime();
  const coverage = { providers: ["claude", "codex"], skipped_files: 0, truncated: false };
  const root = (value) => typeof value === "function" ? value() : value;
  // Files are newest first, so the copy in the resumed session is the one kept.
  const seenKeys = new Set();
  const claude = (await scan("claude", path.join(root(claudeDir), "projects"), since, nowMs, coverage))
    .filter((i) => !i.key || (!seenKeys.has(i.key) && seenKeys.add(i.key)));
  const items = [...claude, ...await scan("codex", path.join(root(codexDir), "sessions"), since, nowMs, coverage)];
  const summary = empty(), byProvider = { claude: empty(), codex: empty() }, models = new Map(), sessions = new Map(), daily = new Map();
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, label: `${hour}:00`, tokens: 0, turns: 0 }));
  for (const item of items) {
    add(summary, item); add(byProvider[item.provider], item);
    const key = `${item.provider}:${item.model}`, date = dayKey(item.t);
    const m = models.get(key) || { ...empty(), id: digest(key), provider: item.provider, model: item.model, days: new Map() };
    add(m, item); const md = m.days.get(date) || { ...empty(), date }; add(md, item); m.days.set(date, md); models.set(key, m);
    const d = daily.get(date) || { ...empty(), date, label: new Date(item.t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) };
    add(d, item); daily.set(date, d);
    const session = sessions.get(item.session) || { ...empty(), id: item.session, provider: item.provider, first: item.t, last: item.t, models: new Set() };
    add(session, item); session.first = Math.min(session.first, item.t); session.last = Math.max(session.last, item.t); session.models.add(item.model); sessions.set(item.session, session);
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
  return { days: numDays, summary, coverage, by_provider: byProvider,
    by_model: [...models.values()].map(({ days, ...m }) => ({ ...m, cached: m.cache_read, pct: summary.total ? Math.round(m.total / summary.total * 100) : 0,
      daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) })).sort((a, b) => b.total - a.total),
    by_session: [...sessions.values()].map((s) => ({ ...s, models: [...s.models] })).sort((a, b) => b.last - a.last),
    daily: [...daily.values()].map((d) => ({ ...d, cached: d.cache_read })).sort((a, b) => a.date.localeCompare(b.date)), hourly };
}
function modelExport(tokens, format, selected = "all") {
  const models = (tokens?.by_model || []).filter((m) => !selected || selected === "all" || m.id === selected);
  if (format === "models-json") return JSON.stringify({ unit: "observed_tokens", days: tokens?.days, coverage: tokens?.coverage, by_model: models }, null, 2);
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/^[=+@-]/, "'$&")}"`;
  const fields = (m) => [m.turns, m.total, m.input, m.cache_read, m.cache_write, m.output, m.reasoning];
  const daily = format === "models-daily-csv";
  const rows = daily ? models.flatMap((m) => m.daily.map((d) => [m.provider, m.model, d.date, ...fields(d)]))
    : models.map((m) => [m.provider, m.model, ...fields(m)]);
  return [["provider", "model", ...(daily ? ["date"] : []), "observations", "total_tokens", "input_uncached", "cache_read", "cache_write", "output", "reasoning_subset"].join(","),
    ...rows.map((row) => row.map(cell).join(","))].join("\n");
}
module.exports = { scanTokens, modelExport };
