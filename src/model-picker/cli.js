const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const tools = require("./tools");
const { createConversation, menuRows, currentIndex } = require("./conversation");

const RECENT_MAX = 10;
const useColor = !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2");
const red = paint("31");
const dimRed = paint("2;31");
const yellow = paint("33");
const bold = paint("1");

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
    return { last: data.last || null, recent: data.recent && typeof data.recent === "object" ? data.recent : {} };
  } catch {
    return { last: null, recent: {} };
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
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => resolve(null));
    rl.question(text, (answer) => {
      rl.removeAllListeners("close");
      rl.close();
      resolve(answer);
    });
  });
}

async function readPrompt() {
  const lines = [];
  for (;;) {
    const line = await ask(lines.length ? "  " : "› ");
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

function clip(text, width) {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

// Returns the chosen row index, or null to quit.
function pickInteractive(rows, startIndex) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let filter = "";
    let pos = 0;
    let drawn = 0;
    const visible = () => {
      const f = filter.toLowerCase();
      return rows.map((_, i) => i).filter((i) => rows[i].search.toLowerCase().includes(f));
    };
    pos = Math.max(0, visible().indexOf(startIndex));

    const draw = () => {
      const list = visible();
      pos = Math.min(pos, Math.max(0, list.length - 1));
      const width = (process.stdout.columns || 80) - 1;
      const height = Math.max(3, Math.min(list.length || 1, (process.stdout.rows || 24) - 4));
      const top = Math.max(0, Math.min(pos - Math.floor(height / 2), list.length - height));
      const lines = [dim(clip(`Pick a model · type to filter · Enter selects · Esc quits`, width))];
      lines.push(`Filter: ${filter}`);
      if (!list.length) lines.push(dim("  (no match)"));
      for (let k = top; k < Math.min(list.length, top + height); k++) {
        const text = clip(rows[list[k]].text, width - 2);
        lines.push(k === pos ? bold(`› ${text}`) : `  ${text}`);
      }
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
  const run = { texts: [], printed: false, result: null, sessionId: null, atLineStart: true, stopped: false, spawnError: null };
  const write = (s, style) => {
    if (!s) return;
    process.stdout.write(style ? style(s) : s);
    run.atLineStart = s.endsWith("\n");
  };
  const line = (s, style) => {
    if (!run.atLineStart) write("\n");
    write(`${s}\n`, style);
  };
  const parse = tools.createParser(tool.id);
  const handle = (l) => {
    for (const ev of parse(l)) {
      if (ev.kind === "session") run.sessionId = ev.id;
      else if (ev.kind === "text") {
        run.texts.push(ev.text);
        run.printed = true;
        write(ev.text);
      } else if (ev.kind === "tool") line(`  • ${ev.text}`, dim);
      else if (ev.kind === "note") line(ev.text, yellow);
      else if (ev.kind === "raw") line(ev.text, dim);
      else if (ev.kind === "result") run.result = ev;
    }
  };

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

  if (run.stopped) {
    line("Stopped.", dim);
    return;
  }
  const reply = (run.result && run.result.text) || run.texts.join("");
  if (!run.printed && run.result && run.result.text) line(run.result.text);
  if (run.spawnError && !run.result) line(`${tool.label} stopped: ${run.spawnError}`, red);
  else if (run.result && run.result.error) line(`${tool.label} stopped: ${run.result.text || "error"}`, red);
  else if (!run.result && exit !== 0) line(`${tool.label} stopped: exit code ${exit}`, red);
  line(`— ${tool.label} · ${model || "default"} · ${((Date.now() - started) / 1000).toFixed(1)} s`, dim);
  conversation.record({ toolId: tool.id, toolLabel: tool.label, model, prompt, reply, sessionId: run.sessionId });
}

// ---- main ----

async function main() {
  const cwd = process.cwd();
  console.log(`${bold("Model picker")} · ${cwd}`);
  console.log(dim("Each turn runs with the tool's skip-permissions flag. Ctrl+C stops a turn; Esc quits from the menu."));

  const found = tools.TOOLS.map((t) => ({ ...t, exe: tools.findExecutable(t.id) })).filter((t) => t.exe);
  if (!found.length) {
    console.error(`No coding CLI found. Looked for: ${tools.TOOLS.map((t) => t.file).join(", ")}`);
    process.exit(1);
  }

  console.log(dim("Loading models…"));
  const lists = await Promise.all(found.map((t) => tools.loadModels(t.id, { exe: t.exe })));
  const installed = found.map((t, i) => ({ ...t, models: lists[i] }));
  const byId = Object.fromEntries(installed.map((t) => [t.id, t]));

  const settings = loadSettings();
  const conversation = createConversation();
  let current = settings.last && byId[settings.last.toolId] ? settings.last : { toolId: installed[0].id, model: null };

  // Ctrl+C outside a turn must not leave a half-drawn menu or a hung process.
  process.on("SIGINT", () => {});

  for (;;) {
    const rows = menuRows(installed, settings.recent);
    const start = currentIndex(rows, current);
    const picked = interactive ? await pickInteractive(rows, start) : await pickNumbered(rows, start);
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
    console.log(`Model: ${row.toolLabel} · ${model || "default"}`);

    let prompt;
    do prompt = await readPrompt();
    while (prompt === "");
    if (prompt === null) return;
    if (prompt === "/exit" || prompt === "/quit") return;
    if (prompt === "/model") continue;
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
