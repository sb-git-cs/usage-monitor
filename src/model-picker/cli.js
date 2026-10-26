const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const tools = require("./tools");
const { createConversation, menuRows, currentIndex } = require("./conversation");
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

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    const saved = Array.isArray(data.history) ? data.history.filter((x) => typeof x === "string" && x) : [];
    return { last: data.last || null, recent: data.recent && typeof data.recent === "object" ? data.recent : {}, history: saved.slice(0, HISTORY_MAX) };
  } catch {
    return { last: null, recent: {}, history: [] };
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
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, history, historySize: 100, removeHistoryDuplicates: true });
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => resolve(null));
    rl.question(text, (answer) => {
      rl.removeAllListeners("close");
      rl.close();
      // The interface may hold its own copy of the list, so make sure this line is in ours.
      if (answer.trim() && history[0] !== answer) history.unshift(answer);
      history.length = Math.min(history.length, 100);
      resolve(answer);
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

// Returns the chosen row index, or null to quit.
function pickInteractive(rows, startIndex, current) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let filter = "";
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
      stdin.setRawMode(false);
      stdin.pause();
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

async function runTurn(tool, model, prompt, conversation) {
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
  const label = `${tool.label} · ${model || "default"}`;

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
      const { args, stdin } = tools.buildArgv(tool.id, { model, sessionId: conversation.sessionFor(tool.id), prompt: text, promptFile });
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
  line(render.turnFooter({ elapsedMs, usage: r.usage, costUsd: r.costUsd, failed, ...fmt }));
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
  console.log(dim("Runs with skip-permissions · Ctrl+C stops a turn · /model switches · /exit quits"));

  const settings = loadSettings();
  history.push(...settings.history);
  const conversation = createConversation();
  let current = settings.last && byId[settings.last.toolId] ? settings.last : { toolId: installed[0].id, model: null };

  // Ctrl+C outside a turn must not leave a half-drawn menu or a hung process.
  process.on("SIGINT", () => {});

  for (;;) {
    const rows = menuRows(installed, settings.recent);
    const start = currentIndex(rows, current);
    const picked = interactive ? await pickInteractive(rows, start, current) : await pickNumbered(rows, start);
    if (picked === null) return;
    const row = rows[picked];
    let model = row.model;
    if (row.kind === "other") {
      const typed = await ask(`Model id for ${row.toolLabel}: `);
      if (typed === null) return;
      const id = typed.trim();
      if (!id) continue;
      if (!tools.validModelId(id)) {
        console.log(red("That model id has characters that are not allowed."));
        continue;
      }
      model = id;
      remember(settings, row.toolId, id);
    }
    current = { toolId: row.toolId, model };
    settings.last = current;
    saveSettings(settings);
    const chosen = `${row.toolLabel} · ${model || "default"}`;
    console.log(tty ? st.fg(row.color, `● ${chosen}`) : `Model: ${chosen}`);

    let prompt;
    const head = `${st.fg(row.color, "●")} › `;
    do prompt = await readPrompt(head);
    while (prompt === "");
    if (prompt === null) return;
    if (prompt === "/exit" || prompt === "/quit") return;
    if (prompt === "/model") continue;
    if (interactive) {
      settings.history = history.slice(0, HISTORY_MAX);
      saveSettings(settings);
    }
    await runTurn(byId[row.toolId], model, prompt, conversation);
  }
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

module.exports = { main };
