const test = require("node:test");
const assert = require("node:assert/strict");
const { canOpen, relDir, fileId, buildView } = require("../src/files-window");

test("only documents and media may be opened", () => {
  for (const name of ["a.pdf", "b.DOCX", "c.Md", "report.final.xlsx", "photo.JPEG", "D:\\work\\x.csv", "/home/u/clip.mp4", "run.log", "data.json"]) {
    assert.equal(canOpen(name), true, name);
  }
  // Scripts, programs and installers run when opened; no extension and dot files are not documents.
  for (const name of ["a.js", "b.bat", "c.cmd", "d.ps1", "e.exe", "f.lnk", "g.vbs", "h.msi", "i.sh", "README", ".md", "x.", "", "a.pdf.exe", "a.pdf ", "dir.pdf/run.js", "dir.pdf\\run"]) {
    assert.equal(canOpen(name), false, JSON.stringify(name));
  }
  assert.equal(canOpen(null), false);
  assert.equal(canOpen(undefined), false);
});

test("a file's folder is relative to the session folder when it is inside it", () => {
  assert.equal(relDir("D:\\work\\api\\src\\routes\\a.ts", "D:\\work\\api"), "src\\routes");
  assert.equal(relDir("D:\\work\\api\\a.ts", "D:\\work\\api"), "");
  assert.equal(relDir("D:\\work\\api\\a.ts", "D:\\work\\api\\"), "");
  assert.equal(relDir("/home/u/p/out/a.pdf", "/home/u/p"), "out");
  assert.equal(relDir("/home/u/p/out/deep/a.pdf", "/home/u/p/"), "out/deep");
  assert.equal(relDir("/home/u/p/a.pdf", "/home/u/p"), "");
  // Windows paths differ in case and separators.
  assert.equal(relDir("d:\\Work\\API\\src\\a.ts", "D:\\work\\api"), "src");
  assert.equal(relDir("D:/work/api/src/a.ts", "D:\\work\\api"), "src");
});

test("a file outside the session folder keeps its absolute folder", () => {
  assert.equal(relDir("D:\\work\\shared\\a.png", "D:\\work\\api"), "D:\\work\\shared");
  assert.equal(relDir("/home/u/other/a.png", "/home/u/p"), "/home/u/other");
  // A sibling that only shares a prefix is not inside.
  assert.equal(relDir("/home/u/project-two/a.png", "/home/u/project"), "/home/u/project-two");
  assert.equal(relDir("D:\\work\\api2\\a.png", "D:\\work\\api"), "D:\\work\\api2");
  // On a case-sensitive path the case matters.
  assert.equal(relDir("/home/u/P/a.png", "/home/u/p"), "/home/u/P");
  assert.equal(relDir("/home/u/p/a.png", ""), "/home/u/p");
  assert.equal(relDir("/a.png", "/home"), "/");
});

const scan = {
  sessions: [
    { key: "claude:1", tool: "claude", label: "Claude Code", name: "api", cwd: "D:\\work\\api", started: "2026-01-01T10:00:00Z", last_active: "2026-01-01T11:00:00Z", files: [
      { path: "D:\\work\\api\\src\\a.js", name: "a.js", kind: "edited", at: "2026-01-01T10:30:00Z", exists: true, size: 10, modified: 5 },
      { path: "D:\\work\\api\\out\\r.pdf", name: "r.pdf", kind: "generated", at: "2026-01-01T10:40:00Z", exists: true, size: 20, modified: 6 },
      { path: "D:\\work\\api\\gone.pdf", name: "gone.pdf", kind: "created", at: "2026-01-01T10:20:00Z", exists: false, size: null, modified: null },
    ] },
    { key: "cursor:9", tool: "cursor", label: "Cursor Agent", name: "off", cwd: "D:\\x", files: [{ path: "D:\\x\\z.md", name: "z.md", kind: "created", at: "x", exists: true }] },
    { key: "codex:2", tool: "codex", name: "tool", cwd: "D:\\work\\api", files: [{ path: "D:\\work\\api\\src\\a.js", name: "a.js", kind: "edited", at: "x", exists: true }] },
  ],
  coverage: { skipped: 3, truncated: true },
};

test("the view carries ids and folders, never a path", () => {
  const { view, index } = buildView(scan, { days: 7, running: ["claude:1"], providerOn: (tool) => tool !== "cursor", select: "codex:2", now: 123 });
  assert.deepEqual(view.sessions.map((s) => [s.key, s.running]), [["claude:1", true], ["codex:2", false]], "a switched-off tool is left out");
  assert.equal(view.select, "codex:2");
  assert.equal(view.scanned_at, 123);
  assert.deepEqual(view.coverage, { skipped: 3, truncated: true });
  const files = view.sessions[0].files;
  assert.deepEqual(files.map((f) => [f.name, f.dir, f.can_open, f.exists]), [["a.js", "src", false, true], ["r.pdf", "out", true, true], ["gone.pdf", "", false, false]]);
  assert.equal(JSON.stringify(view).includes("D:\\\\work\\\\api\\\\src\\\\a.js"), false, "no full path is sent");
  for (const f of files) assert.match(f.id, /^[0-9a-f]{16}$/);
  // The same file in two sessions has two ids.
  assert.notEqual(files[0].id, view.sessions[1].files[0].id);
  assert.equal(files[0].id, fileId("claude:1", "D:\\work\\api\\src\\a.js"));
  assert.equal(index.size, 4);
});

test("the id map names only files from the last view", () => {
  const { view, index } = buildView(scan, { days: 7 });
  const f = view.sessions[0].files[1];
  assert.deepEqual(index.get(f.id), { key: "claude:1", path: "D:\\work\\api\\out\\r.pdf" });
  for (const id of ["", "0123456789abcdef", "D:\\work\\api\\out\\r.pdf", "../../etc/passwd", undefined, null, 7, {}]) {
    assert.equal(index.get(id), undefined, String(id));
  }
});

test("an empty or odd scan gives an empty view", () => {
  assert.deepEqual(buildView(null, { days: 30 }).view.sessions, []);
  const odd = buildView({ sessions: [null, { key: 5 }, { key: "claude:3", tool: "claude", files: [{ path: "" }, null] }] }, { days: 7 });
  assert.deepEqual(odd.view.sessions, []);
  assert.deepEqual(odd.view.coverage, { skipped: 0, truncated: false });
});
