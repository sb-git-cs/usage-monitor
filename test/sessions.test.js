const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createWatcher, claudeState, codexState, resumeStatus, matchCodex, isCodexTui, filetimeMs, clockAfter,
  GRACE_MS, MAX_ATTEMPTS, RETRY_MS, LIMIT_ON_SCREEN,
  otherCli, isOtherTui, resetOnScreen, grokState, OTHER_CLIS, OTHER_LIMIT_ON_SCREEN, OTHER_LINES,
} = require("../src/sessions");
const config = require("../src/config");

const NOW = Date.parse("2026-10-15T12:00:00Z");
const toFiletime = (ms) => String((BigInt(ms) + 11644473600000n) * 10000n);

function limitEntry(resetsAt, extra = {}) {
  return { type: "assistant", isSidechain: false, error: "rate_limit", isApiErrorMessage: true,
    quotaLimits: { status: "rejected", resetsAt, rateLimitType: "five_hour" }, message: { content: [{ type: "text", text: "You've hit your session limit" }] }, ...extra };
}

test("a Claude session is stopped by a limit only while the rejected-quota error is its last entry", () => {
  assert.deepEqual(claudeState([{ type: "user" }, limitEntry(1789749600), { type: "system" }, { type: "file-history-snapshot" }]),
    { limited: true, resets_at: 1789749600000, limit: "five_hour" });
  assert.equal(claudeState([limitEntry(1789749600), { type: "user", message: { content: "continue" } }]).limited, false);
  assert.equal(claudeState([limitEntry(1789749600), { type: "assistant", isSidechain: true }]).limited, true);
  // A retryable rate limit (not a used-up plan) is not a stop.
  assert.equal(claudeState([limitEntry(1789749600, { quotaLimits: { status: "allowed_warning", resetsAt: 1 } })]).limited, false);
  assert.equal(claudeState([]).limited, false);
});

test("a Codex turn that ended at its usage limit reports the window's reset", () => {
  const tokens = { type: "event_msg", payload: { type: "token_count", rate_limits: {
    primary: { used_percent: 100, window_minutes: 300, resets_at: 1792074052 }, secondary: { used_percent: 40, resets_at: 1792660852 } } } };
  const done = { type: "event_msg", timestamp: "2026-09-14T10:16:52.756Z", payload: { type: "task_complete",
    error: { message: "You've hit your usage limit. ... or try again at 6:05 PM.", codex_error_info: "usage_limit_exceeded" } } };
  const started = { type: "event_msg", payload: { type: "task_started" } };
  const late = { type: "event_msg", payload: { type: "item_completed" } };
  assert.deepEqual(codexState([started, tokens, done, late]), { limited: true, busy: false, resets_at: 1792074052000, limit: "five_hour" });
  // Both windows used up: the 5-hour one is what resumes, not the weekly reset days later.
  const both = { type: "event_msg", payload: { type: "token_count", rate_limits: {
    primary: { used_percent: 100, window_minutes: 300, resets_at: 1792074052 },
    secondary: { used_percent: 100, window_minutes: 10080, resets_at: 1792660852 } } } };
  const unnamed = { ...done, payload: { ...done.payload, error: { message: "You've hit your usage limit.", codex_error_info: "usage_limit_exceeded" } } };
  assert.equal(codexState([started, both, unnamed, late]).resets_at, 1792074052000);
  assert.equal(codexState([started, both, unnamed, late]).limit, "five_hour");
  // The message names the later window, so that reset is the one to wait for.
  const weekAt = 1792660852;
  const namedTokens = { type: "event_msg", payload: { type: "token_count", rate_limits: {
    primary: { used_percent: 100, window_minutes: 300, resets_at: 1792074052 },
    secondary: { used_percent: 100, window_minutes: 10080, resets_at: weekAt } } } };
  const namedAt = new Date(weekAt * 1000);
  const hh = namedAt.getHours() % 12 || 12;
  const mm = String(namedAt.getMinutes()).padStart(2, "0");
  const ap = namedAt.getHours() >= 12 ? "PM" : "AM";
  const named = { ...done, timestamp: new Date(weekAt * 1000 - 60_000).toISOString(), payload: { ...done.payload,
    error: { message: `You've hit your usage limit. try again at ${hh}:${mm} ${ap}.`, codex_error_info: "usage_limit_exceeded" } } };
  assert.equal(codexState([started, namedTokens, named]).resets_at, weekAt * 1000);
  assert.equal(codexState([started, namedTokens, named]).limit, "weekly");
  assert.deepEqual(codexState([started, tokens, done, started]), { limited: false, busy: true });
  assert.deepEqual(codexState([started, { type: "event_msg", payload: { type: "task_complete" } }]), { limited: false, busy: false });
  // Without reported limits the clock time in the message is used.
  const fallback = codexState([started, done]);
  assert.equal(fallback.limited, true);
  assert.equal(new Date(fallback.resets_at).getHours(), 18);
  assert.equal(new Date(fallback.resets_at).getMinutes(), 5);
  assert.ok(fallback.resets_at > Date.parse(done.timestamp));
});

test("the terminal must show the limit message that stopped it", () => {
  const onScreen = new RegExp(LIMIT_ON_SCREEN, "i");
  for (const shown of ["  ⎿  You've hit your session limit · resets 10:10pm (Asia/Kolkata)", "5-hour limit reached ∙ resets 3pm",
    "Claude AI usage limit reached|1789749600", "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 6:05 PM."]) {
    assert.match(shown, onScreen);
  }
  for (const other of ["❯ Try \"fix typecheck errors\"", "• You ran echo hello", "rate limit headers parsed", "› Ask Codex to do anything"]) {
    assert.doesNotMatch(other, onScreen);
  }
});

test("clock times in Codex messages resolve to the next occurrence", () => {
  const after = new Date(2026, 9, 15, 23, 50).getTime();
  assert.equal(clockAfter("try again at 12:10 AM", after), new Date(2026, 9, 16, 0, 10).getTime());
  assert.equal(clockAfter("no time here", after), null);
});

test("resume waits for the reset plus grace, the meters and the retry gap", () => {
  const s = { tool: "claude", can_type: true, resets_at: NOW };
  const ctx = { enabled: true, platform: "win32", now: NOW + GRACE_MS, snapshot: null };
  assert.equal(resumeStatus(s, null, { ...ctx, platform: "linux" }), "manual");
  assert.equal(resumeStatus({ ...s, can_type: false }, null, ctx), "manual");
  assert.equal(resumeStatus(s, null, { ...ctx, enabled: false }), "off");
  assert.equal(resumeStatus(s, null, { ...ctx, now: NOW + GRACE_MS - 1 }), "scheduled");
  assert.equal(resumeStatus({ ...s, resets_at: null }, null, ctx), "scheduled");
  assert.equal(resumeStatus(s, null, ctx), "due");
  const spent = { providers: [{ id: "claude", status: { state: "ok" }, windows: [{ used_pct: 100, resets_at: new Date(NOW + 3600_000).toISOString() }] }] };
  assert.equal(resumeStatus(s, null, { ...ctx, snapshot: spent }), "pending");
  assert.equal(resumeStatus(s, null, { ...ctx, snapshot: { providers: [{ ...spent.providers[0], status: { state: "stale" } }] } }), "due");
  assert.equal(resumeStatus(s, { count: 1, last: ctx.now, sent: true }, ctx), "sent");
  assert.equal(resumeStatus(s, { count: 1, last: ctx.now - 1000, sent: false }, ctx), "retrying");
  assert.equal(resumeStatus(s, { count: 1, last: ctx.now - RETRY_MS, sent: false }, ctx), "due");
  assert.equal(resumeStatus(s, { count: MAX_ATTEMPTS, last: 0, sent: false }, ctx), "failed");
});

test("a 5-hour limit resumes when that window resets, even if the weekly window is still full", () => {
  const s = { tool: "claude", can_type: true, resets_at: NOW, limit: "five_hour" };
  const ctx = { enabled: true, platform: "win32", now: NOW + GRACE_MS };
  const held = { providers: [{ id: "claude", status: { state: "ok" }, windows: [
    { kind: "five_hour", used_pct: 100, resets_at: new Date(NOW + 3600_000).toISOString() },
    { kind: "weekly", used_pct: 10, resets_at: new Date(NOW + 5 * 86400_000).toISOString() },
  ] }] };
  assert.equal(resumeStatus(s, null, { ...ctx, snapshot: held }), "pending");
  const cleared = { providers: [{ id: "claude", status: { state: "ok" }, windows: [
    { kind: "five_hour", used_pct: 4, resets_at: new Date(NOW + 5 * 3600_000).toISOString() },
    { kind: "weekly", used_pct: 100, resets_at: new Date(NOW + 5 * 86400_000).toISOString() },
  ] }] };
  assert.equal(resumeStatus(s, null, { ...ctx, snapshot: cleared }), "due");
  // A weekly stop still waits on the weekly window.
  const week = { ...s, limit: "seven_day", resets_at: NOW };
  assert.equal(resumeStatus(week, null, { ...ctx, snapshot: cleared }), "pending");
});

test("only interactive codex invocations count as terminal sessions", () => {
  assert.equal(isCodexTui({ cmd: '"C:\\Codex\\bin\\codex.exe" ' }), true);
  assert.equal(isCodexTui({ cmd: '"C:\\Codex\\bin\\codex.exe" resume 01a13f7c-406b-70f2-aba7-5ad85ba9cc19' }), true);
  assert.equal(isCodexTui({ cmd: "codex -m gpt-6 fix the build" }), true);
  assert.equal(isCodexTui({ cmd: '"\\\\?\\C:\\x\\codex.exe" app-server --listen unix:// --managed-daemon' }), false);
  assert.equal(isCodexTui({ cmd: "codex exec run tests" }), false);
  assert.equal(isCodexTui({ cmd: "codex --version" }), false);
});

test("codex processes pair with their own rollout, never a guess between two", () => {
  const procs = [
    { pid: 1, cwd: "D:\\work\\a\\", started: NOW, cmd: "codex" },
    { pid: 2, cwd: "D:\\work\\b", started: NOW, cmd: "codex resume 11111111-2222-3333-4444-555555555555" },
    { pid: 3, cwd: "D:\\work\\c", started: NOW, cmd: "codex" },
    { pid: 4, cwd: "D:\\work\\c", started: NOW + 300_000, cmd: "codex" },
  ];
  const rollouts = [
    { file: "a", id: "a1", cwd: "D:\\Work\\A", created: NOW - 86400_000, mtime: NOW + 5000 },
    { file: "b", id: "11111111-2222-3333-4444-555555555555", cwd: "D:\\work\\b", created: NOW - 86400_000, mtime: NOW + 5000 },
    { file: "c", id: "c1", cwd: "D:\\work\\c", created: NOW - 86400_000, mtime: NOW + 9000 },
  ];
  const m = matchCodex(procs, rollouts, "win32");
  assert.equal(m.get(1).id, "a1"); // the only codex in that folder
  assert.equal(m.get(2).file, "b"); // named on the command line
  assert.equal(m.has(3), false); // two in one folder and neither started that thread
  assert.equal(m.has(4), false);
  const fresh = matchCodex(procs.slice(2), [{ file: "c2", id: "c2", cwd: "D:\\work\\c", created: NOW + 301_500, mtime: NOW + 309_000 }, ...rollouts.slice(2)], "win32");
  assert.equal(fresh.get(4).id, "c2"); // created as that process started
  assert.equal(fresh.get(3).id, "c1"); // then the only one left in that folder
  // Started a second apart, either process could have created it.
  const close = [{ ...procs[2] }, { ...procs[3], started: NOW + 1000 }];
  assert.equal(matchCodex(close, [{ file: "c3", id: "c3", cwd: "D:\\work\\c", created: NOW + 1500, mtime: NOW + 9000 }], "win32").size, 0);
});

test("FILETIME process start times convert to milliseconds", () => {
  assert.equal(filetimeMs("134365393586773509"), 1792065758677);
  assert.ok(Number.isNaN(filetimeMs("not a number")));
});

test("auto-resume is opt-in and the sessions chip is on by default", () => {
  const cfg = config.normalize({});
  assert.equal(cfg.auto_resume, false);
  assert.equal("godmode" in cfg, false);
  assert.equal(cfg.chips_show.sessions, true);
  assert.equal(config.normalize({ auto_resume: "yes" }).auto_resume, false);
  assert.equal(config.normalize({ auto_resume: true }).auto_resume, true);
  assert.equal("godmode" in config.normalize({ godmode: true }), false);
  assert.equal("godmode" in config.normalize({ godmode: "yes" }), false);
});

// ---- the watcher on temporary folders, with a fake terminal helper ----------------------

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "um-sessions-"));
}

function claudeFixture({ pid = 4242, start = toFiletime(NOW - 3600_000), status = "idle", entrypoint = "cli", entries }) {
  const dir = tmpdir();
  const id = "dc08e9b8-c071-4f61-83f5-2ac3413ea0df";
  const cwd = "D:\\git\\usage_monitor";
  fs.mkdirSync(path.join(dir, "sessions"));
  fs.writeFileSync(path.join(dir, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd, procStart: start, kind: "interactive", entrypoint, name: "usage-monitor-94", status, startedAt: NOW - 3600_000 }));
  // A stale record of a process that is gone.
  fs.writeFileSync(path.join(dir, "sessions", "4194301.json"), JSON.stringify({ pid: 4194301, sessionId: "gone", cwd, procStart: "1", kind: "interactive", entrypoint: "cli", status: "idle" }));
  const project = path.join(dir, "projects", "D--git-usage-monitor");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { dir, pid, start };
}

function fakeHelper(procs, typeResult = () => ({ ok: true }), shows = () => false) {
  const typed = [];
  const peeked = [];
  const request = async (req) => {
    if (req.op === "scan") return { procs: procs() };
    if (req.op === "peek") {
      peeked.push(req);
      return { shown: shows(req) };
    }
    typed.push(req);
    return typeResult(req);
  };
  return { request, typed, peeked };
}

test("a stopped Claude session in an open terminal gets continue typed once after the reset", async () => {
  const fx = claudeFixture({ entries: [{ type: "user" }, limitEntry((NOW - GRACE_MS - 1000) / 1000)] });
  const helper = fakeHelper(() => [{ pid: fx.pid, name: "claude", start: fx.start }]);
  const resumed = [];
  const w = createWatcher({ getConfig: () => ({ auto_resume: true }), platform: "win32", now: () => NOW, request: helper.request,
    claudeDir: () => fx.dir, codexDir: () => path.join(fx.dir, "none"), onResume: (s, a) => resumed.push([s.key, a.sent]) });
  const first = await w.scan();
  assert.deepEqual(helper.typed, [{ op: "type", pid: fx.pid, start: fx.start, text: "continue", expect: LIMIT_ON_SCREEN }]);
  assert.deepEqual(resumed, [["claude:dc08e9b8-c071-4f61-83f5-2ac3413ea0df", true]]);
  assert.equal(first.sessions.length, 1); // the stale record is not listed
  assert.equal(first.sessions[0].resume, "sent");
  assert.equal(first.sessions[0].resets_at, new Date(NOW - GRACE_MS - 1000).toISOString());
  assert.equal("pid" in first.sessions[0], false);
  await w.scan();
  assert.equal(helper.typed.length, 1);
});

test("nothing is typed when the terminal closed, the process id was reused, or the session is busy", async () => {
  const entries = [limitEntry((NOW - GRACE_MS - 1000) / 1000)];
  for (const [label, procs, fixture] of [
    ["closed", () => [], {}],
    ["reused", (fx) => [{ pid: fx.pid, name: "notepad", start: toFiletime(NOW - 60_000) }], {}],
    ["busy", (fx) => [{ pid: fx.pid, name: "claude", start: fx.start }], { status: "busy" }],
    ["no terminal", (fx) => [{ pid: fx.pid, name: "claude", start: fx.start }], { entrypoint: "claude-vscode" }],
  ]) {
    const fx = claudeFixture({ entries, ...fixture });
    const helper = fakeHelper(() => procs(fx));
    const w = createWatcher({ getConfig: () => ({ auto_resume: true }), platform: "win32", now: () => NOW, request: helper.request,
      claudeDir: () => fx.dir, codexDir: () => path.join(fx.dir, "none") });
    const view = await w.scan();
    assert.equal(helper.typed.length, 0, label);
    if (label === "closed" || label === "reused") assert.equal(view.sessions.length, 0, label);
    if (label === "busy") assert.equal(view.sessions[0].state, "working");
    if (label === "no terminal") assert.equal(view.sessions[0].resume, "manual");
  }
});

test("with auto-resume off or the reset still ahead, the session waits and shows when", async () => {
  const fx = claudeFixture({ entries: [limitEntry((NOW + 3600_000) / 1000)] });
  const helper = fakeHelper(() => [{ pid: fx.pid, name: "claude", start: fx.start }]);
  let enabled = false;
  const w = createWatcher({ getConfig: () => ({ auto_resume: enabled }), platform: "win32", now: () => NOW, request: helper.request,
    claudeDir: () => fx.dir, codexDir: () => path.join(fx.dir, "none") });
  assert.equal((await w.scan()).sessions[0].resume, "off");
  enabled = true;
  const view = await w.scan();
  assert.equal(view.sessions[0].resume, "scheduled");
  assert.equal(view.sessions[0].resume_at, new Date(NOW + 3600_000 + GRACE_MS).toISOString());
  assert.equal(helper.typed.length, 0);
});

test("a switch flipped during a scan shows at once, and a refresh asked for then runs after it", async () => {
  const fx = claudeFixture({ entries: [limitEntry((NOW + 3600_000) / 1000)] });
  let enabled = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let scans = 0;
  const views = [];
  const request = async (req) => {
    if (req.op !== "scan") return { ok: true };
    scans++;
    if (scans === 1) await gate;
    return { procs: [{ pid: fx.pid, name: "claude", start: fx.start }] };
  };
  const w = createWatcher({ getConfig: () => ({ auto_resume: enabled }), platform: "win32", now: () => NOW, request,
    claudeDir: () => fx.dir, codexDir: () => path.join(fx.dir, "none"), onChange: (v) => views.push(v) });
  const first = w.scan();
  await new Promise((resolve) => setImmediate(resolve));
  enabled = true;
  await w.scan(); // asked for while the first scan waits on the helper
  release();
  assert.equal((await first).auto_resume, true, "the view reflects the switch as it is now");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(scans, 2, "the refresh asked for during the scan runs once it finishes");
  assert.equal(views.at(-1).sessions[0].resume, "scheduled");
});

test("a terminal that refuses input is retried a minute apart, then reported failed", async () => {
  const fx = claudeFixture({ entries: [limitEntry((NOW - GRACE_MS - 1000) / 1000)] });
  const helper = fakeHelper(() => [{ pid: fx.pid, name: "claude", start: fx.start }], () => ({ ok: false, error: "no console (6)" }));
  let t = NOW;
  const reports = [];
  const w = createWatcher({ getConfig: () => ({ auto_resume: true }), platform: "win32", now: () => t, request: helper.request,
    claudeDir: () => fx.dir, codexDir: () => path.join(fx.dir, "none"), onResume: (_s, a) => reports.push(a.count) });
  assert.equal((await w.scan()).sessions[0].resume, "retrying");
  t += 1000;
  await w.scan();
  assert.equal(helper.typed.length, 1);
  for (let i = 0; i < 4; i++) {
    t += RETRY_MS;
    await w.scan();
  }
  assert.equal(helper.typed.length, MAX_ATTEMPTS);
  assert.deepEqual(reports, [1, 2, 3]);
  assert.equal(w.view().sessions[0].resume, "failed");
});

test("macOS and Linux list live Claude sessions but never type", async () => {
  const fx = claudeFixture({ pid: process.pid, entries: [limitEntry((NOW - GRACE_MS - 1000) / 1000)] });
  let asked = 0;
  const w = createWatcher({ getConfig: () => ({ auto_resume: true }), platform: "linux", now: () => NOW, request: async () => { asked++; return {}; },
    claudeDir: () => fx.dir, codexDir: () => path.join(fx.dir, "none"), grokDir: () => path.join(fx.dir, "none") });
  const view = await w.scan();
  assert.equal(asked, 0);
  assert.equal(view.can_resume, false);
  assert.equal(view.sessions.length, 1);
  assert.equal(view.sessions[0].resume, "manual");
});

test("a stopped Codex session is matched to its rollout and resumed", async () => {
  const codex = tmpdir();
  const started = NOW - 3600_000;
  const d = new Date(started);
  const day = path.join(codex, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  fs.mkdirSync(day, { recursive: true });
  const id = "01a13f7c-406b-70f2-aba7-5ad85ba9cc19";
  const meta = { type: "session_meta", payload: { id, cwd: "D:\\git\\usage_monitor", timestamp: new Date(started + 3000).toISOString(), originator: "codex-tui", source: "cli", base_instructions: { text: "x".repeat(100_000) } } };
  const sub = { type: "session_meta", payload: { id: "sub", cwd: "D:\\git\\usage_monitor", timestamp: new Date(started + 3000).toISOString(), source: { subagent: { other: "guardian" } } } };
  const lines = [meta,
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 100, resets_at: (NOW - GRACE_MS - 1000) / 1000 } } } },
    { type: "event_msg", timestamp: new Date(NOW - 7200_000).toISOString(), payload: { type: "task_complete", error: { message: "You've hit your usage limit.", codex_error_info: "usage_limit_exceeded" } } }];
  fs.writeFileSync(path.join(day, `rollout-x-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.writeFileSync(path.join(day, "rollout-x-sub.jsonl"), JSON.stringify(sub) + "\n");
  fs.writeFileSync(path.join(codex, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Fix the build" }) + "\n");
  const start = toFiletime(started);
  const helper = fakeHelper(() => [
    { pid: 9, name: "codex", start, cwd: "D:\\git\\usage_monitor\\", cmd: '"C:\\Codex\\bin\\codex.exe" ' },
    { pid: 10, name: "codex", start, cwd: "C:\\daemon\\", cmd: '"C:\\Codex\\codex.exe" app-server --managed-daemon' },
  ]);
  const w = createWatcher({ getConfig: () => ({ auto_resume: true }), platform: "win32", now: () => NOW, request: helper.request,
    claudeDir: () => path.join(codex, "no-claude"), codexDir: () => codex });
  const view = await w.scan();
  assert.equal(view.sessions.length, 1);
  assert.equal(view.sessions[0].key, `codex:${id}`);
  assert.equal(view.sessions[0].name, "Fix the build");
  assert.equal(view.sessions[0].resume, "sent");
  assert.deepEqual(helper.typed, [{ op: "type", pid: 9, start, text: "continue", expect: LIMIT_ON_SCREEN }]);
});

function codexFixture(rollouts) {
  const codex = tmpdir();
  const d = new Date(NOW - 3600_000);
  const day = path.join(codex, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  fs.mkdirSync(day, { recursive: true });
  for (const [id, lines] of Object.entries(rollouts)) fs.writeFileSync(path.join(day, `rollout-x-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return codex;
}

const codexProc = (pid, started) => ({ pid, name: "codex", start: toFiletime(started), cwd: "D:\\git\\usage_monitor\\", cmd: '"C:\\Codex\\bin\\codex.exe" ' });

test("of two Codex terminals in one folder, only the one showing the limit is resumed", async () => {
  const started = NOW - 3600_000;
  const stopped = (id) => [
    { type: "session_meta", payload: { id, cwd: "D:\\git\\usage_monitor", timestamp: new Date(started + 2000).toISOString(), source: "cli" } },
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 100, resets_at: (NOW - GRACE_MS - 1000) / 1000 } } } },
    { type: "event_msg", payload: { type: "task_complete", error: { message: "You've hit your usage limit.", codex_error_info: "usage_limit_exceeded" } } },
  ];
  const codex = codexFixture({ "aaaaaaaa-0000-0000-0000-000000000001": stopped("aaaaaaaa-0000-0000-0000-000000000001"),
    "aaaaaaaa-0000-0000-0000-000000000002": stopped("aaaaaaaa-0000-0000-0000-000000000002") });
  // Started a second apart: neither thread can be told apart by time.
  const helper = fakeHelper(() => [codexProc(9, started), codexProc(10, started + 1000)], () => ({ ok: true }), (req) => req.pid === 9);
  const w = createWatcher({ getConfig: () => ({ auto_resume: true }), platform: "win32", now: () => NOW, request: helper.request,
    claudeDir: () => path.join(codex, "no-claude"), codexDir: () => codex });
  const view = await w.scan();
  assert.deepEqual(helper.peeked.map((r) => [r.pid, r.lines, r.expect]), [[9, 10, LIMIT_ON_SCREEN], [10, 10, LIMIT_ON_SCREEN]]);
  assert.deepEqual(helper.typed, [{ op: "type", pid: 9, start: toFiletime(started), text: "continue", expect: LIMIT_ON_SCREEN, lines: 10 }]);
  assert.deepEqual(view.sessions.map((s) => [s.state, s.resume]), [["limited", "sent"], ["idle", null]]);
  await w.scan();
  assert.equal(helper.typed.length, 1);
});

test("a Codex terminal with no rollout uses the meters' reset and waits for it", async () => {
  const codex = codexFixture({});
  const reset = NOW + 600_000;
  let t = NOW;
  let snap = { providers: [{ id: "codex", status: { state: "ok" }, windows: [{ kind: "five_hour", used_pct: 100, resets_at: new Date(reset).toISOString() }] }] };
  const helper = fakeHelper(() => [codexProc(9, NOW - 3600_000)], () => ({ ok: true }), () => true);
  const w = createWatcher({ getConfig: () => ({ auto_resume: true }), platform: "win32", now: () => t, request: helper.request, snapshot: () => snap,
    claudeDir: () => path.join(codex, "no-claude"), codexDir: () => codex });
  let view = await w.scan();
  assert.deepEqual([view.sessions[0].state, view.sessions[0].resume], ["limited", "scheduled"]);
  assert.equal(helper.typed.length, 0);
  t = reset + GRACE_MS;
  snap = { providers: [{ id: "codex", status: { state: "ok" }, windows: [{ kind: "five_hour", used_pct: 0, resets_at: new Date(reset + 5 * 3600_000).toISOString() }] }] };
  view = await w.scan();
  assert.equal(view.sessions[0].resume, "sent");
  assert.equal(helper.typed.length, 1);
  // Hours later an old reset no longer makes the terminal a candidate.
  t = reset + 7 * 3600_000;
  helper.peeked.length = 0;
  view = await w.scan();
  assert.equal(helper.peeked.length, 0);
  assert.equal(view.sessions[0].state, "idle");
});

test("a saved godmode flag does not type into an open terminal", async () => {
  const fx = claudeFixture({ entries: [{ type: "user", message: { content: "hello" } }] });
  const helper = fakeHelper(() => [{ pid: fx.pid, name: "claude", start: fx.start }]);
  const w = createWatcher({ getConfig: () => ({ godmode: true, auto_resume: true }), platform: "win32", now: () => NOW, request: helper.request,
    claudeDir: () => fx.dir, codexDir: () => path.join(fx.dir, "none") });
  const view = await w.scan();
  assert.equal(helper.typed.length, 0);
  assert.equal(helper.peeked.length, 0);
  assert.equal("godmode" in view, false);
  assert.equal(view.sessions.length, 1);
});

test("without a known Codex limit, unlinked terminals are not read", async () => {
  const codex = codexFixture({});
  const helper = fakeHelper(() => [codexProc(9, NOW - 3600_000)], () => ({ ok: true }), () => true);
  const w = createWatcher({ getConfig: () => ({ auto_resume: true }), platform: "win32", now: () => NOW, request: helper.request,
    claudeDir: () => path.join(codex, "no-claude"), codexDir: () => codex });
  const view = await w.scan();
  assert.equal(helper.peeked.length, 0);
  assert.equal(helper.typed.length, 0);
  assert.equal(view.sessions[0].state, "idle");
});

test("the other CLIs' limit messages are recognized, tool output and spending caps are not", () => {
  const re = new RegExp(OTHER_LIMIT_ON_SCREEN, "i");
  for (const text of ["You hit your weekly limit.", "You\u2019ve reached your free Grok Build usage limit for now.",
    "You have exhausted your quota on this model.", "You've hit your usage limit", "Sorry, you've exceeded your premium requests quota.",
    "Quota exceeded for quota metric 'Gemini 2.5 Pro Requests'"]) assert.ok(re.test(text), text);
  for (const text of ["50 results limit reached. Use limit=100 for more", "You've hit your spending cap.", "AI: Out of credits",
    "Usage limit tab shows your allowance"]) assert.equal(re.test(text), false, text);
});

test("a reset time on screen is read from when the message first showed", () => {
  const seen = new Date(2026, 9, 16, 21, 0).getTime();
  assert.equal(resetOnScreen("You've hit your usage limit · resets 10:10pm", seen), new Date(2026, 9, 16, 22, 10).getTime());
  assert.equal(resetOnScreen("Try again at 8:05 PM.", seen), new Date(2026, 9, 17, 20, 5).getTime());
  assert.equal(resetOnScreen("limit reached, try again in 2h 30m", seen), seen + 2.5 * 3600_000);
  assert.equal(resetOnScreen("resets in 3 days", seen), seen + 3 * 86400_000);
  assert.equal(resetOnScreen("You hit your weekly limit.", seen), null);
});

test("Grok, Antigravity, Gemini, Cursor and Copilot terminals are recognized by their programs", () => {
  // Real command lines use backslashes; the matchers take either separator.
  const cursor = "C:/Users/u/AppData/Local/cursor-agent/versions/2026.10.12-d47ca18";
  const cases = [
    [{ name: "grok", cmd: '"C:/Users/u/.grok/bin/grok.exe" ' }, "Grok Build", true],
    [{ name: "agent", cmd: '"C:/Users/u/.grok/bin/agent.exe" --model x' }, "Grok Build", true],
    [{ name: "agent", cmd: '"C:/tools/agent.exe"' }, null],
    [{ name: "agy", cmd: '"C:/Users/u/AppData/Local/agy/bin/agy.exe" ' }, "Antigravity", true],
    [{ name: "node", cmd: `"${cursor}/node.exe" ${cursor}/index.js ` }, "Cursor Agent", true],
    [{ name: "node", cmd: `${cursor}/node.exe ${cursor}/index.js worker-server` }, "Cursor Agent", false],
    [{ name: "node", cmd: '"C:/node/node.exe" C:/Users/u/AppData/Roaming/npm/node_modules/@google/gemini-cli/dist/index.js' }, "Gemini CLI", true],
    [{ name: "node", cmd: '"C:/node/node.exe" C:/npm/node_modules/@github/copilot/index.js -p "fix it"' }, "Copilot CLI", false],
    [{ name: "copilot", cmd: "copilot --resume" }, "Copilot CLI", true],
    [{ name: "node", cmd: '"C:/node/node.exe" C:/work/server.js' }, null],
  ];
  for (const [proc, label, interactive] of cases) {
    const hit = otherCli(proc);
    assert.equal(hit ? hit.cli.label : null, label, proc.cmd);
    if (hit) assert.equal(isOtherTui(hit.args), interactive, proc.cmd);
  }
});

test("other CLI terminals are listed, and one stopped by a limit is resumed after the meters' reset", async () => {
  const dir = tmpdir();
  const reset = NOW + 600_000;
  let t = NOW;
  let snap = { providers: [{ id: "grok", status: { state: "ok" }, windows: [{ kind: "weekly", used_pct: 100, resets_at: new Date(reset).toISOString() }] }] };
  const start = toFiletime(NOW - 3600_000);
  const cursor = "C:/c/cursor-agent/versions/1";
  const procs = [
    { pid: 11, ppid: 1, name: "grok", start, cwd: "D:/work/api/", cmd: '"C:/g/.grok/bin/grok.exe" ' },
    { pid: 12, ppid: 1, name: "agy", start, cwd: "D:/work/web/", cmd: "agy" },
    { pid: 13, ppid: 1, name: "node", start, cwd: "D:/work/cli/", cmd: `${cursor}/node.exe ${cursor}/index.js` },
    { pid: 14, ppid: 13, name: "node", start, cwd: "D:/work/cli/", cmd: `${cursor}/node.exe ${cursor}/index.js` },
    { pid: 15, ppid: 1, name: "copilot", start, cwd: "D:/ide/", cmd: "copilot --stdio" },
  ];
  const screens = {
    11: "Thinking...\nYou hit your weekly limit.\n> \nGrok 4.7 Fast",
    12: "Working... (4s · esc to cancel)\n>",
    13: "Cursor Agent\n> Plan, search, build anything",
    15: null, // no console: started by an editor
  };
  const typed = [];
  const screenRead = [];
  const request = async (req) => {
    if (req.op === "scan") return { procs };
    if (req.op === "screen") {
      screenRead.push(req.pid);
      return { text: screens[req.pid] ?? null };
    }
    typed.push(req);
    return { ok: true };
  };
  const w = createWatcher({ getConfig: () => ({ auto_resume: true }), platform: "win32", now: () => t, request, snapshot: () => snap,
    claudeDir: () => path.join(dir, "none"), codexDir: () => path.join(dir, "none"), grokDir: () => path.join(dir, "none"), cursorDir: () => path.join(dir, "none") });
  let view = await w.scan();
  assert.ok(!screenRead.includes(14), "a CLI's own worker is not read as another session");
  assert.deepEqual(view.sessions.map((s) => [s.label, s.name, s.state]),
    [["Cursor Agent", "cli", "idle"], ["Antigravity", "web", "working"], ["Grok Build", "api", "limited"]]);
  const grok = view.sessions.find((s) => s.tool === "grok");
  assert.equal(grok.resume, "scheduled");
  assert.equal(grok.resets_at, new Date(reset).toISOString());
  assert.equal(typed.length, 0);
  // After the reset the meters move on; the remembered reset still applies to this terminal.
  t = reset + GRACE_MS;
  snap = { providers: [{ id: "grok", status: { state: "ok" }, windows: [{ kind: "weekly", used_pct: 0, resets_at: new Date(reset + 7 * 86400_000).toISOString() }] }] };
  view = await w.scan();
  assert.equal(view.sessions.find((s) => s.tool === "grok").resume, "sent");
  assert.deepEqual(typed, [{ op: "type", pid: 11, start, text: "continue", expect: OTHER_LIMIT_ON_SCREEN, lines: OTHER_LINES }]);
});

test("a limit message with no reset the meters or the screen report is listed but never typed into", async () => {
  const dir = tmpdir();
  const start = toFiletime(NOW - 3600_000);
  let t = NOW;
  const typed = [];
  const request = async (req) => {
    if (req.op === "scan") return { procs: [{ pid: 21, ppid: 1, name: "agy", start, cwd: "D:/x", cmd: "agy" }] };
    if (req.op === "screen") return { text: "You have exhausted your quota on this model.\n>" };
    typed.push(req);
    return { ok: true };
  };
  const w = createWatcher({ getConfig: () => ({ auto_resume: true }), platform: "win32", now: () => t, request,
    claudeDir: () => path.join(dir, "none"), codexDir: () => path.join(dir, "none"), grokDir: () => path.join(dir, "none"), cursorDir: () => path.join(dir, "none") });
  let view = await w.scan();
  assert.deepEqual([view.sessions[0].state, view.sessions[0].resets_at, view.sessions[0].resume], ["limited", null, "scheduled"]);
  t += 86400_000;
  view = await w.scan();
  assert.equal(typed.length, 0);
});

test("Copilot's rate-limit messages and their reset times are read", () => {
  const re = new RegExp(OTHER_LIMIT_ON_SCREEN, "i");
  const seen = new Date(2026, 9, 16, 9, 0).getTime();
  const sorry = "Sorry, you've hit a rate limit that restricts the number of Copilot model requests you can make within a specific time period. Please try again in 4 hours.";
  assert.ok(re.test(sorry));
  assert.equal(resetOnScreen(sorry, seen), seen + 4 * 3600_000);
  const wait = "You've hit your rate limit. Please wait for your limit to reset in 3 hours 49 minutes or switch to auto model to continue.";
  assert.ok(re.test(wait));
  assert.equal(resetOnScreen(wait, seen), seen + (3 * 60 + 49) * 60_000);
  const model = "You've hit the rate limit for this model. Please switch models or wait for your limit to reset in under a minute.";
  assert.ok(re.test(model));
  assert.equal(resetOnScreen(model, seen), seen + 60_000);
  // Cursor names the day its monthly cycle ends, month first, sometimes wrapped onto the next line.
  assert.equal(resetOnScreen("Your usage limits will reset when your monthly cycle ends on\n8/14/2025.", seen), new Date(2025, 7, 14).getTime());
  const agy = "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 37m43s.";
  assert.ok(re.test(agy));
  assert.equal(resetOnScreen(agy, seen), seen + (37 * 60 + 43) * 1000);
});

test("each CLI's busy hint is its own: a dialog's Esc to cancel is not a running turn", () => {
  const cli = (label) => OTHER_CLIS.find((c) => c.label === label);
  assert.equal(cli("Cursor Agent").working.test("Enter to send · Esc to cancel"), false);
  assert.ok(cli("Cursor Agent").working.test("→ Add a follow-up                ctrl+c to stop"));
  assert.ok(cli("Cursor Agent").idle.test("→ Plan, search, build anything"));
  assert.ok(cli("Antigravity").working.test("Working... (12s · esc to cancel)"));
  assert.equal(cli("Antigravity").working.test("Enter/Esc to cancel"), false);
  assert.ok(cli("Antigravity").idle.test("? for shortcuts                Gemini 3.8 Flash · high"));
  assert.ok(cli("Gemini CLI").working.test("⠋ Reading files (esc to cancel, 12s)"));
});

test("a Grok turn runs from turn_started until turn_ended; an open permission request waits for you", () => {
  assert.deepEqual(grokState([{ type: "turn_started" }, { type: "phase_changed" }]), { busy: true });
  assert.deepEqual(grokState([{ type: "turn_started" }, { type: "turn_ended", outcome: "completed" }, { type: "yolo_toggled" }]), { busy: false, error: false });
  assert.deepEqual(grokState([{ type: "turn_ended", outcome: "error" }]), { busy: false, error: true });
  assert.deepEqual(grokState([{ type: "tool_started" }, { type: "permission_requested" }]), { busy: false });
  assert.deepEqual(grokState([]), { busy: false });
});

function grokFixture({ pid, cwd, id, title, events, openedAt }) {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "active_sessions.json"), JSON.stringify([{ session_id: id, pid, cwd, opened_at: openedAt }]));
  const session = path.join(dir, "sessions", encodeURIComponent(cwd), id);
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, "summary.json"), JSON.stringify({ info: { id, cwd }, generated_title: title }));
  fs.writeFileSync(path.join(session, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
}

test("a Grok terminal shows its session title and turn state from Grok's own records", async () => {
  const start = toFiletime(NOW - 3600_000);
  const grokDir = grokFixture({ pid: 31, cwd: "D:/work/api", id: "01a1-grok", title: "Fix the billing parser",
    events: [{ type: "turn_started" }, { type: "phase_changed", phase: "streaming_text" }], openedAt: new Date(NOW - 3590_000).toISOString() });
  const request = async (req) => {
    if (req.op === "scan") return { procs: [{ pid: 31, ppid: 1, name: "grok", start, cwd: "D:/work/api/", cmd: "grok" }] };
    if (req.op === "screen") return { text: "> \nGrok 4.7 Fast" };
    return { ok: true };
  };
  const none = path.join(grokDir, "none");
  const w = createWatcher({ getConfig: () => ({}), platform: "win32", now: () => NOW, request,
    claudeDir: () => none, codexDir: () => none, grokDir: () => grokDir, cursorDir: () => none });
  let view = await w.scan();
  assert.deepEqual(view.sessions.map((s) => [s.key, s.name, s.state]), [["grok:01a1-grok", "Fix the billing parser", "working"]]);
  const events = path.join(grokDir, "sessions", encodeURIComponent("D:/work/api"), "01a1-grok", "events.jsonl");
  fs.appendFileSync(events, JSON.stringify({ type: "turn_ended", outcome: "completed" }) + "\n");
  view = await w.scan();
  assert.equal(view.sessions[0].state, "idle");
  // A record from an earlier process that had the same id is not this terminal's.
  fs.writeFileSync(path.join(grokDir, "active_sessions.json"), JSON.stringify([{ session_id: "old", pid: 31, cwd: "D:/work/api", opened_at: new Date(NOW - 86400_000).toISOString() }]));
  view = await w.scan();
  assert.deepEqual([view.sessions[0].key.startsWith("grok:31:"), view.sessions[0].name, view.sessions[0].state], [true, "api", "running"]);
});

test("on macOS and Linux, Grok sessions are listed from its records without typing", async () => {
  const grokDir = grokFixture({ pid: process.pid, cwd: "/home/u/api", id: "01a1-mac", title: "Port the parser",
    events: [{ type: "turn_ended", outcome: "completed" }], openedAt: new Date(NOW).toISOString() });
  const none = path.join(grokDir, "none");
  let asked = 0;
  const w = createWatcher({ getConfig: () => ({ auto_resume: true }), platform: "linux", now: () => NOW, request: async () => { asked++; return {}; },
    claudeDir: () => none, codexDir: () => none, grokDir: () => grokDir, cursorDir: () => none });
  const view = await w.scan();
  assert.equal(asked, 0);
  assert.deepEqual(view.sessions.map((s) => [s.label, s.name, s.state]), [["Grok Build", "Port the parser", "idle"]]);
});

test("a Cursor terminal shows the title of the chat it started", async () => {
  const dir = tmpdir();
  const start = toFiletime(NOW - 600_000);
  const chat = (id, created, title) => {
    fs.mkdirSync(path.join(dir, "chats", "h1", id), { recursive: true });
    fs.writeFileSync(path.join(dir, "chats", "h1", id, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: created, updatedAtMs: created + 1000, cwd: "D:\\work\\cli", title }));
  };
  chat("older", NOW - 86400_000, "Yesterday's chat");
  chat("mine", NOW - 599_000, "Wire up the exporter");
  const request = async (req) => {
    if (req.op === "scan") return { procs: [{ pid: 41, ppid: 1, name: "node", start, cwd: "D:\\work\\cli\\", cmd: "C:/c/cursor-agent/versions/1/node.exe C:/c/cursor-agent/versions/1/index.js" }] };
    if (req.op === "screen") return { text: "→ Add a follow-up" };
    return { ok: true };
  };
  const none = path.join(dir, "none");
  const w = createWatcher({ getConfig: () => ({}), platform: "win32", now: () => NOW, request,
    claudeDir: () => none, codexDir: () => none, grokDir: () => none, cursorDir: () => dir });
  const view = await w.scan();
  assert.deepEqual(view.sessions.map((s) => [s.label, s.name, s.state]), [["Cursor Agent", "Wire up the exporter", "idle"]]);
});

test("a codex resume id with no rollout is searched once, then skipped until the retry window", async (t) => {
  const codex = tmpdir();
  t.after(() => fs.rmSync(codex, { recursive: true, force: true }));
  const root = path.join(codex, "sessions");
  // A real rollout on today's date, but not the id the process resumes.
  const now = new Date(NOW);
  const day = path.join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  fs.mkdirSync(day, { recursive: true });
  const realId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  fs.writeFileSync(path.join(day, `rollout-x-${realId}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: realId, cwd: "D:\p", timestamp: now.toISOString() } }) + "\n");
  const missing = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  const start = toFiletime(NOW - 5000);
  const request = async (req) => req.op === "scan"
    ? { procs: [{ pid: 900, ppid: 1, name: "codex", start, cwd: "D:\p", cmd: `codex resume ${missing}` }] }
    : { shown: false, text: null };
  const realReaddir = fs.readdirSync;
  let rootWalks = 0;
  fs.readdirSync = (p, ...rest) => { if (String(p) === root) rootWalks++; return realReaddir(p, ...rest); };
  t.after(() => { fs.readdirSync = realReaddir; });
  let clock = NOW;
  const none = path.join(codex, "none");
  const w = createWatcher({ getConfig: () => ({}), platform: "win32", now: () => clock, request,
    claudeDir: () => none, codexDir: () => codex, grokDir: () => none, cursorDir: () => none });
  await w.scan();
  assert.equal(rootWalks, 1, "the missing id triggers one full-tree walk");
  await w.scan();
  assert.equal(rootWalks, 1, "a second scan inside the retry window does not walk again");
  clock = NOW + 6 * 60_000;
  await w.scan();
  assert.equal(rootWalks, 2, "after the retry window it searches once more");
});
