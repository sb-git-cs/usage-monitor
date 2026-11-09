const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSessionLog, resumeCommand, launchFlags, ID_RE, RESUME } = require("../src/session-log");

const NOW = Date.parse("2026-10-15T12:00:00Z");
const DAY = 86400_000;

function tmpfile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-session-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "recent-sessions.json");
}

const running = (id, extra = {}) => ({ key: `claude:${id}`, tool: "claude", cli: "claude", label: "Claude Code", name: "", cwd: "D:\\work\\api",
  id, started: NOW - 3600_000, godmode: false, pid: 1, ...extra });

test("a session closes only after two scans in a row miss it, and reopens when it shows again", (t) => {
  let at = NOW;
  const log = createSessionLog({ file: tmpfile(t), now: () => at });
  log.record([running("a1", { name: "Fix the parser", godmode: true })]);
  assert.deepEqual(log.recent(), []);
  assert.equal(log.get("claude:a1").source, "seen");
  at += 10_000;
  log.record([]);
  assert.equal(log.get("claude:a1").closed_at, null, "one miss is not enough");
  at += 10_000;
  log.record([running("a1")]);
  at += 10_000;
  log.record([]);
  assert.equal(log.get("claude:a1").closed_at, null, "the misses must be in a row");
  at += 10_000;
  log.record([]);
  const closed = log.get("claude:a1");
  assert.equal(closed.closed_at, at, "closed at the second miss");
  assert.equal(closed.last_active, at - 20_000);
  assert.equal(closed.name, "Fix the parser", "an empty name keeps the known title");
  assert.equal(closed.godmode, false, "the latest command line decides");
  assert.equal(closed.started, NOW - 3600_000);
  assert.deepEqual(log.recent().map((e) => e.key), ["claude:a1"]);
  at += 10_000;
  log.record([running("a1")]);
  assert.equal(log.get("claude:a1").closed_at, null);
  assert.deepEqual(log.recent(), []);
});

test("an entry with no title shows its folder, and sessions without an id are not logged", (t) => {
  const log = createSessionLog({ file: tmpfile(t), now: () => NOW });
  log.record([running("a1", { cwd: "D:\\work\\api\\" }), { ...running(null), key: "claude:x", id: null }]);
  assert.equal(log.size(), 1);
  assert.equal(log.get("claude:a1").name, "api");
  assert.equal(log.get("claude:a1").cwd, "D:\\work\\api");
  log.record([running("a2", { name: "x".repeat(200) })]);
  assert.equal(log.get("claude:a2").name.length, 80);
});

test("a session with no id takes over the one disk record of its CLI in that folder", (t) => {
  let at = NOW;
  const log = createSessionLog({ file: tmpfile(t), now: () => at, platform: "win32" });
  const disk = (id, cwd, last) => ({ tool: "gemini", cli: "agy", label: "Antigravity", name: `Conv ${id}`, cwd, id, started: null, last_active: last });
  log.seed([disk("c1", "D:\\Work\\Web", NOW - 1000), disk("c2", "D:\\work\\api", NOW - 1000), disk("old", "D:\\work\\web", NOW - DAY)]);
  assert.equal(log.get("gemini:c1").source, "disk");
  assert.equal(log.get("gemini:c1").closed_at, NOW - 1000, "a disk-only session counts as closed at its last activity");
  const agy = { key: "gemini:12:999", tool: "gemini", cli: "agy", label: "Antigravity", name: "", cwd: "d:/work/web/", id: null, started: NOW - 60_000, godmode: true, pid: 12 };
  log.record([agy]);
  const taken = log.get("gemini:c1");
  assert.deepEqual([taken.source, taken.closed_at, taken.godmode, taken.name], ["seen", null, true, "Conv c1"]);
  assert.equal(log.get("gemini:old").source, "disk", "a record from before it started is not its own");
  // It keeps that entry on the next scans, and closes it once it is gone.
  at += 10_000;
  log.record([agy]);
  at += 10_000;
  log.record([agy]);
  assert.equal(log.get("gemini:c1").closed_at, null);
  at += 10_000;
  log.record([]);
  log.record([]);
  assert.equal(log.get("gemini:c1").closed_at, null, "two misses within one scan interval are one look");
  at += 10_000;
  log.record([]);
  assert.ok(log.get("gemini:c1").closed_at);
  // Two candidates: it is a guess, so nothing is taken over.
  log.seed([disk("c3", "D:\\work\\api", at), disk("c4", "D:\\work\\api", at)]);
  log.record([{ ...agy, key: "gemini:13:1", cwd: "D:\\work\\api", started: at - 1000 }]);
  assert.deepEqual(["c2", "c3", "c4"].map((id) => log.get(`gemini:${id}`).source), ["disk", "disk", "disk"]);
});

test("seeding fills only what is missing and never closes a running session", (t) => {
  const log = createSessionLog({ file: tmpfile(t), now: () => NOW });
  log.record([running("a1", { cwd: "" })]);
  log.seed([{ tool: "claude", cli: "claude", label: "Claude Code", name: "Disk title", cwd: "D:\\work\\api", id: "a1", started: NOW - 7200_000, last_active: NOW + 5000 }]);
  const e = log.get("claude:a1");
  assert.deepEqual([e.name, e.cwd, e.started, e.closed_at, e.last_active], ["Disk title", "D:\\work\\api", NOW - 3600_000, null, NOW]);
  log.seed([{ tool: "claude", cli: "claude", name: "Other title", id: "a1", last_active: NOW }]);
  assert.equal(log.get("claude:a1").name, "Disk title");
  // A closed session used again elsewhere moves up.
  log.seed([{ tool: "codex", cli: "codex", name: "T", cwd: "D:\\x", id: "c1", last_active: NOW - DAY }]);
  log.seed([{ tool: "codex", cli: "codex", name: "T", cwd: "D:\\x", id: "c1", last_active: NOW - 1000 }]);
  assert.deepEqual([log.get("codex:c1").last_active, log.get("codex:c1").closed_at], [NOW - 1000, NOW - 1000]);
  // Malformed rows and ones older than a month are left out.
  log.seed([null, { tool: "codex", cli: "codex", id: "" , last_active: NOW }, { tool: "codex", cli: "codex", id: "c2" }, { tool: "codex", cli: "codex", id: "c3", last_active: NOW - 31 * DAY }]);
  assert.equal(log.size(), 2);
});

test("old entries and those past the caps are pruned, running ones last", (t) => {
  const file = tmpfile(t);
  const log = createSessionLog({ file, now: () => NOW, maxPerTool: 3, maxTotal: 5, maxAgeMs: 10 * DAY, saveGapMs: 0 });
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push({ tool: "claude", cli: "claude", id: `c${i}`, cwd: "D:\\x", last_active: NOW - (i + 1) * 60_000 });
  for (let i = 0; i < 3; i++) rows.push({ tool: "codex", cli: "codex", id: `x${i}`, cwd: "D:\\x", last_active: NOW - (i + 1) * 30_000 });
  log.record([running("live", { started: NOW - 20 * DAY })]);
  log.seed(rows);
  // The running session first, then the newest: three per tool at most, five in all.
  assert.deepEqual(log.list().map((e) => e.key).sort(), ["claude:c0", "claude:live", "codex:x0", "codex:x1", "codex:x2"]);
  const wide = createSessionLog({ file: tmpfile(t), now: () => NOW, maxPerTool: 3, maxTotal: 100 });
  wide.record([running("live", { started: NOW - 20 * DAY })]);
  wide.seed(rows);
  assert.deepEqual(wide.list().map((e) => e.key).filter((k) => k.startsWith("claude:")).sort(), ["claude:c0", "claude:c1", "claude:live"]);
  // Past the age limit it goes, on load as well: a session left open at the last quit closed then too.
  const later = createSessionLog({ file, now: () => NOW + 11 * DAY, maxAgeMs: 10 * DAY });
  assert.deepEqual(later.list().map((e) => e.key), []);
  const soon = createSessionLog({ file, now: () => NOW + 9 * DAY, maxAgeMs: 10 * DAY });
  assert.equal(soon.get("claude:live").closed_at, NOW);
});

test("a session still open at the last quit is listed as closed at its last activity", (t) => {
  const file = tmpfile(t);
  const log = createSessionLog({ file, now: () => NOW });
  log.record([running("open", { name: "Wire up the exporter" })]);
  log.flush();
  assert.equal(log.get("claude:open").closed_at, null);
  // The app starts again later: the session was not seen since, so it closed with that shutdown.
  const next = createSessionLog({ file, now: () => NOW + 3600_000 });
  assert.deepEqual(next.recent().map((e) => [e.key, e.closed_at, e.last_active]), [["claude:open", NOW, NOW]]);
  // Only the last few sessions are kept by default.
  const small = createSessionLog({ file: tmpfile(t), now: () => NOW });
  small.seed(Array.from({ length: 12 }, (_, i) => ({ tool: i % 2 ? "codex" : "claude", cli: i % 2 ? "codex" : "claude", id: `s${i}`, cwd: "D:\\x", last_active: NOW - i * 60_000 })));
  assert.equal(small.size(), 8);
  assert.equal(small.list().filter((e) => e.tool === "claude").length, 4);
});

test("a missing, corrupt or partly malformed file loads as what can be read", (t) => {
  const file = tmpfile(t);
  assert.equal(createSessionLog({ file, now: () => NOW }).size(), 0);
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(createSessionLog({ file, now: () => NOW }).list(), []);
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [null, 5, { tool: "claude" }, { tool: "claude", cli: "claude", id: "ok", cwd: "D:\\x", last_active: NOW, closed_at: NOW }] }));
  const log = createSessionLog({ file, now: () => NOW });
  assert.deepEqual(log.list().map((e) => e.key), ["claude:ok"]);
});

test("nothing is read until the log is used, and saves replace the file through a temporary one", (t) => {
  const file = tmpfile(t);
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (p, ...rest) => { if (String(p) === file) reads++; return realRead(p, ...rest); };
  t.after(() => { fs.readFileSync = realRead; });
  const log = createSessionLog({ file, now: () => NOW });
  assert.equal(reads, 0);
  log.record([running("a1", { name: "Saved" })]);
  assert.equal(reads, 1);
  const data = JSON.parse(realRead(file, "utf8"));
  assert.equal(data.version, 1);
  assert.deepEqual(data.entries.map((e) => [e.key, e.name, e.source]), [["claude:a1", "Saved", "seen"]]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["recent-sessions.json"], "no .tmp is left behind");
  log.clear();
  assert.deepEqual(JSON.parse(realRead(file, "utf8")).entries, [], "clear saves at once");
});

test("a cleared session does not come back from the disk records unless it is used again", (t) => {
  const file = tmpfile(t);
  let at = NOW;
  const disk = (id, last) => ({ tool: "codex", cli: "codex", name: "T", cwd: "D:\\x", id, last_active: last });
  const log = createSessionLog({ file, now: () => at });
  log.seed([disk("c1", NOW - 1000)]);
  log.clear();
  at += 60_000;
  log.seed([disk("c1", NOW - 1000)]);
  assert.equal(log.size(), 0);
  // The clear is kept across restarts, and a session used after it is listed again.
  const reopened = createSessionLog({ file, now: () => at });
  reopened.seed([disk("c1", NOW - 1000), disk("c2", at - 1000)]);
  assert.deepEqual(reopened.list().map((e) => e.key), ["codex:c2"]);
});

test("saves are throttled and flush writes what is pending", (t) => {
  const file = tmpfile(t);
  let at = NOW;
  const log = createSessionLog({ file, now: () => at, saveGapMs: 5000 });
  const saved = () => JSON.parse(fs.readFileSync(file, "utf8")).entries.map((e) => e.key);
  log.record([running("a1")]);
  assert.deepEqual(saved(), ["claude:a1"]);
  at += 1000;
  log.record([running("a1"), running("a2")]);
  assert.deepEqual(saved(), ["claude:a1"], "within the gap nothing is written");
  at += 5000;
  log.record([running("a1"), running("a2"), running("a3")]);
  assert.equal(saved().length, 3);
  at += 1000;
  log.remove("claude:a3");
  assert.equal(saved().length, 3);
  log.flush();
  assert.deepEqual(saved().sort(), ["claude:a1", "claude:a2"]);
  // A running session only seen again is written at most once a minute.
  const mtime = fs.statSync(file).mtimeMs;
  at += 10_000;
  log.record([running("a1"), running("a2")]);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test("each CLI reopens a session by id, with its skip-permissions flag only when the session had it", () => {
  const cases = {
    claude: [["--resume", "abc"], "--dangerously-skip-permissions"],
    codex: [["resume", "abc"], "--dangerously-bypass-approvals-and-sandbox"],
    grok: [["--resume", "abc"], "--always-approve"],
    agy: [["--conversation", "abc"], "--dangerously-skip-permissions"],
    gemini: [["--resume", "abc"], "--approval-mode=yolo"],
    "cursor-agent": [["--resume", "abc"], "--force"],
    copilot: [["--resume=abc"], "--allow-all-tools"],
    windsurf: [["-r", "abc"], null],
    kiro: [["chat", "--resume-id", "abc"], null],
    amp: [["threads", "continue", "abc"], null],
    opencode: [["--session", "abc"], null],
    qwen: [["--resume", "abc"], "--approval-mode=yolo"],
    kimi: [["--session", "abc"], null],
  };
  assert.deepEqual(Object.keys(RESUME).sort(), Object.keys(cases).sort());
  for (const [cli, [args, flag]] of Object.entries(cases)) {
    const entry = { cli, id: "abc", name: "Fix it", cwd: "D:\\x", godmode: false };
    const plain = resumeCommand(entry);
    assert.deepEqual(plain, { label: RESUME[cli].label, title: `${RESUME[cli].label} · Fix it`, file: RESUME[cli].file, args }, cli);
    assert.deepEqual(resumeCommand({ ...entry, godmode: true }).args, flag ? [...args, flag] : args, cli);
  }
  assert.deepEqual(resumeCommand({ cli: "codex", id: "01a1-x", godmode: true }).args, ["resume", "01a1-x", "--dangerously-bypass-approvals-and-sandbox"]);
  assert.equal(resumeCommand({ cli: "codex", id: "01a1-x", cwd: "D:\\work\\api" }).title, "Codex · api");
  assert.equal(resumeCommand({ cli: "claude", id: "a", name: 'x" & del *' }).title, "Claude Code · x del *", "no cmd.exe syntax in the title");
  for (const id of ["", "-rf", "a b", "a&b", "a\"b", "x".repeat(129), null, 5]) assert.equal(resumeCommand({ cli: "claude", id }), null, String(id));
  assert.equal(resumeCommand({ cli: "notepad", id: "abc" }), null);
  assert.equal(resumeCommand({ cli: "constructor", id: "abc" }), null);
  assert.equal(resumeCommand(null), null);
  assert.ok(ID_RE.test("01a188f6-bcfe-7fe2-a953-13266cc538e7"));
});

test("a command line tells whether it skipped permissions and which session it resumed", () => {
  const godmode = {
    claude: ["--dangerously-skip-permissions", "--permission-mode bypassPermissions", "--permission-mode=bypassPermissions"],
    agy: ["--dangerously-skip-permissions", "--permission-mode bypassPermissions"],
    codex: ["--dangerously-bypass-approvals-and-sandbox", "--yolo"],
    grok: ["--always-approve", "--permission-mode bypassPermissions"],
    "cursor-agent": ["--force", "-f", "--yolo"],
    copilot: ["--allow-all-tools", "--allow-all", "--yolo"],
    gemini: ["--yolo", "-y", "--approval-mode=yolo", "--approval-mode yolo"],
  };
  for (const [cli, spellings] of Object.entries(godmode)) {
    for (const flag of spellings) assert.equal(launchFlags(cli, `"C:\\bin\\${cli}.exe" -m x ${flag}`).godmode, true, `${cli} ${flag}`);
    assert.equal(launchFlags(cli, `"C:\\bin\\${cli}.exe" -m x`).godmode, false, cli);
  }
  assert.equal(launchFlags("claude", "claude --permission-mode plan").godmode, false);
  assert.equal(launchFlags("codex", "codex --force").godmode, false, "another CLI's flag does not count");
  assert.equal(launchFlags("gemini", "gemini --approval-mode default").godmode, false);
  // The program itself is not an argument, even when its path holds a flag-like word.
  assert.equal(launchFlags("cursor-agent", '"C:\\tools\\--force\\cursor-agent.exe"').godmode, false);
  assert.deepEqual(launchFlags("codex", '"C:\\Codex\\codex.exe" resume 01a1-x --yolo'), { godmode: true, resumed: "01a1-x" });
  assert.equal(launchFlags("codex", "codex resume --last").resumed, null);
  assert.equal(launchFlags("claude", "claude --resume abc-1").resumed, "abc-1");
  assert.equal(launchFlags("claude", "claude -r abc-2").resumed, "abc-2");
  assert.equal(launchFlags("copilot", "copilot --resume=abc-3").resumed, "abc-3");
  assert.equal(launchFlags("agy", "agy --conversation abc-4").resumed, "abc-4");
  assert.equal(launchFlags("claude", "claude --continue").resumed, null);
  assert.equal(launchFlags("claude", "claude").resumed, null);
  assert.deepEqual(launchFlags("unknown", "x --yolo --resume a"), { godmode: false, resumed: "a" });
});
