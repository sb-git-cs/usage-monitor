const fs = require("node:fs");
const path = require("node:path");
const { claudeConfigDir, codexHome } = require("./paths");

const fileCache = new Map();

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function scanClaude(claudeDir, sinceMs) {
  const root = path.join(typeof claudeDir === "function" ? claudeDir() : claudeDir, "projects");
  const items = [];
  let projDirs;
  try {
    projDirs = fs.readdirSync(root);
  } catch {
    return items;
  }

  for (const proj of projDirs) {
    const pDir = path.join(root, proj);
    let st;
    try {
      st = fs.statSync(pDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    let files;
    try {
      files = fs.readdirSync(pDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const full = path.join(pDir, file);
      let fst;
      try {
        fst = fs.statSync(full);
      } catch {
        continue;
      }
      if (fst.mtimeMs < sinceMs) continue;

      let cached = fileCache.get(full);
      if (!cached || cached.mtime !== fst.mtimeMs || cached.size !== fst.size) {
        cached = { mtime: fst.mtimeMs, size: fst.size, items: [] };
        try {
          const content = fs.readFileSync(full, "utf8");
          for (const line of content.split("\n")) {
            if (!line) continue;
            const j = safeParse(line);
            if (!j) continue;
            const u = j.usage || j.message?.usage;
            if (u) {
              const parsedTime = j.timestamp ? Date.parse(j.timestamp) : (j.created_at ? Date.parse(j.created_at) : fst.mtimeMs);
              const t = Number.isFinite(parsedTime) ? parsedTime : fst.mtimeMs;
              const model = j.message?.model || j.model || "claude-unknown";
              cached.items.push({
                t,
                provider: "claude",
                model: String(model).replace(/^claude-/, ""),
                input: Number(u.input_tokens) || 0,
                output: Number(u.output_tokens) || 0,
                cache_read: Number(u.cache_read_input_tokens) || 0,
                cache_write: Number(u.cache_creation_input_tokens) || 0,
                reasoning: Number(u.output_tokens_details?.thinking_tokens) || 0,
              });
            }
          }
        } catch {
          /* ignore unreadable file */
        }
        fileCache.set(full, cached);
      }

      for (const item of cached.items) {
        if (item.t >= sinceMs) items.push(item);
      }
    }
  }
  return items;
}

function scanCodex(codexDir, sinceMs, nowMs) {
  const root = path.join(typeof codexDir === "function" ? codexDir() : codexDir, "sessions");
  const items = [];
  const startDay = new Date(sinceMs);
  startDay.setHours(0, 0, 0, 0);

  for (const cursor = new Date(startDay); cursor.getTime() <= nowMs; cursor.setDate(cursor.getDate() + 1)) {
    const dir = path.join(
      root,
      String(cursor.getFullYear()),
      String(cursor.getMonth() + 1).padStart(2, "0"),
      String(cursor.getDate()).padStart(2, "0")
    );
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const full = path.join(dir, file);
      let fst;
      try {
        fst = fs.statSync(full);
      } catch {
        continue;
      }
      if (fst.mtimeMs < sinceMs) continue;

      let cached = fileCache.get(full);
      if (!cached || cached.mtime !== fst.mtimeMs || cached.size !== fst.size) {
        cached = { mtime: fst.mtimeMs, size: fst.size, items: [] };
        try {
          const content = fs.readFileSync(full, "utf8");
          for (const line of content.split("\n")) {
            if (!line) continue;
            const j = safeParse(line);
            if (!j) continue;
            if (j.payload?.type === "token_count" && j.payload?.info?.last_token_usage) {
              const u = j.payload.info.last_token_usage;
              const parsedTime = j.timestamp ? Date.parse(j.timestamp) : fst.mtimeMs;
              const t = Number.isFinite(parsedTime) ? parsedTime : fst.mtimeMs;
              cached.items.push({
                t,
                provider: "codex",
                model: "codex",
                input: Number(u.input_tokens) || 0,
                output: Number(u.output_tokens) || 0,
                cache_read: Number(u.cached_input_tokens) || 0,
                cache_write: 0,
                reasoning: Number(u.reasoning_output_tokens) || 0,
              });
            }
          }
        } catch {
          /* ignore unreadable file */
        }
        fileCache.set(full, cached);
      }

      for (const item of cached.items) {
        if (item.t >= sinceMs) items.push(item);
      }
    }
  }
  return items;
}

function scanTokens({ days = 7, claudeDir = claudeConfigDir, codexDir = codexHome, now = Date.now } = {}) {
  const nowMs = typeof now === "function" ? now() : now;
  const numDays = [1, 7, 14, 30].includes(Number(days)) ? Number(days) : 7;
  const sinceMs = nowMs - numDays * 86400000;

  const claudeItems = scanClaude(claudeDir, sinceMs);
  const codexItems = scanCodex(codexDir, sinceMs, nowMs);
  const allItems = [...claudeItems, ...codexItems];

  const summary = {
    total: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    reasoning: 0,
    turns: 0,
    cache_efficiency_pct: 0,
    avg_turn_tokens: 0,
  };

  const byProvider = {
    claude: { total: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, turns: 0 },
    codex: { total: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, turns: 0 },
  };

  const modelMap = new Map();
  const dailyMap = new Map();
  const hourly = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    label: `${i}:00`,
    tokens: 0,
    turns: 0,
  }));

  for (const item of allItems) {
    const itemTotal = item.input + item.output + item.cache_read + item.cache_write;
    summary.total += itemTotal;
    summary.input += item.input;
    summary.output += item.output;
    summary.cache_read += item.cache_read;
    summary.cache_write += item.cache_write;
    summary.reasoning += item.reasoning;
    summary.turns += 1;

    const p = byProvider[item.provider] ||= { total: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, turns: 0 };
    p.total += itemTotal;
    p.input += item.input;
    p.output += item.output;
    p.cache_read += item.cache_read;
    p.cache_write += item.cache_write;
    p.reasoning += item.reasoning;
    p.turns += 1;

    const m = modelMap.get(item.model) || { model: item.model, total: 0, input: 0, output: 0, cached: 0, reasoning: 0, turns: 0 };
    m.total += itemTotal;
    m.input += item.input;
    m.output += item.output;
    m.cached += item.cache_read;
    m.reasoning += item.reasoning;
    m.turns += 1;
    modelMap.set(item.model, m);

    const d = new Date(item.t);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayRecord = dailyMap.get(dateKey) || {
      date: dateKey,
      label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      total: 0,
      input: 0,
      output: 0,
      cached: 0,
      turns: 0,
    };
    dayRecord.total += itemTotal;
    dayRecord.input += item.input;
    dayRecord.output += item.output;
    dayRecord.cached += item.cache_read;
    dayRecord.turns += 1;
    dailyMap.set(dateKey, dayRecord);

    const hour = d.getHours();
    if (hourly[hour]) {
      hourly[hour].tokens += itemTotal;
      hourly[hour].turns += 1;
    }
  }

  const inputPlusCache = summary.input + summary.cache_read;
  summary.cache_efficiency_pct = inputPlusCache > 0 ? Math.round((summary.cache_read / inputPlusCache) * 1000) / 10 : 0;
  summary.avg_turn_tokens = summary.turns > 0 ? Math.round(summary.total / summary.turns) : 0;

  const byModel = [...modelMap.values()]
    .map((m) => ({
      ...m,
      pct: summary.total > 0 ? Math.round((m.total / summary.total) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total);

  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  return {
    days: numDays,
    summary,
    by_provider: byProvider,
    by_model: byModel,
    daily,
    hourly,
  };
}

module.exports = { scanTokens };
