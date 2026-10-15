const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createWatcher, claudeState, codexState, resumeStatus, matchCodex, isCodexTui, filetimeMs, clockAfter,
  GRACE_MS, MAX_ATTEMPTS, RETRY_MS, LIMIT_ON_SCREEN,
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
  assert.deepEqual(codexState([started, tokens, done, late]), { limited: true, busy: false, resets_at: 1792074052000, limit: null });
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
  assert.equal(cfg.chips_show.sessions, true);
  assert.equal(config.normalize({ auto_resume: "yes" }).auto_resume, false);
  assert.equal(config.normalize({ auto_resume: true }).auto_resume, true);
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
    claudeDir: () => fx.dir, codexDir: () => path.join(fx.dir, "none") });
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
