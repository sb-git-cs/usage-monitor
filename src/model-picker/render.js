const { stripVTControlCharacters } = require("node:util");

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HINT = "↑↓ move · Tab next tool · type to filter · Enter select · Esc close";
// 256-color tool colors and their basic-terminal stand-ins.
const BASIC = { 173: 33, 114: 32, 252: 37, 75: 34, 141: 35 };
const ACCENT = 222;
const RULE_MAX = 80;

function colorEnabled() {
  return !process.env.NO_COLOR && !!process.stdout.isTTY;
}

// color/basic can be forced by the caller; by default they follow NO_COLOR, TERM and the TTY.
function styler(opts = {}) {
  const on = opts.color !== undefined ? !!opts.color : colorEnabled();
  const basic = opts.basic !== undefined ? !!opts.basic : process.env.TERM === "dumb";
  const wrap = (open, close) => (s) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    on,
    basic,
    bold: wrap("1", "22"),
    dim: wrap("2", "22"),
    italic: wrap("3", "23"),
    red: wrap("31", "39"),
    yellow: wrap("33", "39"),
    cyan: wrap("36", "39"),
    fg: (n, s) => (!on ? s : basic ? `\x1b[${BASIC[n] || 39}m${s}\x1b[39m` : `\x1b[38;5;${n}m${s}\x1b[39m`),
  };
}

const visibleWidth = (s) => [...stripVTControlCharacters(String(s))].length;

function clip(text, width) {
  const chars = [...text];
  return chars.length > width ? `${chars.slice(0, Math.max(0, width - 1)).join("")}…` : text;
}

// ---- menu ----

function filterRows(rows, filter = "") {
  const f = filter.toLowerCase();
  return rows.map((_, i) => i).filter((i) => rows[i].search.toLowerCase().includes(f));
}

// Moves to the first row of the next (dir 1) or previous (dir -1) tool group, wrapping around.
function jumpGroup(rows, list, pos, dir) {
  const starts = [];
  list.forEach((ri, k) => {
    if (k === 0 || rows[ri].toolId !== rows[list[k - 1]].toolId) starts.push(k);
  });
  if (!starts.length) return 0;
  let g = 0;
  starts.forEach((s, i) => {
    if (s <= pos) g = i;
  });
  return starts[(g + dir + starts.length) % starts.length];
}

// Pure layout of the whole menu block. pos indexes the filtered list of selectable rows.
function menuLines(rows, { filter = "", pos = 0, width = 80, height = 20, current = null, color, basic } = {}) {
  const st = styler({ color, basic });
  const list = filterRows(rows, filter);
  pos = Math.max(0, Math.min(pos, list.length - 1));
  const counts = {};
  for (const r of rows) if (r.kind === "model" && r.model) counts[r.toolId] = (counts[r.toolId] || 0) + 1;
  const labelW = Math.min(36, Math.max(7, ...list.map((i) => [...rows[i].label].length)));

  const items = [];
  let hlItem = 0;
  let prev = null;
  list.forEach((ri, k) => {
    const r = rows[ri];
    if (r.toolId !== prev) {
      prev = r.toolId;
      const n = counts[r.toolId] || 0;
      items.push({ head: true, text: st.bold(st.fg(r.color, r.toolLabel)) + st.dim(`  ${n} model${n === 1 ? "" : "s"}`) });
    }
    const hl = k === pos;
    if (hl) hlItem = items.length;
    const isCur = !!current && r.kind === "model" && r.toolId === current.toolId && r.model === (current.model || null);
    const tail = r.id || r.note || "";
    const room = width - 6 - labelW - 2;
    const showTail = tail && room >= 4;
    const label = clip(r.label, labelW);
    const cell = showTail ? label + " ".repeat(Math.max(0, labelW - [...label].length)) : label;
    items.push({
      text: `  ${hl ? st.fg(r.color, "›") : " "} ${isCur ? st.fg(r.color, "●") : " "} ${hl ? st.bold(cell) : cell}${showTail ? "  " + st.dim(clip(tail, room)) : ""}`,
    });
  });
  if (!list.length) items.push({ text: st.dim("  (no match)") });

  const pre = filter ? [`${st.dim("Filter ")}${filter}`] : [];
  const avail = Math.max(1, height - pre.length - 1);
  let top = 0;
  if (items.length > avail) {
    const target = hlItem > 0 && items[hlItem - 1].head ? hlItem - 1 : hlItem;
    top = Math.max(0, Math.min(hlItem - Math.floor(avail / 2), items.length - avail));
    if (top > target) top = target;
  }
  return [...pre, ...items.slice(top, top + avail).map((it) => it.text), st.dim(clip(HINT, width))];
}

// ---- progress, framing ----

function statusLine({ frame = 0, label = "", elapsed = 0, activity = "", width = 80, toolColor, color, basic } = {}) {
  const st = styler({ color, basic });
  const what = activity === "thinking" || activity === "writing" ? `${activity}…` : activity || "working…";
  const rest = clip([label, what, `${elapsed.toFixed(1)}s`].join(" · "), Math.max(10, width - 2));
  return `${st.fg(toolColor, SPINNER[frame % SPINNER.length])} ${st.dim(rest)}`;
}

function formatTokens(n) {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

function formatCost(usd) {
  return usd < 0.005 ? "<$0.01" : `≈$${usd.toFixed(2)}`;
}

function turnRule({ label, toolColor, columns = 0, color, basic } = {}) {
  const st = styler({ color, basic });
  const head = `── ${label} `;
  const total = Math.min(columns > 0 ? columns - 1 : RULE_MAX, RULE_MAX);
  return st.fg(toolColor, head + "─".repeat(Math.max(2, total - [...head].length)));
}

// used: the model and effort the tool recorded for the turn, when it keeps such a record.
function turnFooter({ elapsedMs = 0, usage, costUsd, failed, stopped, used, color, basic } = {}) {
  const st = styler({ color, basic });
  const time = `${(elapsedMs / 1000).toFixed(1)} s`;
  if (stopped) return st.dim(`■ Stopped · ${time}`);
  if (failed) return `${st.red(`✗ ${failed}`)}${st.dim(` · ${time}`)}`;
  const parts = [time];
  if (used && used.model) parts.push(used.effort ? `${used.model} · effort ${used.effort}` : used.model);
  if (usage) parts.push(`${formatTokens(usage.input)} in`, `${formatTokens(usage.output)} out`);
  if (typeof costUsd === "number" && costUsd > 0) parts.push(formatCost(costUsd));
  return st.dim(`✓ ${parts.join(" · ")}`);
}

// ---- markdown ----

function inline(text, st) {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) => {
      if (i % 2) return st.cyan(part.slice(1, -1));
      return part
        .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, (_, t) => st.bold(t))
        .replace(/(^|[^\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, (_, a, t) => a + st.italic(t))
        .replace(/(^|[^\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g, (_, a, t) => a + st.italic(t))
        .replace(/\[([^\]\n]+)\]\((\S+?)\)/g, (_, t, url) => `${t} ${st.dim(`(${url})`)}`);
    })
    .join("");
}

// One line at a time; state ({ fence }) only remembers whether we are inside a code block.
function renderLine(line, state, { color, basic, width = 40 } = {}) {
  const st = styler({ color, basic });
  if (!st.on) return line;
  const fence = /^\s*```\s*([\w+#.-]*)/.exec(line);
  if (fence) {
    state.fence = !state.fence;
    const rule = Math.min(width, 60);
    const head = state.fence && fence[1] ? `─── ${fence[1]} ` : "───";
    return st.dim(head + "─".repeat(Math.max(0, rule - [...head].length)));
  }
  if (state.fence) return `${st.dim("│ ")}${line}`;
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) return st.bold(st.fg(ACCENT, heading[1]));
  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote) return st.dim("│ ") + inline(quote[1], st);
  const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}• ${inline(bullet[2], st)}`;
  return inline(line, st);
}

// Streams text, then swaps each finished line for its rendered form when colors are on.
// Modes: plain (no color: pass through), live (rewrite the raw line in place) and
// buffered (no usable column count: wait for the newline).
function createStreamRenderer({ write, columns = 0, overwrite = false, color, basic } = {}) {
  const st = styler({ color, basic });
  const state = { fence: false };
  const plain = !st.on;
  const live = !plain && overwrite && columns > 0;
  const ruleWidth = Math.min(columns > 0 ? columns : RULE_MAX, RULE_MAX);
  let buf = "";
  let shown = false;
  let open = false;

  const finishLine = (newline) => {
    if (shown) {
      const rows = Math.max(1, Math.ceil(visibleWidth(buf) / columns));
      write((rows > 1 ? `\x1b[${rows - 1}A` : "") + "\r\x1b[J");
      shown = false;
    }
    write(renderLine(buf, state, { color: st.on, basic: st.basic, width: ruleWidth }) + (newline ? "\n" : ""));
    buf = "";
  };

  return {
    push(text) {
      if (!text) return;
      if (plain) {
        write(text);
        open = !text.endsWith("\n");
        return;
      }
      const parts = (live ? text.replace(/\t/g, "  ") : text).split("\n");
      parts.forEach((piece, i) => {
        buf += piece;
        if (i < parts.length - 1) finishLine(true);
        else if (piece) {
          if (live) {
            write(piece);
            shown = true;
          }
        }
      });
    },
    // Ends the current line, rendering any partial text first.
    endLine() {
      if (plain) {
        if (open) write("\n");
        open = false;
      } else if (buf) finishLine(true);
    },
    // True when nothing unfinished is on the cursor's row (so a status line may be drawn).
    atLineStart: () => !(shown || (plain && open)),
  };
}

module.exports = {
  SPINNER,
  HINT,
  styler,
  visibleWidth,
  clip,
  filterRows,
  jumpGroup,
  menuLines,
  statusLine,
  formatTokens,
  formatCost,
  turnRule,
  turnFooter,
  renderLine,
  createStreamRenderer,
};
