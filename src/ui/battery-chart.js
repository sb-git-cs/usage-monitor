/* Shared SVG chart for the flyout and Insights. Each segment keeps recording gaps visible. */
window.drawBatteryChart = function (root, points, detail, compact = false) {
  // A new sample redraws the chart; someone inspecting it with the keyboard keeps focus and the reading.
  const focused = root.contains(document.activeElement);
  const kept = focused ? Number(root.dataset.selected) : NaN;
  root.replaceChildren();
  if (!points?.length) { root.textContent = "No battery observations yet."; return; }
  const ns = "http://www.w3.org/2000/svg";
  const make = (tag, attrs = {}, text) => {
    const el = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    if (text != null) el.textContent = text;
    return el;
  };
  const svg = make("svg", { viewBox: compact ? "0 0 800 100" : "0 0 800 180", role: "img", tabindex: "0", "aria-label": "Battery level from 0 to 100 percent. Shading indicates charging. Use arrow keys to inspect readings." });
  const first = points[0].t, span = Math.max(60000, points.at(-1).t - first);
  const x = (p) => 40 + (p.t - first) / span * 745;
  const bottom = compact ? 65 : 145, height = compact ? 55 : 125;
  const y = (p) => bottom - p.percent / 100 * height;
  for (const pct of [0, 50, 100]) {
    const row = bottom - pct / 100 * height;
    svg.append(make("line", { x1: 40, x2: 785, y1: row, y2: row, stroke: "currentColor", opacity: ".15" }), make("text", { x: 4, y: row + 4, fill: "currentColor", "font-size": 11 }, `${pct}%`));
  }
  let group = [];
  function flush() {
    if (!group.length) return;
    if (group[0].state === "charging") svg.append(make("rect", { x: x(group[0]), y: bottom - height, width: Math.max(2, x(group.at(-1)) - x(group[0])), height, fill: "#10b981", opacity: ".14" }));
    svg.append(make("polyline", { points: group.map((p) => `${x(p)},${y(p)}`).join(" "), fill: "none", stroke: "currentColor", "stroke-width": 2 }));
    if (group.length === 1) svg.append(make("circle", { cx: x(group[0]), cy: y(group[0]), r: 3, fill: "currentColor" }));
    group = [];
  }
  for (const p of points) {
    const prev = group.at(-1);
    if (prev && (p.g || p.t - prev.t > BatteryModel.GAP || p.state !== prev.state)) flush();
    group.push(p);
  }
  flush();
  svg.append(make("text", { x: 40, y: bottom + 29, fill: "currentColor", "font-size": 11 }, new Date(first).toLocaleString()),
    make("text", { x: 785, y: bottom + 29, fill: "currentColor", "font-size": 11, "text-anchor": "end" }, new Date(points.at(-1).t).toLocaleString()));
  const dot = make("circle", { r: 4, fill: "currentColor" });
  svg.append(dot);
  const at = Number.isFinite(kept) ? points.findIndex((p) => p.t >= kept) : -1;
  let selected = at >= 0 ? at : points.length - 1;
  const inspect = () => {
    const p = points[selected]; dot.setAttribute("cx", x(p)); dot.setAttribute("cy", y(p));
    root.dataset.selected = String(p.t);
    const text = `${new Date(p.t).toLocaleString()} · ${p.percent}% · ${p.state} · ${BatteryModel.label(p)}${p.source ? ` (${p.source})` : ""}`;
    if (detail) detail.textContent = text;
    svg.setAttribute("aria-label", `${text}. Use arrow keys to inspect readings.`);
  };
  svg.addEventListener("pointermove", (e) => {
    const rect = svg.getBoundingClientRect();
    const time = first + ((e.clientX - rect.left) / rect.width * 800 - 40) / 745 * span;
    selected = points.reduce((best, p, i) => Math.abs(p.t - time) < Math.abs(points[best].t - time) ? i : best, 0);
    inspect();
  });
  svg.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    selected = e.key === "Home" ? 0 : e.key === "End" ? points.length - 1 : Math.max(0, Math.min(points.length - 1, selected + (e.key === "ArrowRight" ? 1 : -1)));
    inspect();
  });
  inspect(); root.append(svg);
  if (focused) svg.focus({ preventScroll: true });
};
