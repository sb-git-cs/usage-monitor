const claude = require("./adapters/claude");
const codex = require("./adapters/codex");
const gemini = require("./adapters/gemini");
const grok = require("./adapters/grok");
const { PROVIDERS, applyLocalResets } = require("./models");
const cache = require("./cache");

const adapters = { claude, codex, gemini, grok };
const backoffUntil = {};
const ADAPTER_TIMEOUT_MS = 12000;
const POLL_WATCHDOG_MS = 18000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label || "op"} timeout`)), ms);
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

async function pollOnce(cfg) {
  const previous = cache.loadSnapshot();
  const prevById = {};
  for (const p of (previous && previous.providers) || []) prevById[p.id] = p;

  const results = await Promise.all(
    PROVIDERS.map(async ({ id }) => {
      try {
        if (backoffUntil[id] && Date.now() < backoffUntil[id]) {
          const cached = prevById[id];
          if (cached) {
            const age = Math.max(0, (Date.now() - Date.parse(cached.fetched_at || 0)) / 1000);
            return { ...cached, status: { state: "stale", age_secs: Math.round(age) }, source: "cache" };
          }
        }
        const fresh = await withTimeout(adapters[id].fetchUsage(cfg), ADAPTER_TIMEOUT_MS, id);
        if (fresh && fresh._rateLimited) {
          backoffUntil[id] = Date.now() + 60 * 1000;
          delete fresh._rateLimited;
        } else if (fresh && fresh.status && fresh.status.state === "ok") {
          delete backoffUntil[id];
        }
        return mergeWithCache(fresh, prevById[id]);
      } catch (err) {
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
  cache.saveSnapshot(next);
  return next;
}

function start(cfg, onSnapshot) {
  let timer = null;
  let inflight = false;
  let inflightAt = 0;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    if (inflight) {
      if (Date.now() - inflightAt < POLL_WATCHDOG_MS) return;
      inflight = false;
    }
    inflight = true;
    inflightAt = Date.now();
    try {
      const snap = await withTimeout(pollOnce(cfg), POLL_WATCHDOG_MS, "poll");
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
  if (cached) onSnapshot(cached);
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
