const claude = require("./adapters/claude");
const codex = require("./adapters/codex");
const gemini = require("./adapters/gemini");
const grok = require("./adapters/grok");
const { PROVIDERS, applyLocalResets } = require("./models");
const cache = require("./cache");

const adapters = { claude, codex, gemini, grok };
const backoffUntil = {};
const pending = {};
let activePoll = null;
const ADAPTER_TIMEOUT_MS = 12000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error(`${label || "op"} timeout`), { code: "POLL_TIMEOUT" })), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function mergeWithCache(fresh, cached) {
  if (!cached) return fresh;
  const state = fresh.status && fresh.status.state;
  if (state === "ok") return fresh;
  if ((state === "fetch_failed" || state === "stale") && cached.windows && cached.windows.length) {
    const age = Math.max(0, (Date.now() - Date.parse(cached.fetched_at || 0)) / 1000);
    return {
      ...cached,
      status: { state: "stale", age_secs: Math.round(age) },
      source: "cache",
    };
  }
  return fresh;
}

async function collect(cfg) {
  const previous = cache.loadSnapshot();
  const prevById = {};
  for (const p of (previous && previous.providers) || []) prevById[p.id] = p;

  const results = await Promise.all(
    PROVIDERS.map(async ({ id }) => {
      try {
        if (backoffUntil[id] && Date.now() < backoffUntil[id]) {
          const cached = prevById[id];
          if (cached && cached.windows.length) {
            const age = Math.max(0, (Date.now() - Date.parse(cached.fetched_at || 0)) / 1000);
            return { ...cached, status: { state: "stale", age_secs: Math.round(age) }, source: "cache" };
          }
          if (cached) return cached;
        }
        // Keep timed-out work until consumed; token refreshes must never overlap.
        if (!pending[id]) pending[id] = Promise.resolve().then(() => adapters[id].fetchUsage(cfg));
        const fresh = await withTimeout(pending[id], ADAPTER_TIMEOUT_MS, id);
        delete pending[id];
        if (fresh && fresh._rateLimited) {
          backoffUntil[id] = Date.now() + 60 * 1000;
          delete fresh._rateLimited;
        } else if (fresh && fresh.status && fresh.status.state === "ok") {
          delete backoffUntil[id];
        }
        return mergeWithCache(fresh, prevById[id]);
      } catch (err) {
        if (err.code !== "POLL_TIMEOUT") delete pending[id];
        const failed = {
          id,
          display_name: adapters[id].displayName,
          status: { state: "fetch_failed", message: String(err.message || err) },
          plan: null,
          windows: [],
          fetched_at: new Date().toISOString(),
          source: "none",
        };
        return mergeWithCache(failed, prevById[id]);
      }
    })
  );

  const snapshot = {
    generated_at: new Date().toISOString(),
    poll_interval_secs: cfg.poll_interval_secs || 5,
    providers: results,
  };
  const { snapshot: next } = applyLocalResets(snapshot);
  try { cache.saveSnapshot(next); } catch (err) { console.error("cache write failed", err.message); }
  return next;
}

function pollOnce(cfg) {
  if (!activePoll) activePoll = collect(cfg).finally(() => { activePoll = null; });
  return activePoll;
}

function start(cfg, onSnapshot) {
  let timer = null;
  let inflight = false;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    if (inflight) return;
    inflight = true;
    try {
      const snap = await pollOnce(cfg);
      if (!stopped) onSnapshot(snap);
    } catch (err) {
      console.error("poll failed", err.message);
    } finally {
      inflight = false;
    }
  }

  function arm() {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, (cfg.poll_interval_secs || 5) * 1000);
  }

  const cached = cache.loadSnapshot();
  if (cached) onSnapshot(applyLocalResets({ ...cached, providers: cached.providers.map((p) =>
    p.windows.length ? { ...p, status: { state: "stale" }, source: "cache" } : p
  ) }).snapshot);
  tick();
  arm();
  return {
    refresh: tick,
    setIntervalSecs(secs) {
      cfg.poll_interval_secs = secs;
      arm();
      tick();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

module.exports = { start, pollOnce };
