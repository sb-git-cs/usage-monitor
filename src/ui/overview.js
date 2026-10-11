// Shared by the flyout and regression tests; only current readings drive advice.
(function (root) {
  function summarize(providers = [], threshold = 80, now = Date.now()) {
    let reporting = 0;
    let attention = 0;
    let unavailable = 0;
    let nextReset = null;
    for (const p of providers) {
      const windows = (p.windows || []).filter((w) => Number.isFinite(w.used_pct));
      if (p.status?.state !== "ok" || !windows.length) {
        unavailable++;
        continue;
      }
      reporting++;
      if (windows.some((w) => w.used_pct >= threshold ||
        (Date.parse(w.forecast_at) > now && Date.parse(w.forecast_at) < Date.parse(w.resets_at)))) attention++;
      for (const w of windows) {
        const reset = Date.parse(w.resets_at);
        if (reset > now && (!nextReset || reset < nextReset.at)) {
          nextReset = { at: reset, provider: p.display_name, label: w.label || w.kind };
        }
      }
    }
    return { reporting, attention, unavailable, nextReset };
  }
  const api = { summarize };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.UsageOverview = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
