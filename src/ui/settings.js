const api = window.settingsApi;
const $ = (id) => document.getElementById(id);

const CHIP_LABELS = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["gemini", "Gemini"],
  ["grok", "Grok Build"],
  ["cursor", "Cursor"],
  ["copilot", "Copilot"],
  ["network", "Network speed"],
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
  setValue($("quiet"), s.quiet_hours.enabled);
  setValue($("quietStart"), s.quiet_hours.start);
  setValue($("quietEnd"), s.quiet_hours.end);
  $("quietStart").disabled = $("quietEnd").disabled = !s.quiet_hours.enabled;

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
    if (u.status === "available" && u.latest) text = `Version ${u.latest} is available; this copy can't update itself.`;
    if ((u.status === "skipped" || u.status === "error") && u.message) text += ` ${u.message}`;
    if (u.checked_at) text += ` Last checked ${relative(u.checked_at)}.`;
    status.textContent = text;
    status.className = `status-line${u.status === "error" ? " error" : ""}`;
  }
  renderPhone(next.phone);
  renderAccounts(next.accounts);
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
      el("span", "account-who", row.signed_in ? (row.account || "Signed in") : "Not signed in"),
    );
    block.append(head);
    if (row.detail) block.append(el("p", "hint", row.detail));
    if (row.choices && row.choices.length > 1) {
      for (const choice of row.choices) {
        const label = el("label", "radio");
        const input = el("input");
        input.type = "radio";
        input.name = `account-${row.id}`;
        input.checked = !!choice.active;
        input.addEventListener("change", () => {
          if (input.checked) switchAccount(row.id, choice.id);
        });
        label.append(input, el("span", null, choice.label));
        block.append(label);
      }
    }
    const button = el("button", "btn", row.signed_in ? "Switch account" : "Sign in");
    button.type = "button";
    button.addEventListener("click", () => switchAccount(row.id, null));
    block.append(button);
    if (row.login_command) block.append(el("p", "hint", `To update this meter's account, sign in with ${row.login_command}.`));
    return block;
  }));
}

async function switchAccount(id, accountId) {
  const result = await api.account(id, accountId);
  if (!result) return;
  if (result.view) render(result.view);
  if (result.message) toast(result.message);
  else if (result.error) toast(result.error);
}

function bind() {
  $("autostart").addEventListener("change", (e) => save({ autostart: e.target.checked }));
  $("chipsVisible").addEventListener("change", (e) => save({ chips_hidden: !e.target.checked }));
  $("chipsDocked").addEventListener("change", (e) => save({ chips_docked: e.target.checked }));
  $("interval").addEventListener("change", (e) => save({ poll_interval_secs: Number(e.target.value) }));
  $("threshold").addEventListener("change", (e) => save({ alert_threshold: Number(e.target.value) }));
  $("notifyLimit").addEventListener("change", (e) => save({ notify_on_limit_reached: e.target.checked }));
  $("forecast").addEventListener("change", (e) => save({ forecast_alerts: e.target.checked }));
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
}

bind();
api.onState(render);
api.get().then(render);
