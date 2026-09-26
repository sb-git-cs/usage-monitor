const api = window.netUsage;
const F = NetFormat;
const $ = (id) => document.getElementById(id);

const state = {
  info: null,
  view: null,
  latest: null,
  paused: false,
  autoSort: true,
  resort: true,
  sort: { col: "total", dir: "desc" },
  order: [],
  search: "",
  range: "60",
  selected: null,
  lastRow: null,
  series: null,
  seriesAt: 0,
  icons: new Map(),
  rowEls: new Map(),
  capKey: null,
  connKey: null,
  conns: [],
};

const STATE_LABELS = {
  running: "Recording",
  starting: "Starting…",
  setup_required: "Setup needed",
  not_running: "Helper not running",
  error: "Not recording",
  disabled: "Recording off",
  unsupported: "Unavailable",
};

const NO_PATH = {
  system: "Windows kernel and drivers",
  unknown: "Ended before it could be identified",
  other: "Owned by another user or the system",
};

const ACTION_LABELS = {
  install: "Set up (needs administrator)",
  update: "Update helper",
  start: "Start helper",
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setText(node, text) {
  const value = String(text ?? "");
  if (node.textContent !== value) node.textContent = value;
}

function rangeInfo() {
  const ranges = (state.info && state.info.ranges) || F.NET_RANGES;
  return ranges.find((r) => r.id === state.range) || ranges[2];
}

// ---- toast ----------------------------------------------------------------------

let toastTimer = null;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 5000);
}

async function act(type, key, arg) {
  const res = await api.action(type, key, arg);
  if (res && !res.ok && res.error) toast(res.error);
  return res;
}

// ---- icons ----------------------------------------------------------------------

function paintIcon(holder, key, name) {
  const url = state.icons.get(key);
  holder.replaceChildren();
  if (url) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = url;
    holder.appendChild(img);
    holder.classList.add("has-img");
  } else {
    holder.classList.remove("has-img");
    holder.textContent = (String(name || "?").trim()[0] || "?").toUpperCase();
  }
}

function loadIcon(key, holder, name) {
  if (state.icons.has(key)) {
    paintIcon(holder, key, name);
    return;
  }
  paintIcon(holder, key, name);
  state.icons.set(key, null);
  api.icon(key).then((url) => {
    if (!url) return;
    state.icons.set(key, url);
    const tr = state.rowEls.get(key);
    if (tr) paintIcon(tr._c.icon, key, name);
    if (state.selected === key) paintIcon($("dIcon"), key, name);
  });
}

// ---- table ----------------------------------------------------------------------

function chipsFor(row) {
  const list = [];
  if (row.blocked) list.push({ cls: "danger", text: row.block_pending ? "Blocking…" : "Blocked" });
  else if (row.block_pending) list.push({ cls: "", text: "Unblocking…" });
  if (row.cap) {
    const pct = Math.min(999, Math.round((row.cap.used_bytes / row.cap.limit_bytes) * 100));
    list.push({ cls: pct >= 100 ? "danger" : pct >= 80 ? "warn" : "", text: `Cap ${pct}%` });
  }
  if (row.keep_forever) list.push({ cls: "", text: "Kept forever" });
  if (row.record_connections) list.push({ cls: "", text: "Recording" });
  return list;
}

function renderChips(holder, row) {
  const list = chipsFor(row);
  const sig = list.map((c) => `${c.cls}:${c.text}`).join("|");
  if (holder.dataset.sig === sig) return;
  holder.dataset.sig = sig;
  holder.replaceChildren(...list.map((c) => el("span", `chip ${c.cls}`.trim(), c.text)));
}

function makeRow(row) {
  const tr = document.createElement("tr");
  tr.dataset.key = row.key;
  const appTd = el("td", "col-app");
  const cell = el("div", "app-cell");
  const icon = el("span", "app-icon");
  const text = el("div", "app-text");
  const name = el("span", "app-name");
  const sub = el("span", "app-sub");
  text.append(name, sub);
  cell.append(icon, text);
  appTd.appendChild(cell);
  const num = (cls) => el("td", `num ${cls || ""}`.trim());
  const c = {
    icon,
    name,
    sub,
    rxRate: num(),
    txRate: num(),
    rx: num("wide"),
    tx: num("wide"),
    total: num(),
    avg: num("wider"),
    status: el("td", "col-status"),
  };
  c.chips = el("div", "chips");
  c.status.appendChild(c.chips);
  tr.append(appTd, c.rxRate, c.txRate, c.rx, c.tx, c.total, c.avg, c.status);
  tr._c = c;
  loadIcon(row.key, icon, row.name);
  return tr;
}

function updateRow(tr, row) {
  const c = tr._c;
  setText(c.name, row.name);
  const parts = [];
  if (row.pids > 1) parts.push(`${row.pids} processes`);
  parts.push(row.path || NO_PATH[row.key] || "No program file");
  setText(c.sub, parts.join(" · "));
  tr.title = row.path || row.name;
  setText(c.rxRate, F.formatRate(row.rx_rate));
  setText(c.txRate, F.formatRate(row.tx_rate));
  c.rxRate.classList.toggle("dim", !row.rx_rate);
  c.txRate.classList.toggle("dim", !row.tx_rate);
  setText(c.rx, F.formatBytes(row.rx));
  setText(c.tx, F.formatBytes(row.tx));
  setText(c.total, F.formatBytes(row.total));
  setText(c.avg, F.formatBytes(row.avg_per_min));
  renderChips(c.chips, row);
  tr.classList.toggle("selected", row.key === state.selected);
  tr.setAttribute("aria-selected", row.key === state.selected ? "true" : "false");
}

function sortValue(row, col) {
  if (col === "name") return String(row.name).toLowerCase();
  if (col === "status") return (row.blocked ? 8 : 0) + (row.cap ? 4 : 0) + (row.record_connections ? 2 : 0) + (row.keep_forever ? 1 : 0);
  return Number(row[col]) || 0;
}

function compare(a, b) {
  const { col, dir } = state.sort;
  const va = sortValue(a, col);
  const vb = sortValue(b, col);
  let c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
  if (dir === "desc") c = -c;
  return c || b.total - a.total || String(a.name).localeCompare(String(b.name));
}

function visibleRows() {
  if (!state.view) return [];
  const q = state.search.trim().toLowerCase();
  if (!q) return state.view.rows;
  return state.view.rows.filter(
    (r) => String(r.name).toLowerCase().includes(q) || String(r.path || "").toLowerCase().includes(q) || r.key.toLowerCase().includes(q)
  );
}

function orderedRows() {
  const rows = visibleRows();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  let ordered;
  if (state.autoSort || state.resort) {
    ordered = rows.slice().sort(compare);
    state.resort = false;
  } else {
    ordered = state.order.filter((k) => byKey.has(k)).map((k) => byKey.get(k));
    const known = new Set(ordered.map((r) => r.key));
    ordered.push(...rows.filter((r) => !known.has(r.key)).sort(compare));
  }
  state.order = ordered.map((r) => r.key);
  return ordered;
}

function renderTable() {
  const tbody = $("rows");
  const ordered = orderedRows();
  const keep = new Set(ordered.map((r) => r.key));
  for (const [key, tr] of state.rowEls) {
    if (keep.has(key)) continue;
    tr.remove();
    state.rowEls.delete(key);
  }
  let prev = null;
  for (const row of ordered) {
    let tr = state.rowEls.get(row.key);
    if (!tr) {
      tr = makeRow(row);
      state.rowEls.set(row.key, tr);
    }
    updateRow(tr, row);
    const expected = prev ? prev.nextSibling : tbody.firstChild;
    if (expected !== tr) tbody.insertBefore(tr, expected);
    prev = tr;
  }
  for (const th of document.querySelectorAll("table.apps th")) {
    if (th.dataset.col === state.sort.col) th.setAttribute("aria-sort", state.sort.dir === "desc" ? "descending" : "ascending");
    else th.removeAttribute("aria-sort");
  }
  const empty = $("empty");
  if (ordered.length) {
    empty.hidden = true;
  } else {
    empty.hidden = false;
    const s = state.info && state.info.status;
    if (state.search.trim()) empty.textContent = "No apps match your search.";
    else if (s && s.state !== "running") empty.textContent = s.message || STATE_LABELS[s.state] || "Not recording.";
    else empty.textContent = `No network activity recorded in the ${rangeInfo().label.toLowerCase()}.`;
  }
}

function renderTiles() {
  const s = state.view ? state.view.summary : { rx_rate: 0, tx_rate: 0, rx: 0, tx: 0, active: 0 };
  setText($("tDownRate"), F.formatRate(s.rx_rate));
  setText($("tUpRate"), F.formatRate(s.tx_rate));
  setText($("tDown"), F.formatBytes(s.rx));
  setText($("tUp"), F.formatBytes(s.tx));
  setText($("tActive"), s.active);
  for (const node of document.querySelectorAll(".range-label")) setText(node, `· ${rangeInfo().label.toLowerCase()}`);
}

function render() {
  renderTiles();
  renderTable();
  renderDetails(false);
}

// ---- details --------------------------------------------------------------------

function currentRow() {
  if (!state.selected || !state.view) return null;
  return state.view.rows.find((r) => r.key === state.selected) || null;
}

function bucketLabel(minutes) {
  if (minutes === 1) return "minute";
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes === 60) return "hour";
  if (minutes < 1440) return `${minutes / 60} hours`;
  if (minutes === 1440) return "day";
  return `${Math.round(minutes / 1440)} days`;
}

function blockHint(row) {
  const info = state.info || {};
  const caps = info.capabilities || {};
  if (!caps.block) {
    if (info.platform === "darwin") return "macOS only allows blocking through a signed network extension, so it isn't available here.";
    if (info.platform === "linux") return "Blocking needs root firewall rules on Linux, so it isn't available here.";
    return "Blocking isn't available on this system.";
  }
  if (!row.can_block) return "This entry isn't a program file, so it can't be blocked.";
  if (info.status && info.status.state !== "running") return "The network helper applies blocks once it is running.";
  return "Adds a Windows Firewall rule for this program and closes its open connections.";
}

function renderDetails(forceChart) {
  const row = currentRow();
  if (!state.selected || (!row && !state.lastRow)) {
    $("noSelection").hidden = false;
    $("detailBody").hidden = true;
    return;
  }
  const r = row || { ...state.lastRow, rx_rate: 0, tx_rate: 0, rx: 0, tx: 0, total: 0, avg_per_min: 0 };
  state.lastRow = r;
  $("noSelection").hidden = true;
  $("detailBody").hidden = false;
  if ($("dIcon").dataset.key !== r.key) {
    $("dIcon").dataset.key = r.key;
    paintIcon($("dIcon"), r.key, r.name);
  }
  setText($("dName"), r.name);
  setText($("dPath"), r.path || NO_PATH[r.key] || "No program file");
  renderChips($("dChips"), r);
  setText($("dRxRate"), F.formatRate(r.rx_rate));
  setText($("dTxRate"), F.formatRate(r.tx_rate));
  setText($("dRx"), F.formatBytes(r.rx));
  setText($("dTx"), F.formatBytes(r.tx));
  setText($("dAvg"), F.formatBytes(r.avg_per_min));

  const capInfo = $("capInfo");
  capInfo.replaceChildren();
  if (r.cap) {
    const pct = Math.min(100, (r.cap.used_bytes / r.cap.limit_bytes) * 100);
    const meter = el("div", `meter ${pct >= 100 ? "danger" : pct >= 80 ? "warn" : ""}`.trim());
    const fill = el("span");
    fill.style.width = `${pct}%`;
    meter.appendChild(fill);
    const period = r.cap.period === "daily" ? "today" : r.cap.period === "monthly" ? "this month" : "since the last reset";
    let text = `${F.formatBytes(r.cap.used_bytes)} of ${F.formatBytes(r.cap.limit_bytes)} used ${period}.`;
    if (r.cap.enforced) text += " Cap reached, so internet access is blocked.";
    else if (r.cap.notified) text += " Cap reached.";
    capInfo.append(meter, el("div", "cap-text", text));
  } else {
    capInfo.appendChild(el("div", "cap-text", "No cap set."));
  }
  setText($("dCap"), r.cap ? "Edit cap…" : "Set data cap…");
  $("dCapReset").hidden = !r.cap;

  const caps = (state.info && state.info.capabilities) || {};
  const blockBtn = $("dBlock");
  setText(blockBtn, r.blocked ? "Unblock internet" : "Block internet");
  blockBtn.classList.toggle("danger", !r.blocked);
  blockBtn.disabled = !caps.block || !r.can_block;
  setText($("blockHint"), blockHint(r));
  $("dKeep").checked = !!r.keep_forever;
  $("dRecord").checked = !!r.record_connections;
  setText($("dFocus"), r.focused ? "Stop focusing" : "Only track this app");

  if (forceChart || Date.now() - state.seriesAt > 5000) loadSeries();
}

async function loadSeries() {
  const key = state.selected;
  if (!key) return;
  state.seriesAt = Date.now();
  const series = await api.series(key, state.range);
  if (key !== state.selected || !series) return;
  state.series = series;
  drawChart();
}

function drawChart() {
  const series = state.series;
  if (!series || series.key !== state.selected) return;
  NetChart.render($("chart"), series, $("chartTip"));
  const unit = bucketLabel(series.bucket_minutes);
  setText($("chartTitle"), series.bucket_minutes === 1 ? "Per minute" : `Every ${unit}`);
  setText($("dPeakLabel"), `Busiest ${unit}`);
  setText($("dPeak"), series.peak ? F.formatBytes(series.peak.rx + series.peak.tx) : "—");
}

function select(key, reveal) {
  if (state.selected !== key) {
    state.selected = key;
    state.lastRow = null;
    state.series = null;
    $("chart").replaceChildren();
  }
  for (const [k, tr] of state.rowEls) {
    tr.classList.toggle("selected", k === key);
    tr.setAttribute("aria-selected", k === key ? "true" : "false");
  }
  renderDetails(true);
  if (reveal) {
    const tr = state.rowEls.get(key);
    if (tr) tr.scrollIntoView({ block: "nearest" });
  }
}

// ---- status, banner, footer -------------------------------------------------------

function renderStatus() {
  const info = state.info;
  if (!info) return;
  const s = info.status || {};
  const chip = $("stateChip");
  chip.className = `state ${s.state === "running" ? (s.message ? "warn" : "running") : s.state === "starting" ? "" : "error"}`;
  setText($("stateText"), STATE_LABELS[s.state] || s.state);

  const banner = $("banner");
  const actions = $("bannerActions");
  actions.replaceChildren();
  const messages = [];
  if (s.state !== "running" || s.message) messages.push(s.message || STATE_LABELS[s.state]);
  if (s.warning) messages.push(s.warning);
  if (s.state === "running" && !s.message && !s.warning) {
    banner.hidden = true;
  } else {
    banner.hidden = !messages.length;
    banner.classList.toggle("error", s.state === "error" || s.state === "unsupported");
    setText($("bannerText"), messages.join(" "));
    if (s.action && ACTION_LABELS[s.action]) {
      const b = el("button", "btn primary", ACTION_LABELS[s.action]);
      b.type = "button";
      b.addEventListener("click", () => helperOp(s.action === "start" ? "start" : "install", b));
      actions.appendChild(b);
    }
    if (s.state === "disabled") {
      const b = el("button", "btn primary", "Turn on recording");
      b.type = "button";
      b.addEventListener("click", () => saveSettings({ enabled: true }));
      actions.appendChild(b);
    }
  }

  const focus = info.settings.focus;
  $("focusBar").hidden = !focus.length;
  setText($("focusNames"), focus.map((a) => a.name).join(", "));
  const keep = (info.retention || F.NET_RETENTION).find((r) => r.minutes === info.settings.retention_minutes);
  setText($("footState"), STATE_LABELS[s.state] || "");
  setText($("footDb"), `Records: ${info.db.file} (${F.formatBytes(info.db.size)})`);
  setText($("footKeep"), `Keeps ${keep ? keep.label : "1 hour"} of history`);
}

async function helperOp(op, button) {
  if (button) button.disabled = true;
  try {
    const res = await api.helper(op);
    if (res && !res.ok && res.error) toast(res.error);
  } finally {
    if (button) button.disabled = false;
  }
}

function applyInfo(info) {
  if (!info) return;
  state.info = info;
  if (!applyInfo.done) {
    applyInfo.done = true;
    state.range = info.settings.range;
    state.autoSort = info.settings.auto_sort;
    $("autosort").setAttribute("aria-pressed", state.autoSort ? "true" : "false");
    const select = $("range");
    select.replaceChildren(
      ...info.ranges.map((r) => {
        const o = el("option", null, r.label);
        o.value = r.id;
        return o;
      })
    );
    select.value = state.range;
  }
  renderStatus();
  if ($("settingsDialog").open) fillSettings();
  if (state.view) render();
}

// ---- dialogs ----------------------------------------------------------------------

function rowOrInfo(key) {
  return (state.view && state.view.rows.find((r) => r.key === key)) || (state.lastRow && state.lastRow.key === key ? state.lastRow : null);
}

function openCap(key) {
  const row = rowOrInfo(key);
  if (!row) return;
  state.capKey = key;
  setText($("capTitle"), row.cap ? "Edit data cap" : "Set a data cap");
  setText($("capApp"), row.name);
  const amount = $("capAmount");
  const unit = $("capUnit");
  if (row.cap) {
    const gb = row.cap.limit_bytes / 1024 ** 3;
    if (gb >= 1024) {
      unit.value = "TB";
      amount.value = +(gb / 1024).toFixed(2);
    } else if (gb >= 1) {
      unit.value = "GB";
      amount.value = +gb.toFixed(2);
    } else {
      unit.value = "MB";
      amount.value = +(row.cap.limit_bytes / 1024 ** 2).toFixed(1);
    }
  } else {
    amount.value = "";
    unit.value = "GB";
  }
  const period = row.cap ? row.cap.period : "total";
  for (const radio of document.querySelectorAll('input[name="capPeriod"]')) radio.checked = radio.value === period;
  const caps = (state.info && state.info.capabilities) || {};
  let note;
  if (caps.block && row.can_block) note = "When it reaches the cap, its internet access is blocked and you get a notification. Reset or raise the cap to restore access.";
  else if (caps.block) note = "You get a notification when it reaches the cap. This entry isn't a program file, so it can't be blocked.";
  else note = "You get a notification when it reaches the cap. Blocking isn't available on this system.";
  setText($("capNote"), `${note} Usage counts while Usage Monitor is running.`);
  $("capError").hidden = true;
  $("capRemove").hidden = !row.cap;
  $("capDialog").showModal();
  amount.focus();
}

async function saveCap(e) {
  e.preventDefault();
  const amount = Number($("capAmount").value);
  const power = { MB: 2, GB: 3, TB: 4 }[$("capUnit").value] || 3;
  const period = (document.querySelector('input[name="capPeriod"]:checked') || {}).value || "total";
  const limit = amount * 1024 ** power;
  if (!(limit >= 1024 * 1024)) {
    $("capError").textContent = "Enter a cap of at least 1 MB.";
    $("capError").hidden = false;
    return;
  }
  const res = await act("set-cap", state.capKey, { limit_bytes: Math.round(limit), period });
  if (res && res.ok) $("capDialog").close();
}

function renderConns() {
  const q = $("connSearch").value.trim().toLowerCase();
  const list = state.conns.filter((c) => !q || String(c.domain || "").toLowerCase().includes(q) || c.remote.includes(q));
  const rows = list.map((c) => {
    const tr = el("tr");
    const seen = new Date(c.last_seen * 1000);
    tr.append(
      el("td", "domain", c.domain || "—"),
      el("td", null, c.remote),
      el("td", "num", c.port ? String(c.port) : "—"),
      el("td", null, String(c.proto).toUpperCase()),
      el("td", "num", F.formatBytes(c.rx)),
      el("td", "num", F.formatBytes(c.tx)),
      el("td", null, seen.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }))
    );
    return tr;
  });
  $("connRows").replaceChildren(...rows);
  $("connEmpty").hidden = rows.length > 0;
  setText($("connEmpty"), state.conns.length ? "No connections match the filter." : "No connections recorded yet.");
}

async function refreshConns() {
  if (!state.connKey || !$("connDialog").open) return;
  state.conns = (await api.connections(state.connKey)) || [];
  const row = rowOrInfo(state.connKey);
  $("connOff").hidden = !!(row && row.record_connections);
  renderConns();
}

let connTimer = null;
function openConnections(key) {
  const row = rowOrInfo(key);
  if (!row) return;
  state.connKey = key;
  state.conns = [];
  setText($("connApp"), row.name);
  $("connSearch").value = "";
  const info = state.info || {};
  let note;
  if (info.capabilities && info.capabilities.domains) note = "Domains come from DNS answers seen on this computer. Addresses without a name were reached directly or through encrypted DNS.";
  else if (info.settings && info.settings.reverse_dns) note = "Host names come from reverse DNS lookups and can differ from the name the app asked for.";
  else note = "Turn on reverse DNS in Settings to see host names for these addresses.";
  setText($("connNote"), note);
  renderConns();
  $("connDialog").showModal();
  refreshConns();
  clearInterval(connTimer);
  connTimer = setInterval(refreshConns, 3000);
}

function fillSettings() {
  const info = state.info;
  if (!info) return;
  const s = info.settings;
  $("sEnabled").checked = s.enabled;
  $("sAutostart").checked = info.autostart;
  setText(
    $("sAutostartLabel"),
    info.platform === "win32" ? "Start Usage Monitor when I sign in to Windows" : info.platform === "darwin" ? "Open Usage Monitor at login" : "Start Usage Monitor when I log in"
  );
  $("sReverse").checked = s.reverse_dns;
  const retention = $("sRetention");
  if (!retention.options.length) {
    retention.replaceChildren(
      ...info.retention.map((r) => {
        const o = el("option", null, r.label);
        o.value = String(r.minutes);
        return o;
      })
    );
    $("sOlder").replaceChildren(
      ...info.retention.map((r) => {
        const o = el("option", null, r.label);
        o.value = String(r.minutes);
        return o;
      })
    );
    $("sOlder").value = "1440";
  }
  retention.value = String(s.retention_minutes);
  setText($("sDbPath"), info.db.file);
  $("sDefault").hidden = !info.db.custom;

  const list = (id, items, action, label) => {
    const ul = $(id);
    if (!items.length) {
      ul.replaceChildren(el("li", "none", "None"));
      return;
    }
    ul.replaceChildren(
      ...items.map((a) => {
        const li = el("li");
        const name = el("span", null, a.name);
        name.title = a.key;
        const b = el("button", "link", label);
        b.type = "button";
        b.addEventListener("click", () => act(action, a.key));
        li.append(name, b);
        return li;
      })
    );
  };
  list("sFocus", s.focus, "unfocus", "Stop focusing");
  list("sIgnore", s.ignore, "unignore", "Stop ignoring");

  const helper = info.capabilities && info.capabilities.setup;
  $("sHelperSection").hidden = !helper;
  if (helper) {
    const st = info.status || {};
    const h = st.helper || {};
    const installed = !h.installed ? " It is not installed yet." : h.outdated ? " An update is available." : " It is installed and up to date.";
    setText($("sHelperText"), `Windows needs a helper with administrator rights to read per-app network events and add firewall rules. It runs as a scheduled task.${installed} Status: ${STATE_LABELS[st.state] || st.state}.`);
    $("sHelperRemove").hidden = !h.installed;
  }
  $("sLimits").replaceChildren(...info.limits.map((t) => el("li", null, t)));
}

async function saveSettings(patch) {
  const info = await api.setSettings(patch);
  if (info) applyInfo(info);
}

// ---- export -----------------------------------------------------------------------

function exportCsv() {
  if (!state.view) return;
  const byKey = new Map(state.view.rows.map((r) => [r.key, r]));
  const rows = state.order.map((k) => byKey.get(k)).filter(Boolean);
  const header = [
    "App",
    "Path",
    "Processes",
    "Download rate (bytes/s)",
    "Upload rate (bytes/s)",
    "Downloaded (bytes)",
    "Uploaded (bytes)",
    "Total (bytes)",
    "Average per minute (bytes)",
    "Blocked",
    "Data cap (bytes)",
    "Cap used (bytes)",
    "Cap period",
    "Kept forever",
    "Recording connections",
  ];
  const lines = [header];
  for (const r of rows) {
    lines.push([
      r.name,
      r.path || "",
      r.pids,
      Math.round(r.rx_rate),
      Math.round(r.tx_rate),
      r.rx,
      r.tx,
      r.total,
      Math.round(r.avg_per_min),
      r.blocked ? "yes" : "no",
      r.cap ? r.cap.limit_bytes : "",
      r.cap ? Math.round(r.cap.used_bytes) : "",
      r.cap ? r.cap.period : "",
      r.keep_forever ? "yes" : "no",
      r.record_connections ? "yes" : "no",
    ]);
  }
  const text = lines.map((cols) => cols.map(F.csvCell).join(",")).join("\r\n");
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  const slug = rangeInfo().label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  api.exportCsv(text, `network-usage-${slug}-${stamp}.csv`).then((res) => {
    if (res && res.ok) toast(`Exported ${rows.length} apps to ${res.file}`);
    else if (res && res.error) toast(res.error);
  });
}

// ---- events -----------------------------------------------------------------------

function bind() {
  $("search").addEventListener("input", (e) => {
    state.search = e.target.value;
    if (!state.paused) renderTable();
  });
  $("range").addEventListener("change", (e) => {
    state.range = e.target.value;
    state.resort = true;
    state.seriesAt = 0;
    api.setRange(state.range);
  });
  $("pause").addEventListener("click", () => {
    state.paused = !state.paused;
    $("pause").setAttribute("aria-pressed", state.paused ? "true" : "false");
    setText($("pause"), state.paused ? "Resume view" : "Pause view");
    $("pausedBar").hidden = !state.paused;
    if (!state.paused && state.latest) {
      state.view = state.latest;
      render();
    }
  });
  $("resume").addEventListener("click", () => $("pause").click());
  $("autosort").addEventListener("click", () => {
    state.autoSort = !state.autoSort;
    state.resort = true;
    $("autosort").setAttribute("aria-pressed", state.autoSort ? "true" : "false");
    saveSettings({ auto_sort: state.autoSort });
    renderTable();
  });
  $("export").addEventListener("click", exportCsv);
  $("openSettings").addEventListener("click", () => {
    fillSettings();
    $("settingsDialog").showModal();
  });
  $("clearFocus").addEventListener("click", () => act("clear-focus", null));

  for (const th of document.querySelectorAll("table.apps th")) {
    th.querySelector("button").addEventListener("click", () => {
      const col = th.dataset.col;
      if (state.sort.col === col) state.sort.dir = state.sort.dir === "desc" ? "asc" : "desc";
      else state.sort = { col, dir: col === "name" ? "asc" : "desc" };
      state.resort = true;
      renderTable();
    });
  }

  const tbody = $("rows");
  tbody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (tr) select(tr.dataset.key);
  });
  tbody.addEventListener("contextmenu", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    e.preventDefault();
    select(tr.dataset.key);
    api.rowMenu(tr.dataset.key);
  });
  $("tableWrap").addEventListener("keydown", (e) => {
    if (!state.order.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = state.order.indexOf(state.selected);
      const next = e.key === "ArrowDown" ? Math.min(state.order.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
      select(state.order[next], true);
    } else if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && state.selected) {
      e.preventDefault();
      api.rowMenu(state.selected);
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      $("search").focus();
      $("search").select();
    }
  });

  // details actions
  $("dCap").addEventListener("click", () => state.selected && openCap(state.selected));
  $("dCapReset").addEventListener("click", () => state.selected && act("reset-cap", state.selected));
  $("dBlock").addEventListener("click", () => {
    const row = rowOrInfo(state.selected);
    if (row) act(row.blocked ? "unblock" : "block", row.key);
  });
  $("dKeep").addEventListener("change", (e) => state.selected && act("keep-forever", state.selected, e.target.checked));
  $("dRecord").addEventListener("change", (e) => state.selected && act("record-connections", state.selected, e.target.checked));
  $("dConnections").addEventListener("click", () => state.selected && openConnections(state.selected));
  $("dFocus").addEventListener("click", () => {
    const row = rowOrInfo(state.selected);
    if (row) act(row.focused ? "unfocus" : "focus", row.key);
  });
  $("dIgnore").addEventListener("click", () => {
    const key = state.selected;
    if (!key) return;
    act("ignore", key).then((res) => {
      if (res && res.ok) {
        state.selected = null;
        state.lastRow = null;
        renderDetails(false);
      }
    });
  });
  $("dMore").addEventListener("click", () => state.selected && api.rowMenu(state.selected));

  // cap dialog
  $("capForm").addEventListener("submit", saveCap);
  $("capCancel").addEventListener("click", () => $("capDialog").close());
  $("capRemove").addEventListener("click", async () => {
    const res = await act("clear-cap", state.capKey);
    if (res && res.ok) $("capDialog").close();
  });

  // connections dialog
  $("connSearch").addEventListener("input", renderConns);
  $("connClose").addEventListener("click", () => $("connDialog").close());
  $("connDialog").addEventListener("close", () => clearInterval(connTimer));
  $("connEnable").addEventListener("click", async () => {
    await act("record-connections", state.connKey, true);
    $("connOff").hidden = true;
  });
  $("connDelete").addEventListener("click", async () => {
    await act("delete-connections", state.connKey);
    refreshConns();
  });

  // settings dialog
  $("sClose").addEventListener("click", () => $("settingsDialog").close());
  $("sEnabled").addEventListener("change", (e) => saveSettings({ enabled: e.target.checked }));
  $("sAutostart").addEventListener("change", (e) => saveSettings({ autostart: e.target.checked }));
  $("sReverse").addEventListener("change", (e) => saveSettings({ reverse_dns: e.target.checked }));
  $("sRetention").addEventListener("change", (e) => saveSettings({ retention_minutes: Number(e.target.value) }));
  $("sChoose").addEventListener("click", async () => applyInfo(await api.chooseFolder(false)));
  $("sDefault").addEventListener("click", async () => applyInfo(await api.chooseFolder(true)));
  $("sShow").addEventListener("click", () => api.openFolder());
  $("sDeleteOlder").addEventListener("click", async () => applyInfo(await api.deleteData("older", Number($("sOlder").value))));
  $("sDeleteAll").addEventListener("click", async () => applyInfo(await api.deleteData("all")));
  $("sHelperRepair").addEventListener("click", (e) => helperOp("install", e.target));
  $("sHelperRemove").addEventListener("click", (e) => helperOp("remove", e.target));

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawChart, 120);
  });
}

bind();
api.onState(applyInfo);
api.onToast(toast);
api.onUpdate((view) => {
  state.latest = view;
  if (state.paused) return;
  state.view = view;
  render();
});
api.onCommand((cmd) => {
  if (!cmd || typeof cmd.key !== "string") return;
  if (cmd.type === "select") select(cmd.key, true);
  else if (cmd.type === "cap") openCap(cmd.key);
  else if (cmd.type === "connections") openConnections(cmd.key);
});
api.getState().then(applyInfo);
