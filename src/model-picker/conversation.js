const CONTEXT_CAP = 20000;

function modelName(model) {
  return model || "default";
}

function turnBlock(turn) {
  return `[User]\n${turn.prompt}\n\n[${turn.toolLabel} · ${modelName(turn.model)}]\n${turn.reply}`;
}

function createConversation() {
  const turns = [];
  const sessions = {};

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

  function record({ toolId, toolLabel, model = null, prompt, reply, sessionId }) {
    turns.push({ toolId, toolLabel, model, prompt, reply: reply || "(no reply)" });
    const id = sessionId || sessionFor(toolId);
    if (id) sessions[toolId] = { id, seen: turns.length };
  }

  return { turns, sessions, promptFor, record, sessionFor };
}

// Rows for the model menu: per tool a default row, its models, recent typed ids, then "Other".
// text and search feed the numbered list and the filter; label, id and note feed the grouped menu.
function menuRows(tools, recent = {}) {
  const rows = [];
  for (const tool of tools) {
    const add = (row) => rows.push({ toolId: tool.id, toolLabel: tool.label, color: tool.color, ...row });
    add({ kind: "model", model: null, text: `${tool.label} · default`, search: `${tool.label} default`, label: "default", id: "", note: "tool's own default" });
    const seen = new Set();
    for (const m of tool.models || []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const label = m.label || m.id;
      add({ kind: "model", model: m.id, text: `${tool.label} · ${label}`, search: `${tool.label} ${m.label || ""} ${m.id}`, label, id: label === m.id ? "" : m.id });
    }
    for (const id of (recent && recent[tool.id]) || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      add({ kind: "model", model: id, text: `${tool.label} · ${id}`, search: `${tool.label} ${id}`, label: id, id: "" });
    }
    add({ kind: "other", model: null, text: `${tool.label} · Other model…`, search: `${tool.label} other model`, label: "Other model…", id: "" });
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
function matchRow(rows, text, current = null) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return -1;
  const hits = [];
  rows.forEach((r, i) => {
    if (r.kind !== "model") return;
    const names = r.model ? [r.model, r.label] : [r.toolId, r.toolLabel, "default"];
    if (names.some((n) => n && n.toLowerCase() === t)) hits.push(i);
  });
  if (hits.length === 1) return hits[0];
  const own = current ? hits.filter((i) => rows[i].toolId === current.toolId) : [];
  return own.length === 1 ? own[0] : -1;
}

module.exports = { CONTEXT_CAP, createConversation, menuRows, currentIndex, matchRow };
