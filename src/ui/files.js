const api = window.filesApi;
const $ = (id) => document.getElementById(id);

const KINDS = { created: "Created", edited: "Edited", generated: "Generated" };
const KIND_HINT = {
  created: "The session created this file.",
  edited: "The session changed a file that was already there.",
  generated: "Appeared in the session's folder while it was working. A best guess.",
};
const PROVIDER_NAMES = Object.fromEntries(UsageModels.PROVIDERS.map((p) => [p.id, p.displayName]));
const AUTO_REFRESH_MS = 30000;
const FOCUS_REFRESH_MS = 15000;

let days = 7;
let view = null;
let failed = null;
let loading = true;
let selectedKey = null;
let seq = 0;
let lastScan = 0;
const filter = { kind: "all", query: "", deleted: false };
let listHtml = "";
let detailHtml = "";

const esc = escapeHtml;
const toMs = (v) => (typeof v === "number" ? v : Date.parse(v));
const toolName = (s) => s.label || PROVIDER_NAMES[s.tool] || s.tool;
const folderName = (cwd) => String(cwd || "").split(/[\\/]/).filter(Boolean).pop() || "";
const kindOf = (f) => (KINDS[f.kind] ? f.kind : "created");

function shortWhen(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function fullWhen(ms) {
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "";
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    t.hidden = true;
  }, 3500);
}

// ---- what is shown ----

function matches(f) {
  if (!filter.deleted && !f.exists) return false;
  const q = filter.query.trim().toLowerCase();
  return !q || f.name.toLowerCase().includes(q) || f.dir.toLowerCase().includes(q);
}

// Sessions that still have a file after the filters, each with just those files.
function shownSessions() {
  if (!view || !view.sessions) return [];
  return view.sessions
    .map((s) => ({ s, files: s.files.filter((f) => matches(f) && (filter.kind === "all" || kindOf(f) === filter.kind)) }))
    .filter((x) => x.files.length);
}

function kindCounts() {
  const counts = { all: 0, created: 0, edited: 0, generated: 0 };
  for (const s of (view && view.sessions) || []) {
    for (const f of s.files) {
      if (!matches(f)) continue;
      counts.all++;
      counts[kindOf(f)]++;
    }
  }
  return counts;
}

// ---- rendering ----

function sessionRow(x, selected) {
  const { s, files } = x;
  const ago = formatAgo(toMs(s.last_active));
  const sub = [folderName(s.cwd), ago ? `last active ${ago}` : ""].filter(Boolean).join(" · ");
  const name = s.name || "Untitled session";
  return `<li><button type="button" class="srow accent-${esc(s.tool)}${selected ? " selected" : ""}" data-key="${esc(s.key)}" data-f="s:${esc(s.key)}"
      tabindex="${selected ? 0 : -1}"${selected ? ' aria-current="true"' : ""} title="${esc(`${toolName(s)} · ${s.cwd || ""}`)}">
      <span class="s-mark">${mark(s.tool)}</span>
      <span class="s-text"><span class="s-name">${esc(name)}</span><span class="s-sub">${esc(sub)}</span></span>
      <span class="s-meta">${s.running ? '<span class="run-dot" role="img" aria-label="Running now" title="Running now"></span>' : ""}<span class="s-count" aria-label="${files.length} ${files.length === 1 ? "file" : "files"}">${files.length}</span></span>
    </button></li>`;
}

// A long name is cut in its stem, so the extension that tells a .pdf from a .docx stays in view.
function nameParts(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || name.length - dot > 12) return `<span class="f-stem">${esc(name)}</span>`;
  return `<span class="f-stem">${esc(name.slice(0, dot))}</span><span class="f-ext">${esc(name.slice(dot))}</span>`;
}

function fileRow(f) {
  const kind = kindOf(f);
  const label = esc(f.name);
  const when = toMs(f.modified ?? f.at);
  const buttons = [];
  if (f.exists && f.can_open) buttons.push(`<button type="button" class="btn sm primary" data-act="open" data-id="${esc(f.id)}" data-f="o:${esc(f.id)}" aria-label="Open ${label}">Open</button>`);
  if (f.exists) buttons.push(`<button type="button" class="btn sm${f.can_open ? "" : " primary"}" data-act="reveal" data-id="${esc(f.id)}" data-f="v:${esc(f.id)}" aria-label="Show ${label} in folder">Show in folder</button>`);
  buttons.push(`<button type="button" class="btn sm" data-act="copy" data-id="${esc(f.id)}" data-f="c:${esc(f.id)}" aria-label="Copy the path of ${label}">Copy path</button>`);
  const dir = f.dir === "" ? "Session folder" : f.dir;
  return `<tr class="frow${f.exists ? "" : " gone"}" tabindex="0" data-id="${esc(f.id)}" data-primary="${f.exists ? (f.can_open ? "open" : "reveal") : "copy"}" data-f="r:${esc(f.id)}">
      <td class="c-name"><span class="f-name" title="${label}">${nameParts(f.name)}</span><span class="f-dir${f.dir === "" ? " plain" : ""}" title="${esc(f.dir)}">${esc(dir)}</span></td>
      <td class="c-kind"><span class="kind kind-${kind}" title="${esc(KIND_HINT[kind])}">${KINDS[kind]}</span></td>
      <td class="c-mod" title="${esc(fullWhen(when))}">${f.exists ? esc(shortWhen(when)) : "Deleted"}</td>
      <td class="c-size num">${f.exists && f.size != null ? esc(NetFormat.formatBytes(f.size)) : "—"}</td>
      <td class="c-act"><div class="acts">${buttons.join("")}</div></td>
    </tr>`;
}

function detailMarkup(x) {
  const { s, files } = x;
  const started = toMs(s.started);
  const active = toMs(s.last_active);
  const meta = [toolName(s), Number.isFinite(started) ? `started ${shortWhen(started)}` : "", Number.isFinite(active) ? `last active ${shortWhen(active)}` : ""].filter(Boolean).join(" · ");
  return `<header class="d-strip accent-${esc(s.tool)}">
      <div class="d-top"><span class="s-mark">${mark(s.tool)}</span><h2>${esc(s.name || "Untitled session")}</h2>${s.running ? '<span class="run-pill"><span class="run-dot" aria-hidden="true"></span>Running</span>' : ""}</div>
      <div class="d-meta">${esc(meta)}</div>
      ${s.cwd ? `<div class="d-folder"><span class="d-path" title="${esc(s.cwd)}">${esc(s.cwd)}</span><button type="button" class="btn sm" data-act="folder" data-key="${esc(s.key)}" data-f="folder" aria-label="Open the folder of ${esc(s.name || "this session")}">Open folder</button></div>` : ""}
    </header>
    <div class="table-wrap"><table class="ftable">
      <thead><tr><th class="c-name">Name</th><th class="c-kind">Kind</th><th class="c-mod">Modified</th><th class="c-size num">Size</th><th class="c-act"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${files.map(fileRow).join("")}</tbody>
    </table></div>`;
}

// Sets the markup only when it changed, and puts the keyboard focus back on the same control.
function setHtml(el, html, last) {
  if (html === last) return last;
  const focused = el.contains(document.activeElement) ? document.activeElement.dataset.f : null;
  const scrolls = [...el.querySelectorAll(".table-wrap")].map((w) => w.scrollTop);
  el.innerHTML = html;
  el.querySelectorAll(".table-wrap").forEach((w, i) => { w.scrollTop = scrolls[i] || 0; });
  if (focused) {
    const again = [...el.querySelectorAll("[data-f]")].find((n) => n.dataset.f === focused);
    if (again) again.focus({ preventScroll: true });
  }
  return html;
}

function showState(text, spinning) {
  $("main").hidden = true;
  $("stateBox").hidden = false;
  $("stateText").textContent = text;
  $("spinner").hidden = !spinning;
}

function render() {
  const counts = kindCounts();
  for (const id of Object.keys(counts)) {
    const n = $(`n-${id}`);
    if (n.textContent !== String(counts[id])) n.textContent = counts[id];
  }
  $("refresh").disabled = loading;
  $("updated").textContent = loading ? (view ? "Refreshing…" : "") : view ? `Updated ${formatAgo(view.scanned_at)}` : "";
  $("banner").hidden = !failed;
  if (failed) $("bannerText").textContent = failed;
  const cov = (view && view.coverage) || {};
  const notes = [];
  if (cov.skipped) notes.push(`${cov.skipped} session ${cov.skipped === 1 ? "record" : "records"} couldn't be read.`);
  if (cov.truncated) notes.push("A session or a folder was too large to read in full, so a few files may be missing.");
  $("coverage").hidden = !notes.length;
  $("coverage").textContent = notes.join(" ");

  if (!view) {
    // A failed first reading shows only the banner, with its Try again button.
    if (!failed) return showState("Reading session records…", true);
    $("main").hidden = true;
    $("stateBox").hidden = true;
    return;
  }
  if (!view.sessions.length) return showState(`No session has produced a file in the last ${view.days} days.`, false);
  const shown = shownSessions();
  if (!shown.length) {
    const hidden = !filter.deleted && view.sessions.some((s) => s.files.some((f) => !f.exists));
    return showState(`No files match.${hidden ? " Deleted files are hidden." : ""}`, false);
  }
  $("stateBox").hidden = true;
  $("main").hidden = false;
  // The first session stands in while the chosen one is filtered out; the choice itself is kept.
  const current = shown.find((x) => x.s.key === selectedKey) || shown[0];
  listHtml = setHtml($("sessionList"), shown.map((x) => sessionRow(x, x === current)).join(""), listHtml);
  detailHtml = setHtml($("detail"), detailMarkup(current), detailHtml);
}

// ---- loading ----

async function load(quiet) {
  const mine = ++seq;
  loading = true;
  if (!quiet) {
    view = null;
    failed = null;
  }
  render();
  let next;
  try {
    next = await api.get(days);
  } catch {
    next = { error: "Couldn't read the session records." };
  }
  if (mine !== seq) return;
  loading = false;
  lastScan = Date.now();
  if (!next || next.error) {
    failed = (next && next.error) || "Couldn't read the session records.";
  } else {
    failed = null;
    view = next;
    if (next.select) selectKey(next.select);
  }
  render();
}

function selectKey(key) {
  if (typeof key !== "string") return;
  selectedKey = key;
  // A filter that hides the session would hide what was asked for.
  if (view && !shownSessions().some((x) => x.s.key === key)) {
    const known = view.sessions.find((s) => s.key === key);
    if (known) {
      filter.kind = "all";
      filter.query = "";
      filter.deleted = filter.deleted || known.files.every((f) => !f.exists);
      $("query").value = "";
      $("deleted").checked = filter.deleted;
      syncKinds();
    }
  }
}

function syncKinds() {
  document.querySelectorAll(".kind-chip").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === filter.kind)));
}

// ---- events ----

$("sessionList").addEventListener("click", (e) => {
  const button = e.target.closest("button.srow");
  if (!button) return;
  selectedKey = button.dataset.key;
  render();
  const again = [...$("sessionList").querySelectorAll(".srow")].find((b) => b.dataset.key === selectedKey);
  if (again) again.focus({ preventScroll: true });
});

$("sessionList").addEventListener("keydown", (e) => {
  const rows = [...$("sessionList").querySelectorAll(".srow")];
  const at = rows.indexOf(document.activeElement);
  if (at < 0) return;
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[e.key];
  if (to == null) return;
  e.preventDefault();
  if (rows[to]) rows[to].click();
});

async function act(button) {
  const kind = button.dataset.act;
  const call = { open: () => api.open(button.dataset.id), reveal: () => api.reveal(button.dataset.id), copy: () => api.copy(button.dataset.id), folder: () => api.openFolder(button.dataset.key) }[kind];
  if (!call) return;
  let reply;
  try {
    reply = await call();
  } catch {
    reply = { ok: false, error: "That didn't work." };
  }
  if (reply && reply.ok) {
    if (kind === "copy") toast("Path copied.");
  } else {
    toast((reply && reply.error) || "That didn't work.");
    if (reply && /gone/.test(reply.error || "")) load(true);
  }
}

$("detail").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-act]");
  if (button) act(button);
});

// Enter on a file does what the row offers first; the buttons keep their own Enter.
$("detail").addEventListener("keydown", (e) => {
  const row = e.target.closest && e.target.closest("tr.frow");
  if (!row) return;
  if (e.key === "Enter" && e.target === row) {
    e.preventDefault();
    const primary = row.querySelector(`button[data-act="${row.dataset.primary}"]`);
    if (primary) act(primary);
  } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.target === row) {
    const sibling = e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
    if (sibling) {
      e.preventDefault();
      sibling.focus();
    }
  }
});

$("detail").addEventListener("dblclick", (e) => {
  const row = e.target.closest("tr.frow");
  if (!row || e.target.closest("button")) return;
  const primary = row.querySelector(`button[data-act="${row.dataset.primary}"]`);
  if (primary) act(primary);
});

document.querySelector(".kinds").addEventListener("click", (e) => {
  const chip = e.target.closest(".kind-chip");
  if (!chip) return;
  filter.kind = chip.dataset.kind;
  syncKinds();
  render();
});
$("query").addEventListener("input", () => {
  filter.query = $("query").value;
  render();
});
$("deleted").addEventListener("change", () => {
  filter.deleted = $("deleted").checked;
  render();
});
$("days").addEventListener("change", () => {
  days = Number($("days").value) === 30 ? 30 : 7;
  load(false);
});
$("refresh").addEventListener("click", () => load(true));
$("retry").addEventListener("click", () => load(false));

api.onSelect((key) => {
  if (view && view.sessions.some((s) => s.key === key)) {
    selectKey(key);
    render();
  } else {
    // A session that started after the last reading.
    selectedKey = key;
    load(true).then(() => selectKey(key) || render());
  }
});

window.addEventListener("focus", () => {
  if (Date.now() - lastScan > FOCUS_REFRESH_MS && !loading) load(true);
});
setInterval(() => {
  if (loading || document.visibilityState !== "visible" || !document.hasFocus()) return;
  load(true);
}, AUTO_REFRESH_MS);
// Relative times move on without a new reading.
setInterval(() => { if (view) render(); }, 15000);

load(false);
