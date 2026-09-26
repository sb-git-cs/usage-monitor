// Stacked column chart of per-bucket download (bottom) and upload (top).
// Plain SVG built through the DOM, so it works under the window's strict CSP.
const NetChart = (() => {
  const SVG = "http://www.w3.org/2000/svg";
  const HEIGHT = 170;
  const PAD = { top: 10, right: 6, bottom: 22, left: 58 };
  const GAP = 2;
  const MAX_BAR = 24;
  const RADIUS = 4;

  function el(name, attrs, parent) {
    const node = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    if (parent) parent.appendChild(node);
    return node;
  }

  // Clean axis steps in binary units: 1, 2, 5 x 1024^k bytes.
  function niceMax(max) {
    if (!(max > 0)) return { top: 1024, step: 256 };
    const unit = 1024 ** Math.max(0, Math.floor(Math.log(max) / Math.log(1024)));
    for (const m of [0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]) {
      const step = m * unit;
      if (step * 4 >= max) return { top: step * Math.max(1, Math.ceil(max / step)), step };
    }
    return { top: max, step: max / 4 };
  }

  // Rounded data-end at the top, square at the baseline.
  function topRounded(x, y, w, h) {
    const r = Math.min(RADIUS, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function timeLabel(ms, bucketMinutes, withDate) {
    const d = new Date(ms);
    const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (bucketMinutes >= 1440) return d.toLocaleDateString([], { month: "short", day: "numeric" });
    return withDate ? `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}` : hm;
  }

  function render(container, series, tip) {
    container.textContent = "";
    const width = Math.max(220, container.clientWidth || 320);
    const points = (series && series.points) || [];
    const svg = el("svg", { width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, class: "chart-svg", role: "img" });
    container.appendChild(svg);
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const max = points.reduce((m, p) => Math.max(m, p.rx + p.tx), 0);
    const { top, step } = niceMax(max);
    const y = (v) => PAD.top + plotH - (v / top) * plotH;

    for (let v = 0; v <= top + step / 2; v += step) {
      const gy = Math.round(y(v)) + 0.5;
      el("line", { x1: PAD.left, x2: width - PAD.right, y1: gy, y2: gy, class: v === 0 ? "chart-base" : "chart-grid" }, svg);
      const label = el("text", { x: PAD.left - 8, y: gy + 4, class: "chart-axis", "text-anchor": "end" }, svg);
      label.textContent = NetFormat.formatBytes(v);
    }

    if (!points.length) return;
    const bucket = series.bucket_minutes || 1;
    const multiDay = points.length > 1 && new Date(points[0].start_ms).toDateString() !== new Date(points[points.length - 1].start_ms).toDateString();
    const slot = plotW / points.length;
    const barW = Math.max(1, Math.min(MAX_BAR, slot - GAP));
    const band = el("rect", { class: "chart-hover", x: 0, y: PAD.top, width: slot, height: plotH, visibility: "hidden" }, svg);
    const bars = el("g", {}, svg);
    const hits = el("g", {}, svg);
    svg.setAttribute("aria-label", `Usage per ${bucket === 1 ? "minute" : `${bucket} minutes`}, peak ${NetFormat.formatBytes(max)}`);

    points.forEach((p, i) => {
      const x = PAD.left + i * slot + (slot - barW) / 2;
      const base = PAD.top + plotH;
      const hRx = p.rx > 0 ? Math.max(1, (p.rx / top) * plotH) : 0;
      const hTx = p.tx > 0 ? Math.max(1, (p.tx / top) * plotH) : 0;
      // A 2px surface gap separates the two segments of a stack.
      const gap = hRx && hTx ? GAP : 0;
      if (hRx) {
        const yRx = base - hRx;
        if (hTx) el("rect", { x, y: yRx, width: barW, height: hRx, class: "bar-rx" }, bars);
        else el("path", { d: topRounded(x, yRx, barW, hRx), class: "bar-rx" }, bars);
      }
      if (hTx) {
        const yTx = base - hRx - gap - hTx;
        el("path", { d: topRounded(x, yTx, barW, hTx), class: "bar-tx" }, bars);
      }
      const hit = el("rect", { x: PAD.left + i * slot, y: PAD.top, width: slot, height: plotH, class: "chart-hit" }, hits);
      hit.addEventListener("mouseenter", () => {
        band.setAttribute("x", PAD.left + i * slot);
        band.setAttribute("visibility", "visible");
        if (!tip) return;
        const end = p.start_ms + bucket * 60000;
        tip.replaceChildren();
        const head = document.createElement("div");
        head.className = "tip-head";
        head.textContent = bucket === 1 ? timeLabel(p.start_ms, 1, multiDay) : `${timeLabel(p.start_ms, bucket, multiDay)} – ${timeLabel(end, bucket, false)}`;
        tip.appendChild(head);
        for (const [cls, label, value] of [["rx", "Download", p.rx], ["tx", "Upload", p.tx], [null, "Total", p.rx + p.tx]]) {
          const row = document.createElement("div");
          row.className = "tip-row";
          const key = document.createElement("span");
          key.className = cls ? `swatch ${cls}` : "swatch none";
          const name = document.createElement("span");
          name.textContent = label;
          const val = document.createElement("span");
          val.className = "tip-value";
          val.textContent = NetFormat.formatBytes(value);
          row.append(key, name, val);
          tip.appendChild(row);
        }
        tip.hidden = false;
      });
      hit.addEventListener("mousemove", (e) => {
        if (!tip) return;
        const pad = 14;
        const w = tip.offsetWidth;
        const h = tip.offsetHeight;
        let left = e.clientX + pad;
        let topPx = e.clientY - h - pad;
        if (left + w > window.innerWidth - 8) left = e.clientX - w - pad;
        if (topPx < 8) topPx = e.clientY + pad;
        tip.style.left = `${left}px`;
        tip.style.top = `${topPx}px`;
      });
      hit.addEventListener("mouseleave", () => {
        band.setAttribute("visibility", "hidden");
        if (tip) tip.hidden = true;
      });
    });

    const labels = points.length > 2 ? [0, Math.floor(points.length / 2), points.length - 1] : points.map((_, i) => i);
    labels.forEach((i, n) => {
      const anchor = n === 0 ? "start" : n === labels.length - 1 ? "end" : "middle";
      const cx = anchor === "start" ? PAD.left : anchor === "end" ? width - PAD.right : PAD.left + (i + 0.5) * slot;
      const t = el("text", { x: cx, y: HEIGHT - 6, class: "chart-axis", "text-anchor": anchor }, svg);
      t.textContent = timeLabel(points[i].start_ms, bucket, multiDay && n === 0);
    });
  }

  return { render, niceMax };
})();
