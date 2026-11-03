const { effortLevels } = require("./tools");

const CONTEXT_CAP = 20000;
const RECENT_ROWS = 5;

function modelName(model) {
  return model || "default";
}

function turnBlock(turn) {
  return `[User]\n${turn.prompt}\n\n[${turn.toolLabel} · ${modelName(turn.model)}]\n${turn.reply}`;
}

// saved: { turns, sessions } from toJSON, to carry on a conversation after the window closed.
function createConversation(saved = null) {
  const turns = saved && Array.isArray(saved.turns) ? saved.turns.filter((t) => t && typeof t.prompt === "string" && typeof t.toolId === "string") : [];
  const sessions = {};
  for (const [toolId, s] of Object.entries((saved && saved.sessions) || {})) {
    if (s && typeof s.id === "string" && Number.isInteger(s.seen)) sessions[toolId] = { id: s.id, seen: Math.min(s.seen, turns.length) };
  }

  function sessionFor(toolId) {
    return sessions[toolId] ? sessions[toolId].id : null;
  }

  // Only turns answered by other tools are missed; this tool's own session already holds its turns.
  function promptFor(toolId, prompt) {
    const missed = turns.slice(sessions[toolId] ? sessions[toolId].seen : 0);
    if (!missed.length) return prompt;
    const head = "Earlier in this conversation, other assistants answered these turns in this same folder. Use them as context.\n\n";
    const tail = `\n\nNow the user asks:\n${prompt}`;
    const blocks = [];
    let size = 0;
    for (let i = missed.length - 1; i >= 0; i--) {
      const block = turnBlock(missed[i]);
      const cost = block.length + (blocks.length ? 2 : 0);
      if (size + cost > CONTEXT_CAP) {
        if (!blocks.length) {
          const t = missed[i];
          const lead = `[User]\n${t.prompt}\n\n[${t.toolLabel} · ${modelName(t.model)}]\n…`;
          const room = Math.max(0, CONTEXT_CAP - lead.length);
          blocks.unshift(lead + (room ? t.reply.slice(-room) : ""));
        }
        break;
      }
      blocks.unshift(block);
      size += cost;
    }
    return head + blocks.join("\n\n") + tail;
  }

  // effort is the one chosen, used what the tool recorded ({ model, effort }), for /history.
  function record({ toolId, toolLabel, model = null, prompt, reply, sessionId, effort = null, used = null, elapsedMs = 0, usage = null, costUsd = null }) {
    turns.push({ toolId, toolLabel, model, prompt, reply: reply || "(no reply)", effort, used, elapsedMs, usage, costUsd });
    const id = sessionId || sessionFor(toolId);
    if (id) sessions[toolId] = { id, seen: turns.length };
  }

  // How many turns a tool would be given if it answered next.
  function missedBy(toolId) {
    return turns.length - (sessions[toolId] ? sessions[toolId].seen : 0);
  }

  function totals() {
    const sum = { turns: turns.length, input: 0, output: 0, costUsd: 0 };
    for (const t of turns) {
      if (t.usage) {
        sum.input += t.usage.input || 0;
        sum.output += t.usage.output || 0;
      }
      if (typeof t.costUsd === "number") sum.costUsd += t.costUsd;
    }
    return sum;
  }

  const toJSON = () => ({ turns, sessions });

  return { turns, sessions, promptFor, record, sessionFor, missedBy, totals, toJSON };
}

// Rows for the model menu: the models used last ("recent" group), then per tool a default row,
// its models, recent typed ids and "Other". text and search feed the numbered list and the
// filter; label, id, description and note feed the grouped menu; efforts are the levels the
// row's model takes (null: no effort choice). resolved maps "tool:model" to the full model the
// tool last reported running, so an alias such as opus shows what it became.
function menuRows(tools, recent = {}, { used = [], resolved = {} } = {}) {
  const rows = [];
  const byId = Object.fromEntries(tools.map((t) => [t.id, t]));
  const ran = (tool, model) => {
    const full = resolved[`${tool.id}:${model || ""}`];
    return full && full !== model ? `→ ${full}` : "";
  };
  for (const u of used.slice(0, RECENT_ROWS)) {
    const tool = byId[u.toolId];
    if (!tool) continue;
    const name = `${tool.label} · ${u.model || "default"}`;
    rows.push({ group: "recent", kind: "model", toolId: tool.id, toolLabel: tool.label, color: tool.color, model: u.model || null, text: name, search: `${name} recent`, label: name, id: "", description: ran(tool, u.model), efforts: effortLevels(tool, u.model || null) });
  }
  for (const tool of tools) {
    const add = (row) => rows.push({ group: tool.id, toolId: tool.id, toolLabel: tool.label, color: tool.color, ...row });
    add({ kind: "model", model: null, text: `${tool.label} · default`, search: `${tool.label} default`, label: "default", id: "", note: "tool's own default", description: ran(tool, null), efforts: effortLevels(tool, null) });
    const seen = new Set();
    for (const m of tool.models || []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const label = m.label || m.id;
      add({ kind: "model", model: m.id, text: `${tool.label} · ${label}`, search: `${tool.label} ${m.label || ""} ${m.id}`, label, id: label === m.id ? "" : m.id, description: m.description || ran(tool, m.id), efforts: effortLevels(tool, m.id) });
    }
    for (const id of (recent && recent[tool.id]) || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      add({ kind: "model", model: id, text: `${tool.label} · ${id}`, search: `${tool.label} ${id}`, label: id, id: "", description: ran(tool, id), efforts: effortLevels(tool, id) });
    }
    add({ kind: "other", model: null, text: `${tool.label} · Other model…`, search: `${tool.label} other model`, label: "Other model…", id: "", efforts: null });
  }
  return rows;
}

function currentIndex(rows, current) {
  if (!current) return 0;
  const i = rows.findIndex((r) => r.kind === "model" && r.toolId === current.toolId && r.model === (current.model || null));
  return i < 0 ? 0 : i;
}

// The row "/model <text>" names: a model id or label, or a tool or "default" for a tool's
// default row. Several matches are narrowed to the current tool; -1 when none or still several.
// Recent rows repeat tool rows, so they are not counted.
function matchRow(rows, text, current = null) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return -1;
  const hits = [];
  rows.forEach((r, i) => {
    if (r.kind !== "model" || r.group === "recent") return;
    const names = r.model ? [r.model, r.label] : [r.toolId, r.toolLabel, "default"];
    if (names.some((n) => n && n.toLowerCase() === t)) hits.push(i);
  });
  if (hits.length === 1) return hits[0];
  const own = current ? hits.filter((i) => rows[i].toolId === current.toolId) : [];
  return own.length === 1 ? own[0] : -1;
}

module.exports = { CONTEXT_CAP, createConversation, menuRows, currentIndex, matchRow };
