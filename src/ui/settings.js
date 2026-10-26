const api = window.settingsApi;
const $ = (id) => document.getElementById(id);

const CHIP_LABELS = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["gemini", "Gemini"],
  ["grok", "Grok Build"],
  ["cursor", "Cursor"],
  ["copilot", "Copilot"],
  ["sessions", "Coding sessions"],
  ["network", "Network speed"],
  ["battery", "Battery"],
  ["cpu", "CPU"],
  ["mem", "Memory"],
  ["gpu", "GPU"],
  ["disk", "Disk"],
  ["space", "Storage"],
];

const UPDATE_TEXT = {
  idle: "Updates install automatically.",
  off: "Automatic updates are off.",
  checking: "Checking for updates…",
  "up-to-date": "Up to date.",
  downloading: "Downloading an update…",
  ready: "An update is ready and installs shortly.",
  installing: "Installing an update…",
  available: "A new version is available; this copy can't update itself.",
  skipped: "Not updated.",
  error: "Couldn't check for updates.",
};

const PLAN_IDS = ["claude", "codex", "gemini", "grok", "cursor", "copilot"];
const PLAN_NAMES = Object.fromEntries(CHIP_LABELS.filter(([key]) => PLAN_IDS.includes(key)));

let view = null;
let pairTimer = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    t.hidden = true;
  }, 4000);
}

async function save(patch) {
  const next = await api.set(patch);
  if (next) render(next);
  if (next && next.error) toast(next.error);
}

// Leaves a control alone while it has focus, so typing is never overwritten.
function setValue(node, value) {
  if (document.activeElement === node) return;
  if (node.type === "checkbox") node.checked = !!value;
  else if (node.value !== String(value)) node.value = String(value);
}

function fillSelect(select, values, label) {
  if (select.options.length) return;
  select.replaceChildren(...values.map((v) => {
    const o = el("option", null, label(v));
    o.value = String(v);
    return o;
  }));
}

function relative(ms) {
  if (!ms) return "never";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}

function renderPhone(phone) {
  const body = $("phoneBody");
  setValue($("phoneEnabled"), phone && phone.enabled);
  body.hidden = !(phone && phone.enabled);
  if (!phone || !phone.enabled) {
    clearInterval(pairTimer);
    $("pairing").hidden = true;
    $("pair").hidden = false;
    return;
  }
  const status = $("phoneStatus");
  if (phone.error) {
    status.textContent = phone.error;
    status.className = "status-line error";
  } else if (phone.listening) {
    const where = phone.addresses.length ? phone.addresses.map((a) => `${a}:${phone.port}`).join(", ") : `port ${phone.port}`;
    status.textContent = `Listening on ${where}.`;
    status.className = "status-line good";
  } else {
    status.textContent = "Starting…";
    status.className = "status-line";
  }
  setValue($("phonePort"), phone.port);

  const pairing = phone.pairing;
  const pairingWasHidden = $("pairing").hidden;
  $("pairing").hidden = !pairing;
  $("pair").hidden = !!pairing;
  if (pairing && pairingWasHidden) requestAnimationFrame(() => $("pairing").scrollIntoView({ block: "nearest" }));
  clearInterval(pairTimer);
  if (pairing) {
    if ($("pairQr").dataset.link !== pairing.link) {
      $("pairQr").src = pairing.qr || "";
      $("pairQr").dataset.link = pairing.link;
    }
    $("pairQr").hidden = !pairing.qr;
    $("pairAddress").textContent = phone.addresses.length ? phone.addresses.map((a) => `${a}:${phone.port}`).join("   ") : "No network address found";
    $("pairCode").textContent = pairing.code;
    const tick = () => {
      const left = Math.max(0, pairing.expires_at - Date.now());
      $("pairExpires").textContent = left ? `This code works for ${Math.ceil(left / 60000)} more minute${left > 60000 ? "s" : ""}, for one phone.` : "This code has expired.";
    };
    tick();
    pairTimer = setInterval(tick, 5000);
  }

  const list = $("devices");
  if (!phone.devices.length) {
    list.replaceChildren(el("li", "none", "None yet"));
  } else {
    list.replaceChildren(...phone.devices.map((d) => {
      const li = el("li");
      const name = el("span", null, `${d.name} · paired ${new Date(d.created_at).toLocaleDateString()} · last seen ${relative(d.last_seen)}${d.direct ? " · reads usage directly" : ""}`);
      const remove = el("button", "link", "Remove");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        const next = await api.phone("remove", d.id);
        if (next) render(next);
        toast(`${d.name} can no longer read this computer's meters.`);
      });
      li.append(name);
      if (d.direct) {
        const stop = el("button", "link", "Stop direct reading");
        stop.type = "button";
        stop.addEventListener("click", async () => {
          const next = await api.phone("unlink", d.id);
          if (next) render(next);
          toast(`${d.name} no longer receives sign-in tokens. Tokens it already has expire on their own.`);
        });
        li.append(stop);
      }
      li.append(remove);
      return li;
    }));
  }
}

function render(next) {
  if (!next) return;
  view = next;
  const s = next.settings;
  setValue($("combinedSubscription"), s.subscription_regime === "combined");
  $("version").textContent = `Version ${next.version}`;
  $("autostartLabel").textContent = next.login_label;
  setValue($("autostart"), s.autostart);
  setValue($("chipsVisible"), !s.chips_hidden);
  $("dockRow").hidden = next.platform !== "win32";
  setValue($("chipsDocked"), s.chips_docked);
  fillSelect($("interval"), next.intervals, (v) => `${v} seconds`);
  setValue($("interval"), s.poll_interval_secs);
  fillSelect($("threshold"), next.thresholds, (v) => `${v}% used`);
  setValue($("threshold"), s.alert_threshold);
  setValue($("notifyLimit"), s.notify_on_limit_reached);
  setValue($("forecast"), s.forecast_alerts);
  setValue($("autoResume"), s.auto_resume);
  $("autoResume").disabled = next.platform !== "win32";
  if (next.platform !== "win32") {
    $("autoResumeHint").textContent = "Claude Code sessions running in a terminal are listed on the flyout and the chips. Listing the other CLIs and resuming sessions automatically needs Windows; here a session stopped by a usage limit waits for you.";
    $("folderMenuHint").textContent = "The folder menu that opens the model picker in the right-clicked folder is registered on Windows.";
  }
  renderDisplay(next.display);
  setValue($("quiet"), s.quiet_hours.enabled);
  setValue($("quietStart"), s.quiet_hours.start);
  setValue($("quietEnd"), s.quiet_hours.end);
  $("quietStart").disabled = $("quietEnd").disabled = !s.quiet_hours.enabled;
  $("quietHint").textContent = s.quiet_hours.enabled && s.quiet_hours.start === s.quiet_hours.end ? "The same start and end time keeps notifications quiet all day." : "";

  const checks = $("chipChecks");
  if (!checks.children.length) {
    for (const [key, label] of CHIP_LABELS) {
      const row = el("label", "switch");
      const box = el("input");
      box.type = "checkbox";
      box.dataset.key = key;
      box.addEventListener("change", () => save(key === "network" ? { chips_show_network: box.checked } : { chips_show: { [key]: box.checked } }));
      row.append(box, el("span", null, label));
      checks.append(row);
    }
  }
  for (const box of checks.querySelectorAll("input")) {
    setValue(box, box.dataset.key === "network" ? s.chips_show_network : s.chips_show[box.dataset.key]);
  }

  setValue($("autoUpdate"), s.auto_update);
  for (const radio of document.querySelectorAll('input[name="channel"]')) radio.checked = radio.value === s.update_channel;
  const kind = next.update && next.update.kind;
  $("channelHint").textContent = kind === "git"
    ? "A Git copy follows its branch; the channel applies to installed copies."
    : "Beta installs pre-releases as soon as they are published.";
  const u = next.update;
  const status = $("updateStatus");
  if (u) {
    let text = UPDATE_TEXT[u.status] || "";
    if (u.status === "idle" && !["installer", "git"].includes(u.kind)) text = "Checks for updates automatically; this copy can't install them itself.";
    if (u.status === "ready" && !u.auto) text = "An update is ready and installs when Usage Monitor quits.";
    if (u.status === "available" && u.latest) text = `Version ${u.latest} is available; this copy can't update itself.`;
    if ((u.status === "skipped" || u.status === "error") && u.message) text += ` ${u.message}`;
    if (u.checked_at) text += ` Last checked ${relative(u.checked_at)}.`;
    status.textContent = text;
    status.className = `status-line${u.status === "error" ? " error" : ""}`;
    $("checkUpdates").disabled = ["checking", "downloading", "installing"].includes(u.status);
  }
  renderPhone(next.phone);
  renderAccounts(next.accounts);
}

// Theme, text size, compact cards and the order and visibility of the plans.
function renderDisplay(display) {
  if (!display) return;
  setValue($("theme"), display.theme);
  setValue($("scale"), display.scale);
  setValue($("compact"), display.compact);
  const order = [...(display.order || []).filter((id) => PLAN_IDS.includes(id)), ...PLAN_IDS.filter((id) => !(display.order || []).includes(id))];
  const hidden = display.hidden || [];
  const list = $("displayProviders");
  const focused = document.activeElement && list.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  list.replaceChildren(...order.map((id, i) => {
    const li = el("li", hidden.includes(id) ? "off" : "");
    const box = el("input");
    box.type = "checkbox";
    box.checked = !hidden.includes(id);
    box.dataset.focus = `show-${id}`;
    box.setAttribute("aria-label", `Show ${PLAN_NAMES[id]}`);
    box.addEventListener("change", () => save({ display: { hidden: box.checked ? hidden.filter((h) => h !== id) : [...hidden, id] } }));
    const move = (delta, label) => {
      const button = el("button", "order-btn", delta < 0 ? "↑" : "↓");
      button.type = "button";
      button.disabled = i + delta < 0 || i + delta >= order.length;
      button.dataset.focus = `${delta < 0 ? "up" : "down"}-${id}`;
      button.setAttribute("aria-label", `${label} ${PLAN_NAMES[id]}`);
      button.addEventListener("click", () => {
        const next = [...order];
        [next[i], next[i + delta]] = [next[i + delta], next[i]];
        save({ display: { order: next } });
      });
      return button;
    };
    li.append(box, el("span", "order-name", PLAN_NAMES[id]), move(-1, "Move up"), move(1, "Move down"));
    return li;
  }));
  // Reordering rebuilds the list; keep the keyboard on the control that was used.
  if (focused) {
    const again = list.querySelector(`[data-focus="${focused}"]`);
    if (again && !again.disabled) again.focus();
  }
}

let accountsSeen = "";

function renderAccounts(rows) {
  const key = JSON.stringify(rows || []);
  const root = $("accounts");
  if (key === accountsSeen && root.children.length) return;
  accountsSeen = key;
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    root.replaceChildren(el("p", "hint", "No tools to show yet."));
    return;
  }
  root.replaceChildren(...list.map((row) => {
    const block = el("div", "account");
    const head = el("div", "account-head");
    head.append(
      el("span", "account-name", row.label),
      el("span", `account-who${row.signed_in ? " signed-in" : ""}`, row.signed_in ? (row.account || "Signed in") : "Not signed in"),
    );
    block.append(head);
    if (row.detail) block.append(el("p", "hint", row.detail));
    // Every saved sign-in is a tab; the one in use is marked, the others switch with one click.
    if (row.choices && row.choices.length) {
      const tabs = el("div", "account-tabs");
      tabs.setAttribute("role", "group");
      tabs.setAttribute("aria-label", `${row.label} accounts`);
      for (const choice of row.choices) {
        const tab = el("button", `account-tab${choice.active ? " active" : ""}`, choice.label);
        tab.type = "button";
        tab.setAttribute("aria-pressed", choice.active ? "true" : "false");
        tab.title = choice.active ? `${row.label} uses ${choice.label}` : `Use ${choice.label} for ${row.label}`;
        if (!choice.active) tab.addEventListener("click", () => switchAccount(row.id, choice.id));
        tabs.append(tab);
        if (!choice.active && row.removable) {
          const remove = el("button", "account-remove", "×");
          remove.type = "button";
          remove.title = `Remove ${choice.label} from the saved ${row.label} sign-ins`;
          remove.setAttribute("aria-label", remove.title);
          remove.addEventListener("click", () => forgetAccount(row.id, choice.id));
          tabs.append(remove);
        }
      }
      block.append(tabs);
    }
    const button = el("button", "btn", row.signed_in || (row.choices && row.choices.length) ? "Add account" : "Sign in");
    button.type = "button";
    button.addEventListener("click", () => switchAccount(row.id, null));
    block.append(button);
    // Sign-ins are kept on their own; this says so, and saves the current one right now.
    if (row.removable && row.signed_in) {
      const saved = (row.choices || []).filter((c) => c.saved_at);
      const newest = Math.max(0, ...saved.map((c) => c.saved_at || 0));
      const keepRow = el("div", "account-keep");
      keepRow.append(el("span", "hint", saved.length
        ? `${saved.length} saved for quick switching${newest ? ` · last saved ${relative(newest)}` : ""}`
        : "Not saved yet"));
      const keep = el("button", "text-btn", "Keep current sign-in");
      keep.type = "button";
      keep.addEventListener("click", () => keepAccount(row.id));
      keepRow.append(keep);
      block.append(keepRow);
    }
    if (row.login_command) {
      block.append(el("p", "hint", row.choices && row.choices.length > 1
        ? `Click an account to use it; the tool switches too. Add account keeps the current sign-in and runs ${row.login_command}.`
        : `Add account keeps the current sign-in and runs ${row.login_command}; the new account then appears here.`));
    }
    return block;
  }));
}

async function keepAccount(id) {
  const result = await api.keepAccount(id);
  if (!result) return;
  if (result.view) render(result.view);
  if (result.message) toast(result.message);
}

async function forgetAccount(id, accountId) {
  const result = await api.forgetAccount(id, accountId);
  if (!result) return;
  if (result.view) render(result.view);
  if (result.message) toast(result.message);
  else if (result.error) toast(result.error);
}

async function switchAccount(id, accountId) {
  const result = await api.account(id, accountId);
  if (!result) return;
  if (result.view) render(result.view);
  if (result.message) toast(result.message);
  else if (result.error) toast(result.error);
}

function bind() {
  $("combinedSubscription").addEventListener("change", (e) => save({ subscription_regime: e.target.checked ? "combined" : "legacy" }));
  $("autostart").addEventListener("change", (e) => save({ autostart: e.target.checked }));
  $("chipsVisible").addEventListener("change", (e) => save({ chips_hidden: !e.target.checked }));
  $("chipsDocked").addEventListener("change", (e) => save({ chips_docked: e.target.checked }));
  $("interval").addEventListener("change", (e) => save({ poll_interval_secs: Number(e.target.value) }));
  $("threshold").addEventListener("change", (e) => save({ alert_threshold: Number(e.target.value) }));
  $("notifyLimit").addEventListener("change", (e) => save({ notify_on_limit_reached: e.target.checked }));
  $("forecast").addEventListener("change", (e) => save({ forecast_alerts: e.target.checked }));
  $("autoResume").addEventListener("change", (e) => save({ auto_resume: e.target.checked }));
  $("quiet").addEventListener("change", (e) => save({ quiet_hours: { enabled: e.target.checked } }));
  $("quietStart").addEventListener("change", (e) => e.target.value && save({ quiet_hours: { start: e.target.value } }));
  $("quietEnd").addEventListener("change", (e) => e.target.value && save({ quiet_hours: { end: e.target.value } }));
  $("autoUpdate").addEventListener("change", (e) => save({ auto_update: e.target.checked }));
  for (const radio of document.querySelectorAll('input[name="channel"]')) {
    radio.addEventListener("change", () => radio.checked && save({ update_channel: radio.value }));
  }
  $("checkUpdates").addEventListener("click", () => api.checkUpdates());
  $("openLogs").addEventListener("click", () => api.openLogs());
  $("phoneEnabled").addEventListener("change", (e) => save({ phone_enabled: e.target.checked }));
  $("phonePort").addEventListener("change", (e) => {
    const port = Number(e.target.value);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) save({ phone_port: port });
    else toast("Use a port between 1024 and 65535.");
  });
  $("pair").addEventListener("click", async () => render(await api.phone("pair")));
  $("cancelPair").addEventListener("click", async () => render(await api.phone("cancel")));
  $("openNetwork").addEventListener("click", () => api.openNetwork());
  $("theme").addEventListener("change", (e) => save({ display: { theme: e.target.value } }));
  $("scale").addEventListener("change", (e) => save({ display: { scale: Number(e.target.value) } }));
  $("compact").addEventListener("change", (e) => save({ display: { compact: e.target.checked } }));
  bindNav();
}

// Section links scroll the settings; the link for the section in view is marked.
function bindNav() {
  const links = [...document.querySelectorAll(".nav-link")];
  const main = $("settings");
  for (const link of links) {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.querySelector(link.getAttribute("href"));
      if (target) target.scrollIntoView({ block: "start" });
      mark(link);
    });
  }
  function mark(active) {
    for (const link of links) {
      link.classList.toggle("active", link === active);
      if (link === active) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  }
  function spy() {
    const top = main.getBoundingClientRect().top;
    let current = links[0];
    for (const link of links) {
      const section = document.querySelector(link.getAttribute("href"));
      if (section && section.getBoundingClientRect().top - top <= 40) current = link;
    }
    // At the very bottom the last sections may never reach the top.
    if (main.scrollTop + main.clientHeight >= main.scrollHeight - 2) current = links.at(-1);
    mark(current);
  }
  main.addEventListener("scroll", spy, { passive: true });
  spy();
}

bind();
api.onState(render);
api.get().then(render);
