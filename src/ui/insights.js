const api = window.insightsApi;
const $ = (id) => document.getElementById(id);
const names = { claude: "Claude Code", codex: "Codex", gemini: "Gemini", grok: "Grok Build", cursor: "Cursor", copilot: "Copilot", x_subscription: "X Subscription" };
let state;
let order = [];
function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
function value(id, value) { if (document.activeElement !== $(id)) $(id).value = value; }
function message(result) { $("message").textContent = result?.error || (result?.ok ? "Saved." : ""); }
const bytes = (n) => `${(n / 1e9).toFixed(2)} GB`;
function chart(canvas, points) {
  canvas.width = Math.max(400, Math.round(canvas.getBoundingClientRect().width * 2)); canvas.height = 240;
  const right = canvas.width - 20;
  const c = canvas.getContext("2d"); const muted = getComputedStyle(document.body).getPropertyValue("--muted");
  c.strokeStyle = muted; c.globalAlpha = .3;
  for (const y of [20, 110, 200]) { c.beginPath(); c.moveTo(38, y); c.lineTo(right, y); c.stroke(); }
  c.globalAlpha = 1; c.fillStyle = muted; c.font = "18px Segoe UI"; c.fillText("100", 0, 25); c.fillText("0", 12, 205);
  const from = points[0].t, span = Math.max(1, points.at(-1).t - from);
  const colors = ["#60a5fa", "#f59e0b", "#22c55e", "#c084fc"];
  let cycle, index = -1;
  for (const p of points) {
    const x = 40 + (p.t - from) / span * (right - 40), y = 200 - Math.min(100, Math.max(0, p.used)) * 1.8;
    if (p.cycle !== cycle) { if (cycle !== undefined) c.stroke(); cycle = p.cycle; index++; c.beginPath(); c.strokeStyle = colors[index % colors.length]; c.moveTo(x, y); }
    else c.lineTo(x, y);
    c.fillStyle = colors[index % colors.length]; c.fillRect(x - 3, y - 3, 6, 6);
  }
  c.stroke();
}
function render(s) {
  state = s;
  const light = s.display.theme === "light" || (s.display.theme === "system" && !s.dark);
  document.body.classList.toggle("light", light); document.body.style.fontSize = `${14 * s.display.scale / 100}px`;
  $("history").replaceChildren();
  for (const series of s.series) {
    const card = node("article", null, "chart-card");
    card.append(node("h3", `${names[series.provider]} · ${series.label}`), node("p", `Account ${series.account} · ${series.points.length} observations`, "meta"));
    const canvas = node("canvas"); canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", `${series.label}: ${series.points[0].used}% to ${series.points.at(-1).used}% used across ${new Set(series.points.map((p) => p.cycle)).size} reset windows`);
    card.append(canvas, node("p", `${new Date(series.points[0].t).toLocaleString()} — ${new Date(series.points.at(-1).t).toLocaleString()}`, "meta"));
    $("history").append(card); chart(canvas, series.points);
  }
  if (!s.series.length) $("history").append(node("p", "No observations in this period yet. History starts when a current numeric reading is received."));
  $("events").replaceChildren();
  for (const e of s.events) { const row = node("div", null, "event"); row.append(node("strong", e.title), node("p", e.body), node("span", `${new Date(e.at).toLocaleString()} · ${e.delivery === "requested" ? "Delivery requested" : e.delivery}`, "meta")); $("events").append(row); }
  if (!s.events.length) $("events").append(node("p", "No quota or network warnings recorded yet."));
  $("snoozeState").textContent = s.snooze_until > Date.now() ? `Alerts snoozed until ${new Date(s.snooze_until).toLocaleTimeString()}. Events are still recorded.` : "Alerts active. Your quiet-hours settings still apply.";
  value("limit", s.budget.limit / 1e9); value("day", s.budget.day);
  $("budgetStats").replaceChildren();
  for (const [label, amount] of [["Captured this cycle", bytes(s.budget.used)], ["Allowance", s.budget.limit ? bytes(s.budget.limit) : "Off"], ["Projected at observed pace", s.budget.projected == null ? "Needs 24h of observations" : bytes(s.budget.projected)]]) {
    const item = node("div", label, "meta"); item.append(node("strong", amount)); $("budgetStats").append(item);
  }
  $("budgetStats").append(node("p", `Cycle ${new Date(s.budget.start).toLocaleDateString()}–${new Date(s.budget.end).toLocaleDateString()}. Recording began ${new Date(s.budget.observedSince).toLocaleDateString()}. Gaps are excluded.`, "meta"));
  $("diagnostics").replaceChildren(node("p", `Storage: ${s.diagnostics.storage} · Network: ${s.diagnostics.network.state} · ${s.diagnostics.network.coverage}`));
  for (const p of s.diagnostics.providers) {
    const row = node("div", null, "diagnostic section-head"); row.append(node("span", `${names[p.id]} · ${p.state} · last success ${p.last_success ? new Date(p.last_success).toLocaleString() : "not recorded"}`));
    const login = node("button", "Sign-in / account settings"); login.onclick = async () => { const r = await api.action("login", p.id); $("message").textContent = r?.error || r?.message || "Sign-in opened."; }; row.append(login); $("diagnostics").append(row);
  }
  if (!$("displayForm").contains(document.activeElement) && !$("displayForm").dataset.dirty) {
    value("theme", s.display.theme); value("scale", s.display.scale); $("compact").checked = s.display.compact;
    order = [...s.display.order]; renderProviders(s.display.hidden);
  }
}
function renderProviders(hidden) {
  $("providers").replaceChildren();
  order.forEach((id, index) => {
    const row = node("div", null, "provider-choice"); const label = node("label"); const check = node("input"); check.type = "checkbox"; check.dataset.id = id; check.checked = !hidden.includes(id); label.append(check, node("span", names[id]));
    const up = node("button", "Move up"); up.type = "button"; up.disabled = !index; up.setAttribute("aria-label", `Move ${names[id]} up`);
    up.onclick = () => { $("displayForm").dataset.dirty = "true"; const hiddenNow = [...$("providers").querySelectorAll("input")].filter((e) => !e.checked).map((e) => e.dataset.id); [order[index - 1], order[index]] = [order[index], order[index - 1]]; renderProviders(hiddenNow); };
    row.append(label, up); $("providers").append(row);
  });
}
async function load() { try { const s = await api.get(Number($("period").value)); if (s) render(s); } catch { $("message").textContent = "Could not load insights. Try reopening this window."; } }
$("period").onchange = load;
$("displayForm").onchange = () => { $("displayForm").dataset.dirty = "true"; };
$("snooze").onchange = async () => { message(await api.action("snooze", Number($("snooze").value))); await load(); };
$("budgetForm").onsubmit = async (e) => { e.preventDefault(); message(await api.action("budget", { limit: Number($("limit").value) * 1e9, day: Number($("day").value) })); await load(); };
$("displayForm").onsubmit = async (e) => { e.preventDefault(); const result = await api.action("display", { theme: $("theme").value, scale: Number($("scale").value), compact: $("compact").checked, order, hidden: [...$("providers").querySelectorAll("input")].filter((e) => !e.checked).map((e) => e.dataset.id) }); message(result); if (result?.ok) delete $("displayForm").dataset.dirty; await load(); };
$("refresh").onclick = () => api.action("retry"); $("network").onclick = () => api.action("network");
for (const [id, format] of [["csv", "csv"], ["json", "json"], ["support", "diagnostics"]]) $(id).onclick = async () => message(await api.export(format, Number($("period").value)));
load(); setInterval(() => { if (!document.querySelector("form:focus-within")) load(); }, 10000);
