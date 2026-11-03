const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { spawn, spawnSync } = require("node:child_process");
const tools = require("./tools");
const { createConversation, menuRows, currentIndex, matchRow } = require("./conversation");
const render = require("./render");

const RECENT_MAX = 10;
const HISTORY_MAX = 50;
const USED_MAX = 8;
const SAVED_TURNS_MAX = 100;
// A reply that took this long rings the terminal bell when it finishes.
const BELL_AFTER_MS = 20000;
const st = render.styler();
const fmt = { color: st.on, basic: st.basic };
const { dim, red, yellow, bold } = st;
const dimRed = (s) => dim(red(s));
// Shared across prompts: the readline interface is re-created per question.
const history = [];

// ---- persistence (best effort) ----

function settingsFile() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "UsageMonitor", "model-picker.json");
  }
  return path.join(os.homedir(), ".config", "usage-monitor", "model-picker.json");
}

// Only well-formed entries survive: an id saved before ids were checked (such as "/model") is
// dropped. effort maps a tool to its chosen level, used lists the models used last (newest
// first), resolved maps "tool:model" to the full model the tool last reported running.
function readSettings(data) {
  const object = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const pick = (v) => {
    const p = object(v);
    return typeof p.toolId === "string" && (p.model == null || tools.validModelId(p.model)) ? { toolId: p.toolId, model: p.model || null } : null;
  };
  const saved = Array.isArray(data.history) ? data.history.filter((x) => typeof x === "string" && x) : [];
  const recent = {};
  for (const [toolId, ids] of Object.entries(object(data.recent))) {
    if (Array.isArray(ids)) recent[toolId] = ids.filter((id) => tools.validModelId(id));
  }
  const effort = {};
  for (const [toolId, level] of Object.entries(object(data.effort))) {
    if (typeof level === "string" && /^[a-z]+$/.test(level)) effort[toolId] = level;
  }
  const used = (Array.isArray(data.used) ? data.used : []).map(pick).filter(Boolean).slice(0, USED_MAX);
  const resolved = {};
  for (const [key, full] of Object.entries(object(data.resolved))) {
    if (/^[a-z]+:/.test(key) && tools.validModelId(full)) resolved[key] = full;
  }
  return { last: pick(data.last), recent, effort, used, resolved, history: saved.slice(0, HISTORY_MAX) };
}

function loadSettings() {
  try {
    return readSettings(JSON.parse(fs.readFileSync(settingsFile(), "utf8")));
  } catch {
    return readSettings({});
  }
}

function saveSettings(settings) {
  try {
    const file = settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  } catch {
    /* best effort */
  }
}

function remember(settings, toolId, id) {
  const list = (settings.recent[toolId] || []).filter((x) => x !== id);
  settings.recent[toolId] = [id, ...list].slice(0, RECENT_MAX);
}

// One saved conversation per folder, so a new window there can carry on with every tool's session.
function conversationFile(cwd, base = path.dirname(settingsFile())) {
  const key = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  return path.join(base, "model-picker-conversations", `${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`);
}

function loadConversation(cwd) {
  try {
    const data = JSON.parse(fs.readFileSync(conversationFile(cwd), "utf8"));
    return data && Array.isArray(data.turns) && data.turns.length ? data : null;
  } catch {
    return null;
  }
}

// Keeps the newest turns; a tool whose seen turns were dropped is given the kept ones again.
function saveConversation(cwd, conversation, keep = SAVED_TURNS_MAX) {
  try {
    const { turns, sessions } = conversation.toJSON();
    const drop = Math.max(0, turns.length - keep);
    const kept = {};
    for (const [toolId, s] of Object.entries(sessions)) kept[toolId] = { id: s.id, seen: Math.max(0, s.seen - drop) };
    const file = conversationFile(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ cwd, savedAt: Date.now(), turns: turns.slice(drop), sessions: kept }));
  } catch {
    /* best effort */
  }
}

function forgetConversation(cwd) {
  fs.rm(conversationFile(cwd), { force: true }, () => {});
}

function ago(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// Puts text on the clipboard with the platform's own tool; false when none worked. clip.exe
// keeps UTF-16LE exactly, but keeps a byte-order mark as a character and reads UTF-8 in the
// console code page.
function copyToClipboard(text, platform = process.platform, run = spawnSync) {
  const tries =
    platform === "win32"
      ? [["clip.exe", [], Buffer.from(text, "utf16le")]]
      : platform === "darwin"
        ? [["pbcopy", [], Buffer.from(text)]]
        : [["wl-copy", [], Buffer.from(text)], ["xclip", ["-selection", "clipboard"], Buffer.from(text)], ["xsel", ["--clipboard", "--input"], Buffer.from(text)]];
  for (const [command, args, input] of tries) {
    const r = run(command, args, { input, windowsHide: true, timeout: 5000 });
    if (r && !r.error && r.status === 0) return true;
  }
  return false;
}

// ---- input ----

const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
let readPiped = null;

// Piped input must be read through one reader, or lines buffered by an earlier reader are lost.
function pipedReader() {
  const queue = [];
  let waiter = null;
  let closed = false;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  return (text) => {
    process.stdout.write(text);
    if (queue.length) return Promise.resolve(queue.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiter = resolve;
    });
  };
}

function ask(text) {
  if (!interactive) {
    if (!readPiped) readPiped = pipedReader();
    return readPiped(text);
  }
  return askTerminal(text);
}

// Lines arriving closer together than this are one paste, not typed lines.
const PASTE_GAP_MS = 40;
const CONTINUE = "    ";

// An answer from the terminal, null on Ctrl+C or end of input. Each question gets its own
// interface, which must close completely: readline detaches from the input in its own close
// listener, and an interface left attached echoes every later keystroke again.
// multiline: a pasted block stays one answer and is sent by the next Enter, and a line ending
// in \ continues on the next. Only single-line answers join the ↑ history.
function askTerminal(text, { input = process.stdin, output = process.stdout, multiline = false, completer } = {}) {
  return new Promise((resolve) => {
    const before = history.slice();
    const rl = readline.createInterface({ input, output, terminal: true, history, historySize: 100, removeHistoryDuplicates: true, ...(completer ? { completer } : {}) });
    const lines = [];
    let lastAt = 0;
    let pasted = false;
    let timer = null;
    const submit = () => {
      const answer = lines.join("\n").replace(/\n+$/, "");
      // readline added every entered line to the list; keep only what was sent, and one line at most.
      history.splice(0, history.length, ...before);
      if (multiline && answer.trim() && !answer.includes("\n") && history[0] !== answer) history.unshift(answer);
      history.length = Math.min(history.length, 100);
      // Resolved first, so the null from the close listener is ignored.
      resolve(answer);
      rl.close();
    };
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      clearTimeout(timer);
      history.splice(0, history.length, ...before);
      resolve(null);
    });
    rl.on("line", (line) => {
      if (!multiline) {
        lines.push(line);
        return submit();
      }
      const now = Date.now();
      if (now - lastAt < PASTE_GAP_MS) pasted = true;
      lastAt = now;
      clearTimeout(timer);
      if (line.endsWith("\\")) {
        lines.push(line.slice(0, -1));
        rl.setPrompt(CONTINUE);
        rl.prompt();
        return;
      }
      lines.push(line);
      // Pasted lines are echoed as they came, so a redraw must not add an indent either.
      rl.setPrompt("");
      timer = setTimeout(() => {
        if (!pasted) return submit();
        pasted = false;
      }, PASTE_GAP_MS);
    });
    rl.setPrompt(text);
    rl.prompt();
  });
}

async function readPrompt(head, completer) {
  if (interactive) {
    const text = await askTerminal(head, { multiline: true, completer });
    return text === null ? null : text.trim();
  }
  const lines = [];
  for (;;) {
    const line = await ask(lines.length ? CONTINUE : head);
    if (line === null) return lines.length ? lines.join("\n") : null;
    if (line.endsWith("\\")) {
      lines.push(line.slice(0, -1));
      continue;
    }
    lines.push(line);
    return lines.join("\n").trim();
  }
}

// ---- menu ----

// Returns { index, effort } for the chosen row, or null when the menu is closed without a
// choice. effort is the level set with ←/→ (null: the tool's own setting), undefined for a
// row without effort levels; effortStart(row) is where a row starts.
function pickInteractive(rows, startIndex, current, startFilter = "", effortStart = () => null) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let filter = startFilter;
    let pos = 0;
    let drawn = 0;
    const efforts = new Map();
    const effortOf = (ri) => (efforts.has(ri) ? efforts.get(ri) : effortStart(rows[ri]));
    const visible = () => render.filterRows(rows, filter);
    pos = Math.max(0, visible().indexOf(startIndex));

    const draw = () => {
      const list = visible();
      pos = Math.min(pos, Math.max(0, list.length - 1));
      const lines = render.menuLines(rows, {
        filter,
        pos,
        width: (process.stdout.columns || 80) - 1,
        height: Math.max(5, (process.stdout.rows || 24) - 2),
        current,
        effortOf,
        ...fmt,
      });
      process.stdout.write((drawn ? `\x1b[${drawn}A` : "") + "\r\x1b[J" + lines.join("\n") + "\n");
      drawn = lines.length;
    };

    const finish = (value) => {
      stdin.removeListener("keypress", onKey);
      // Raw mode and the flowing input stay as they are: a readline prompt always comes
      // next and takes them over, and Node restores the console mode on exit. Esc is only
      // recognised by a timer, while a console read is pending, and on Windows pausing or
      // leaving raw mode at that moment stops all later keys from arriving.
      process.stdout.write(`\x1b[${drawn}A\r\x1b[J`);
      resolve(value);
    };

    const onKey = (str, key = {}) => {
      const list = visible();
      const page = Math.max(1, (process.stdout.rows || 24) - 6);
      if (key.ctrl && key.name === "c") return finish(null);
      switch (key.name) {
        case "up":
          pos = Math.max(0, pos - 1);
          break;
        case "down":
          pos = Math.min(list.length - 1, pos + 1);
          break;
        case "pageup":
          pos = Math.max(0, pos - page);
          break;
        case "pagedown":
          pos = Math.min(list.length - 1, pos + page);
          break;
        case "tab":
          pos = render.jumpGroup(rows, list, pos, key.shift ? -1 : 1);
          break;
        case "home":
          pos = 0;
          break;
        case "end":
          pos = Math.max(0, list.length - 1);
          break;
        case "left":
        case "right": {
          const ri = list[pos];
          if (ri === undefined || !rows[ri].efforts) return;
          const options = [null, ...rows[ri].efforts];
          const at = Math.max(0, options.indexOf(effortOf(ri)));
          efforts.set(ri, options[(at + (key.name === "right" ? 1 : -1) + options.length) % options.length]);
          break;
        }
        case "return":
        case "enter": {
          if (!list.length) return undefined;
          const ri = list[pos];
          return finish({ index: ri, effort: rows[ri].efforts ? effortOf(ri) : undefined });
        }
        case "escape":
          if (!filter) return finish(null);
          filter = "";
          pos = Math.max(0, visible().indexOf(startIndex));
          break;
        case "backspace":
          filter = filter.slice(0, -1);
          pos = 0;
          break;
        default:
          if (str && !key.ctrl && !key.meta && str >= " " && str !== "\x7f") {
            filter += str;
            pos = 0;
          } else return;
      }
      draw();
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKey);
    draw();
  });
}

async function pickNumbered(rows, startIndex) {
  rows.forEach((r, i) => console.log(`${String(i + 1).padStart(3)}. ${r.text}`));
  for (;;) {
    const answer = await ask(`Number (Enter keeps ${startIndex + 1}): `);
    if (answer === null) return null;
    const t = answer.trim();
    if (t === "/exit" || t === "/quit") return null;
    if (!t) return { index: startIndex };
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= rows.length) return { index: n - 1 };
    console.log("Not a valid number.");
  }
}

// ---- running a turn ----

function killTree(child) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    } else child.kill();
  } catch {
    /* already gone */
  }
}

function lineSplitter(onLine) {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ""));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      if (buf) onLine(buf.replace(/\r$/, ""));
      buf = "";
    },
  };
}

async function runTurn(tool, model, effort, prompt, conversation) {
  const started = Date.now();
  const text = conversation.promptFor(tool.id, prompt);
  let promptFile = null;
  if (tool.promptFile) {
    promptFile = path.join(os.tmpdir(), `model-picker-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, text, "utf8");
  }
  const run = { texts: [], printed: false, result: null, sessionId: null, stopped: false, spawnError: null, activity: "" };
  const tty = !!process.stdout.isTTY;
  const columns = process.stdout.columns || 0;
  const label = `${tool.label} · ${model || "default"}${effort ? ` · effort ${effort}` : ""}`;

  // The status line shares the cursor row with output, so every write erases it first.
  let spinShown = false;
  let frame = 0;
  let timer = null;
  const clearSpin = () => {
    if (spinShown) {
      process.stdout.write("\r\x1b[K");
      spinShown = false;
    }
  };
  const write = (s) => {
    clearSpin();
    process.stdout.write(s);
  };
  const answer = render.createStreamRenderer({ write, columns, overwrite: tty, ...fmt });
  const drawSpin = () => {
    if (!answer.atLineStart()) return;
    const status = render.statusLine({ frame: frame++, label, elapsed: (Date.now() - started) / 1000, activity: run.activity, width: (columns || 80) - 1, toolColor: tool.color, ...fmt });
    process.stdout.write(`\r\x1b[K${status}`);
    spinShown = true;
  };
  const stopSpin = () => {
    if (timer) clearInterval(timer);
    timer = null;
    clearSpin();
  };
  const line = (s, style) => {
    answer.endLine();
    write(`${style ? style(s) : s}\n`);
  };

  const parse = tools.createParser(tool.id);
  const handle = (l) => {
    for (const ev of parse(l)) {
      if (ev.kind === "session") run.sessionId = ev.id;
      else if (ev.kind === "text") {
        run.texts.push(ev.text);
        run.printed = true;
        run.activity = "writing";
        answer.push(ev.text);
      } else if (ev.kind === "tool") {
        line(`  • ${ev.text}`, dim);
        run.activity = `running ${ev.text.replace(/^Run /, "")}`;
      } else if (ev.kind === "activity") run.activity = ev.text;
      else if (ev.kind === "note") line(ev.text, yellow);
      else if (ev.kind === "raw") line(ev.text, dim);
      else if (ev.kind === "result") run.result = ev;
    }
  };

  // Piped input is not echoed, so the prompt has no newline after it.
  write(`${tty ? "" : "\n"}${render.turnRule({ label, toolColor: tool.color, columns, ...fmt })}\n`);
  if (tty) {
    run.activity = "thinking";
    timer = setInterval(drawSpin, 80);
    drawSpin();
  }

  const exit = await new Promise((resolve) => {
    let child;
    try {
      const { args, stdin } = tools.buildArgv(tool.id, { model, effort, sessionId: conversation.sessionFor(tool.id), prompt: text, promptFile });
      const plan = tools.spawnPlan(tool.exe, args);
      child = spawn(plan.command, plan.args, { ...plan.options, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.on("error", () => {});
      child.stdin.end(stdin == null ? undefined : stdin, "utf8");
    } catch (err) {
      run.spawnError = err.message;
      resolve(null);
      return;
    }
    const out = lineSplitter(handle);
    const errs = lineSplitter((l) => l && line(l, dimRed));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => errs.push(d));
    const onSigint = () => {
      run.stopped = true;
      stopSpin();
      killTree(child);
    };
    process.on("SIGINT", onSigint);
    child.on("error", (err) => {
      run.spawnError = err.message;
    });
    child.on("close", (code) => {
      process.removeListener("SIGINT", onSigint);
      out.end();
      errs.end();
      resolve(code);
    });
  });
  if (promptFile) fs.rm(promptFile, { force: true }, () => {});
  stopSpin();

  const elapsedMs = Date.now() - started;
  if (run.stopped) {
    answer.endLine();
    line(render.turnFooter({ elapsedMs, stopped: true, ...fmt }));
    return null;
  }
  const reply = (run.result && run.result.text) || run.texts.join("");
  if (!run.printed && run.result && run.result.text) answer.push(run.result.text);
  answer.endLine();
  let failed = null;
  if (run.spawnError && !run.result) failed = `${tool.label} stopped: ${run.spawnError}`;
  else if (run.result && run.result.error) failed = `${tool.label} stopped: ${run.result.text || "error"}`;
  else if (!run.result && exit !== 0) failed = `${tool.label} stopped: exit code ${exit}`;
  const r = run.result || {};
  // What the tool says it ran, which settles what an alias such as "opus" and the effort became.
  const used = failed ? null : tools.usedBy(tool.id, { sessionId: run.sessionId });
  line(render.turnFooter({ elapsedMs, usage: r.usage, costUsd: r.costUsd, failed, used, ...fmt }));
  // A long reply rings the bell, which flashes the taskbar when the window is in the background.
  if (tty && elapsedMs >= BELL_AFTER_MS) process.stdout.write("\x07");
  conversation.record({ toolId: tool.id, toolLabel: tool.label, model, prompt, reply, sessionId: run.sessionId, effort, used, elapsedMs, usage: r.usage || null, costUsd: typeof r.costUsd === "number" ? r.costUsd : null });
  return { used, failed };
}

// ---- main ----

async function main() {
  const cwd = process.cwd();
  const tty = !!process.stdout.isTTY;
  console.log(`${bold("◆ Model picker")}  ${dim(cwd)}`);

  const found = tools.TOOLS.map((t) => ({ ...t, exe: tools.findExecutable(t.id) })).filter((t) => t.exe);
  if (!found.length) {
    console.error(`No coding CLI found. Looked for: ${tools.TOOLS.map((t) => t.file).join(", ")}`);
    process.exit(1);
  }

  console.log(dim("Loading models…"));
  const lists = await Promise.all(found.map((t) => tools.loadModels(t.id, { exe: t.exe })));
  const installed = found.map((t, i) => ({ ...t, models: lists[i] }));
  const byId = Object.fromEntries(installed.map((t) => [t.id, t]));
  if (tty) process.stdout.write("\x1b[1A\r\x1b[J");
  console.log(dim(installed.map((t) => `${t.label} ${t.models.length}`).join(" · ")));
  console.log(dim("Runs with skip-permissions · /help lists commands · Tab completes · Ctrl+C stops a reply"));

  const settings = loadSettings();
  history.push(...settings.history);
  let conversation = createConversation();
  // A model is checked against its tool's list; a list that could not be read checks nothing,
  // so saved ids for that tool are kept until it can be.
  const listed = (toolId, model) => !!byId[toolId] && (!model || !byId[toolId].models.length || tools.knownModel(byId[toolId], model));
  for (const tool of installed) {
    if (settings.recent[tool.id]) settings.recent[tool.id] = settings.recent[tool.id].filter((id) => listed(tool.id, id));
  }
  settings.used = settings.used.filter((u) => listed(u.toolId, u.model));
  let current = settings.last && listed(settings.last.toolId, settings.last.model) ? settings.last : null;

  // Ctrl+C outside a turn must not leave a half-drawn menu or a hung process.
  process.on("SIGINT", () => {});
  // A lone Esc is known only once no other byte follows it. 100 ms instead of Node's 500 ms
  // closes the menu promptly and keeps an Esc followed quickly by another key from merging
  // into one unknown key. The first call sets this for the menu and readline alike.
  if (interactive) readline.emitKeypressEvents(process.stdin, { escapeCodeTimeout: 100 });

  const rowsNow = () => menuRows(installed, settings.recent, { used: settings.used, resolved: settings.resolved });
  // A row starts on the tool's chosen effort when its model takes that level.
  const effortStart = (row) => {
    const level = settings.effort[row.toolId];
    return level && row.efforts && row.efforts.includes(level) ? level : null;
  };

  // The model menu: { toolId, model, effort } (effort undefined: not set in the menu), or null
  // when it is closed without a choice.
  const choose = async (filter = "") => {
    for (;;) {
      const rows = rowsNow();
      const start = currentIndex(rows, current);
      const picked = interactive ? await pickInteractive(rows, start, current, filter, effortStart) : await pickNumbered(rows, start);
      if (picked === null) return null;
      filter = "";
      const row = rows[picked.index];
      if (row.kind !== "other") return { toolId: row.toolId, model: row.model, effort: picked.effort };
      const typed = await ask(`Model id for ${row.toolLabel}: `);
      if (typed === null) return null;
      const id = typed.trim();
      if (!id) continue;
      if (!tools.knownModel(byId[row.toolId], id)) {
        console.log(red(notListed(byId[row.toolId], id)));
        continue;
      }
      remember(settings, row.toolId, id);
      return { toolId: row.toolId, model: id };
    }
  };

  // The chosen effort for the current tool; null leaves it to the tool's own setting.
  const effort = () => settings.effort[current.toolId] || null;
  const describe = () => `${byId[current.toolId].label} · ${current.model || "default"}${effort() ? ` · effort ${effort()}` : ""}`;
  const announce = () => console.log(tty ? st.fg(byId[current.toolId].color, `● ${describe()}`) : `Model: ${describe()}`);

  const use = (next) => {
    current = { toolId: next.toolId, model: next.model || null };
    settings.last = current;
    const tool = byId[current.toolId];
    if (next.effort !== undefined) {
      if (next.effort) settings.effort[tool.id] = next.effort;
      else delete settings.effort[tool.id];
    }
    settings.used = [current, ...settings.used.filter((u) => u.toolId !== current.toolId || u.model !== current.model)].slice(0, USED_MAX);
    const levels = tools.effortLevels(tool, current.model);
    if (effort() && !(levels && levels.includes(effort()))) {
      console.log(yellow(`${current.model || `${tool.label}'s default model`} has no effort ${effort()}, so ${tool.label}'s own setting is used.`));
      delete settings.effort[tool.id];
    }
    saveSettings(settings);
    announce();
  };

  // /effort shows the choice, /effort <level> sets it for the current tool, /effort default
  // goes back to the tool's own setting.
  const setEffort = (arg) => {
    const tool = byId[current.toolId];
    const levels = tools.effortLevels(tool, current.model);
    if (!levels) {
      console.log(yellow(tool.effortInModel
        ? `${tool.label} has no effort setting: the effort is part of the model (for example …-high). Choose one with /model.`
        : `The effort levels of ${current.model || `${tool.label}'s default model`} are not known, so ${tool.label}'s own setting is used.`));
      return;
    }
    if (!arg) {
      console.log(`${describe()}${effort() ? "" : ` · effort: ${tool.label}'s own setting`}`);
      console.log(dim(`Levels: ${levels.join(", ")}. /effort <level> sets it, /effort default goes back to ${tool.label}'s own setting.`));
      return;
    }
    if (arg === "default") delete settings.effort[tool.id];
    else if (levels.includes(arg)) settings.effort[tool.id] = arg;
    else {
      console.log(red(`“${arg}” is not an effort level of ${current.model || `${tool.label}'s default model`}. Levels: ${levels.join(", ")}.`));
      return;
    }
    saveSettings(settings);
    announce();
  };

  // "/model <name>" and "/retry <name>": the named model, the menu filtered to the name when
  // several match, or null (with the reason) when none does or the menu is closed.
  const byName = async (name) => {
    const rows = rowsNow();
    const hit = matchRow(rows, name, current);
    if (hit >= 0) return { toolId: rows[hit].toolId, model: rows[hit].model };
    if (!render.filterRows(rows, name).length) {
      console.log(red(`No model matches “${name}”.`));
      return null;
    }
    return choose(name);
  };

  const complete = (line) => completeLine(line, { installed, recent: settings.recent, current });

  const width = () => Math.max(20, (process.stdout.columns || 80) - 1);

  // After a turn: how big the conversation is and what a switch would hand over.
  const showStatus = () => {
    const t = conversation.totals();
    if (!t.turns) return;
    const parts = [`${t.turns} turn${t.turns === 1 ? "" : "s"}`];
    if (t.input || t.output) parts.push(`${render.formatTokens(t.input)} in · ${render.formatTokens(t.output)} out`);
    if (t.costUsd > 0) parts.push(render.formatCost(t.costUsd));
    const carry = installed
      .filter((x) => x.id !== current.toolId && conversation.missedBy(x.id) > 0)
      .map((x) => `${x.label} ${conversation.missedBy(x.id)}`);
    if (carry.length) parts.push(`a switch hands over: ${carry.join(", ")}`);
    console.log(dim(render.clip(parts.join(" · "), width())));
  };

  const showHistory = () => {
    if (!conversation.turns.length) return console.log(dim("No turns yet."));
    conversation.turns.forEach((t, i) => {
      const model = (t.used && t.used.model) || t.model || "default";
      const level = (t.used && t.used.effort) || t.effort;
      const who = `${t.toolLabel} · ${model}${level ? ` · ${level}` : ""}`;
      const stats = [t.elapsedMs ? `${(t.elapsedMs / 1000).toFixed(1)} s` : "", t.usage ? `${render.formatTokens(t.usage.input || 0)} in · ${render.formatTokens(t.usage.output || 0)} out` : ""].filter(Boolean).join(" · ");
      const color = byId[t.toolId] ? byId[t.toolId].color : 252;
      const head = `${String(i + 1).padStart(3)}  ${who}${stats ? `  ${stats}` : ""}  `;
      const asked = render.clip(t.prompt.split("\n")[0], Math.max(10, width() - [...head].length));
      console.log(`${dim(String(i + 1).padStart(3))}  ${st.fg(color, who)}${stats ? `  ${dim(stats)}` : ""}  ${asked}`);
    });
  };

  const turn = async (prompt) => {
    const tool = byId[current.toolId];
    const result = await runTurn(tool, current.model, effort(), prompt, conversation);
    if (result && result.used) {
      settings.resolved[`${tool.id}:${current.model || ""}`] = result.used.model;
      saveSettings(settings);
    }
    if (result) saveConversation(cwd, conversation);
    showStatus();
  };

  // Start on the last model; the menu opens only when there is none, or on /model.
  if (current) use(current);
  else {
    const first = await choose();
    if (!first) return;
    use(first);
  }

  // A conversation left in this folder can carry on, with every tool's own session.
  const saved = interactive ? loadConversation(cwd) : null;
  if (saved) {
    const last = saved.turns[saved.turns.length - 1];
    const n = saved.turns.length;
    const answer = await ask(
      `Carry on the conversation here from ${ago(Date.now() - (saved.savedAt || 0))}? ${n} turn${n === 1 ? "" : "s"}, last ${last.toolLabel}: “${render.clip(String(last.prompt).split("\n")[0], 40)}” [Y/n] `
    );
    if (answer === null) return;
    if (!/^\s*n/i.test(answer)) {
      conversation = createConversation(saved);
      console.log(dim("Carrying on. /history lists the turns, /new starts over."));
      showStatus();
    }
  }

  for (;;) {
    const tool = byId[current.toolId];
    const head = `${st.fg(tool.color, `● ${current.model || "default"}${effort() ? ` · ${effort()}` : ""}`)} › `;
    let prompt;
    do prompt = await readPrompt(head, complete);
    while (prompt === "");
    if (prompt === null) return;
    const command = parseCommand(prompt);
    if (command.kind === "exit") return;
    if (command.kind === "help") {
      console.log(HELP.join("\n"));
      continue;
    }
    if (command.kind === "effort") {
      setEffort(command.arg);
      continue;
    }
    if (command.kind === "model") {
      const next = command.arg ? await byName(command.arg) : await choose();
      if (next) use(next);
      continue;
    }
    if (command.kind === "history") {
      showHistory();
      continue;
    }
    if (command.kind === "new") {
      conversation = createConversation();
      forgetConversation(cwd);
      console.log(dim("New conversation: every tool starts a fresh session."));
      continue;
    }
    if (command.kind === "copy") {
      const last = conversation.turns[conversation.turns.length - 1];
      if (!last) console.log(dim("No answer to copy yet."));
      else if (copyToClipboard(last.reply)) console.log(dim(`Copied the last answer (${last.toolLabel}, ${last.reply.length} characters).`));
      else console.log(red("Could not reach the clipboard."));
      continue;
    }
    if (command.kind === "retry") {
      const last = conversation.turns[conversation.turns.length - 1];
      if (!last) {
        console.log(dim("Nothing to ask again yet."));
        continue;
      }
      if (command.arg) {
        const next = await byName(command.arg);
        if (!next) continue;
        use(next);
      }
      console.log(dim(`Asking again: ${render.clip(last.prompt.split("\n")[0], width() - 14)}`));
      await turn(last.prompt);
      continue;
    }
    if (command.kind === "unknown") {
      console.log(red(`${command.name} is not a picker command. Did you mean ${command.suggestion}? /help lists them.`));
      continue;
    }
    if (interactive) {
      settings.history = history.slice(0, HISTORY_MAX);
      saveSettings(settings);
    }
    await turn(prompt);
  }
}

// Tab completion offers these; the ones taking a name end in a space.
const COMMANDS = ["/model ", "/effort ", "/retry ", "/new", "/history", "/copy", "/help", "/exit"];

// readline completer: [completions, the text they replace]. Commands first, then the names
// /model and /retry take or the levels /effort takes. In a prompt, Tab stays a Tab.
function completeLine(line, { installed, recent = {}, current }) {
  if (!line.startsWith("/")) return [[`${line}\t`], line];
  const m = /^(\/\w+)[ \t]+(\S*)$/.exec(line);
  if (!m) return [COMMANDS.filter((c) => c.startsWith(line)), line];
  let names = [];
  if (m[1] === "/model" || m[1] === "/retry") {
    const set = new Set();
    for (const tool of installed) {
      set.add(tool.id);
      for (const x of tool.models || []) set.add(x.id);
      for (const id of recent[tool.id] || []) set.add(id);
    }
    names = [...set, "default"];
  } else if (m[1] === "/effort") {
    const tool = installed.find((t) => t.id === current.toolId);
    names = ["default", ...(tools.effortLevels(tool, current.model) || [])];
  }
  const word = m[2].toLowerCase();
  return [names.filter((n) => n.toLowerCase().startsWith(word)), m[2]];
}

const HELP = [
  "/model [name]     switch model: the menu, or straight to a name (/model sonnet, /model codex)",
  "/effort [level]   show the effort levels, or set one for this tool (/effort xhigh, /effort default)",
  "/retry [name]     ask the last prompt again, with this model or another (/retry codex)",
  "/history          the turns so far: tool, model, effort, time and tokens",
  "/copy             copy the last answer to the clipboard",
  "/new              start a new conversation; every tool starts a fresh session",
  "/help             this list        /exit  quit",
  "",
  "Prompt: Tab completes commands and names · ↑ earlier prompts · a pasted block is sent by the next Enter",
  "        · a line ending in \\ continues · Ctrl+C stops a reply, or quits at the prompt",
  "Menu:   ↑↓ move · ←→ effort · Tab next group · type to filter · Enter select · Esc close",
];

// Why a typed id is refused: it is not one of the tool's models.
function notListed(tool, id) {
  if (tool.id === "claude") return `“${id}” is not a Claude Code model. Use ${tool.models.map((m) => m.id).join(", ")} or a full name such as claude-opus-5-5.`;
  if (!tool.models.length) return `“${id}” cannot be checked: ${tool.label}'s model list could not be read.`;
  return `“${id}” is not in ${tool.label}'s model list.`;
}

function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

// A one-line prompt that starts with a known /command is that command; "/model <name>",
// "/retry <name>" and "/effort <level>" carry an argument. Any other text goes to the model,
// including the tools' own slash commands, except a near miss of a picker command (/modle).
function parseCommand(line) {
  const t = String(line).trim();
  if (t === "/exit" || t === "/quit") return { kind: "exit" };
  const m = /^\/(model|retry|effort)(?:[ \t]+(.+))?$/.exec(t);
  if (m) return { kind: m[1], arg: m[1] === "effort" ? (m[2] || "").trim().toLowerCase() : (m[2] || "").trim() };
  const bare = /^\/(new|history|copy|help)$/.exec(t);
  if (bare) return { kind: bare[1] };
  const word = /^\/([a-z]+)(?:[ \t].*)?$/i.exec(t);
  if (word) {
    const near = COMMANDS.map((c) => c.trim()).find((c) => editDistance(`/${word[1].toLowerCase()}`, c) <= 2);
    if (near) return { kind: "unknown", name: `/${word[1]}`, suggestion: near };
  }
  return { kind: "prompt" };
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err && err.message ? err.message : err);
      process.exit(1);
    }
  );
}

module.exports = { main, parseCommand, askTerminal, completeLine, readSettings, notListed, copyToClipboard, conversationFile, saveConversation, loadConversation, ago };
