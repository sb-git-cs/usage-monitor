const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const tools = require("./tools");
const { createConversation, menuRows, currentIndex, matchRow } = require("./conversation");
const render = require("./render");

const RECENT_MAX = 10;
const HISTORY_MAX = 50;
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
// dropped. effort maps a tool to its chosen level.
function readSettings(data) {
  const object = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const saved = Array.isArray(data.history) ? data.history.filter((x) => typeof x === "string" && x) : [];
  const recent = {};
  for (const [toolId, ids] of Object.entries(object(data.recent))) {
    if (Array.isArray(ids)) recent[toolId] = ids.filter((id) => tools.validModelId(id));
  }
  const effort = {};
  for (const [toolId, level] of Object.entries(object(data.effort))) {
    if (typeof level === "string" && /^[a-z]+$/.test(level)) effort[toolId] = level;
  }
  const l = object(data.last);
  const last = typeof l.toolId === "string" && (l.model == null || tools.validModelId(l.model)) ? { toolId: l.toolId, model: l.model || null } : null;
  return { last, recent, effort, history: saved.slice(0, HISTORY_MAX) };
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

// One line from the terminal, null on Ctrl+C or end of input. Each question gets its own
// interface, which must close completely: readline detaches from the input in its own
// close listener, and an interface left attached echoes every later keystroke again.
function askTerminal(text, input = process.stdin, output = process.stdout) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: true, history, historySize: 100, removeHistoryDuplicates: true });
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => resolve(null));
    rl.question(text, (answer) => {
      // The interface may hold its own copy of the list, so make sure this line is in ours.
      if (answer.trim() && history[0] !== answer) history.unshift(answer);
      history.length = Math.min(history.length, 100);
      // Resolved first, so the null from the close listener is ignored.
      resolve(answer);
      rl.close();
    });
  });
}

async function readPrompt(head) {
  const lines = [];
  for (;;) {
    const line = await ask(lines.length ? "    " : head);
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

// Returns the chosen row index, or null when the menu is closed without a choice.
function pickInteractive(rows, startIndex, current, startFilter = "") {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let filter = startFilter;
    let pos = 0;
    let drawn = 0;
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
        case "return":
        case "enter":
          return list.length ? finish(list[pos]) : undefined;
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
    if (!t) return startIndex;
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= rows.length) return n - 1;
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
    return;
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
  conversation.record({ toolId: tool.id, toolLabel: tool.label, model, prompt, reply, sessionId: run.sessionId });
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
  console.log(dim("Runs with skip-permissions · Ctrl+C stops a turn · /model [name] switches · /effort [level] · /exit quits"));

  const settings = loadSettings();
  history.push(...settings.history);
  const conversation = createConversation();
  // A model is checked against its tool's list; a list that could not be read checks nothing,
  // so saved ids for that tool are kept until it can be.
  const listed = (toolId, model) => !model || !byId[toolId].models.length || tools.knownModel(byId[toolId], model);
  for (const tool of installed) {
    if (settings.recent[tool.id]) settings.recent[tool.id] = settings.recent[tool.id].filter((id) => listed(tool.id, id));
  }
  let current = settings.last && byId[settings.last.toolId] && listed(settings.last.toolId, settings.last.model) ? settings.last : null;

  // Ctrl+C outside a turn must not leave a half-drawn menu or a hung process.
  process.on("SIGINT", () => {});
  // A lone Esc is known only once no other byte follows it. 100 ms instead of Node's 500 ms
  // closes the menu promptly and keeps an Esc followed quickly by another key from merging
  // into one unknown key. The first call sets this for the menu and readline alike.
  if (interactive) readline.emitKeypressEvents(process.stdin, { escapeCodeTimeout: 100 });

  // The model menu; null when it is closed without a choice.
  const choose = async (filter = "") => {
    for (;;) {
      const rows = menuRows(installed, settings.recent);
      const start = currentIndex(rows, current);
      const picked = interactive ? await pickInteractive(rows, start, current, filter) : await pickNumbered(rows, start);
      if (picked === null) return null;
      filter = "";
      const row = rows[picked];
      if (row.kind !== "other") return { toolId: row.toolId, model: row.model };
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
    current = next;
    settings.last = current;
    const tool = byId[current.toolId];
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

  // Start on the last model; the menu opens only when there is none, or on /model.
  if (current) use(current);
  else {
    const first = await choose();
    if (!first) return;
    use(first);
  }

  for (;;) {
    const tool = byId[current.toolId];
    const head = `${st.fg(tool.color, `● ${current.model || "default"}${effort() ? ` · ${effort()}` : ""}`)} › `;
    let prompt;
    do prompt = await readPrompt(head);
    while (prompt === "");
    if (prompt === null) return;
    const command = parseCommand(prompt);
    if (command.kind === "exit") return;
    if (command.kind === "effort") {
      setEffort(command.arg);
      continue;
    }
    if (command.kind === "model") {
      const rows = menuRows(installed, settings.recent);
      const hit = matchRow(rows, command.arg, current);
      if (hit < 0 && command.arg && !render.filterRows(rows, command.arg).length) {
        console.log(red(`No model matches “${command.arg}”.`));
        continue;
      }
      const next = hit >= 0 ? { toolId: rows[hit].toolId, model: rows[hit].model } : await choose(command.arg);
      if (next) use(next);
      continue;
    }
    if (interactive) {
      settings.history = history.slice(0, HISTORY_MAX);
      saveSettings(settings);
    }
    await runTurn(tool, current.model, effort(), prompt, conversation);
  }
}

// Why a typed id is refused: it is not one of the tool's models.
function notListed(tool, id) {
  if (tool.id === "claude") return `“${id}” is not a Claude Code model. Use ${tool.models.map((m) => m.id).join(", ")} or a full name such as claude-opus-5-5.`;
  if (!tool.models.length) return `“${id}” cannot be checked: ${tool.label}'s model list could not be read.`;
  return `“${id}” is not in ${tool.label}'s model list.`;
}

// "/model" opens the menu and "/model <name>" switches straight to that model; "/effort"
// shows the effort and "/effort <level>" sets it. Only a one-line prompt is a command.
function parseCommand(line) {
  const t = String(line).trim();
  if (t === "/exit" || t === "/quit") return { kind: "exit" };
  const m = /^\/model(?:[ \t]+(.+))?$/.exec(t);
  if (m) return { kind: "model", arg: (m[1] || "").trim() };
  const e = /^\/effort(?:[ \t]+(.+))?$/.exec(t);
  if (e) return { kind: "effort", arg: (e[1] || "").trim().toLowerCase() };
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

module.exports = { main, parseCommand, askTerminal, readSettings, notListed };
