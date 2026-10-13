const claude = require("./adapters/claude");
const codex = require("./adapters/codex");
const gemini = require("./adapters/gemini");
const grok = require("./adapters/grok");
const cursor = require("./adapters/cursor");
const copilot = require("./adapters/copilot");
const { PROVIDERS, OPTIONAL_PROVIDERS, applyLocalResets } = require("./models");
const cache = require("./cache");
const { createHash } = require("node:crypto");
const { regime } = require("./subscription");

const adapters = { claude, codex, gemini, grok, cursor, copilot };
const backoffUntil = {};
const pending = {};
const pendingScope = {};
let activePoll = null;
let activeKey = null;
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
      let scope;
      try {
        const token = adapters[id].linkToken ? await adapters[id].linkToken(cfg) : null;
        scope = createHash("sha256").update(JSON.stringify([id, regime(cfg.subscription_regime), cfg.accounts?.[id] || "", token?.account_id || token?.user_id || token?.access_token || "unidentified"])).digest("hex").slice(0, 32);
        const cached = previous?.cached_readings?.[`${id}|${scope}`] || (prevById[id]?.cache_scope === scope ? prevById[id] : null);
        if (backoffUntil[scope] && Date.now() < backoffUntil[scope]) {
          if (cached && cached.windows.length) {
            const age = Math.max(0, (Date.now() - Date.parse(cached.fetched_at || 0)) / 1000);
            return { ...cached, status: { state: "stale", age_secs: Math.round(age) }, source: "cache" };
          }
          if (cached) return cached;
        }
        // Keep timed-out work until consumed; token refreshes must never overlap.
        if (pending[id] && pendingScope[id] && pendingScope[id] !== scope) {
          await withTimeout(pending[id], ADAPTER_TIMEOUT_MS, id);
          delete pending[id];
        }
        if (!pending[id]) {
          pendingScope[id] = scope;
          pending[id] = Promise.resolve().then(() => adapters[id].fetchUsage(cfg));
        }
        const fresh = await withTimeout(pending[id], ADAPTER_TIMEOUT_MS, id);
        delete pending[id];
        fresh.cache_scope = scope;
        fresh.subscription_regime = regime(cfg.subscription_regime);
        if (fresh && fresh._rateLimited) {
          backoffUntil[scope] = Date.now() + 60 * 1000;
          delete fresh._rateLimited;
        } else if (fresh && fresh.status && fresh.status.state === "ok") {
          delete backoffUntil[scope];
        }
        return mergeWithCache(fresh, cached);
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
          cache_scope: scope,
          subscription_regime: regime(cfg.subscription_regime),
        };
        return mergeWithCache(failed, scope ? previous?.cached_readings?.[`${id}|${scope}`] || (prevById[id]?.cache_scope === scope ? prevById[id] : null) : null);
      }
    })
  );

  const snapshot = {
    generated_at: new Date().toISOString(),
    poll_interval_secs: cfg.poll_interval_secs || 5,
    subscription_regime: regime(cfg.subscription_regime),
    providers: results.filter((provider) => {
      const state = provider.status && provider.status.state;
      return !(OPTIONAL_PROVIDERS.has(provider.id) && state === "not_installed");
    }),
  };
  const { snapshot: next } = applyLocalResets(snapshot);
  try { cache.saveSnapshot(next); } catch (err) { console.error("cache write failed", err.message); }
  return next;
}

function pollOnce(cfg) {
  const key = JSON.stringify([regime(cfg.subscription_regime), cfg.accounts || {}]);
  if (activePoll && activeKey !== key) return activePoll.then(() => pollOnce(cfg));
  if (!activePoll) {
    activeKey = key;
    const captured = { ...cfg, accounts: { ...cfg.accounts } };
    activePoll = collect(captured).finally(() => { activePoll = null; activeKey = null; });
  }
  return activePoll;
}

function start(cfg, onSnapshot) {
  let timer = null;
  let inflight = false;
  let stopped = false;
  let requested = false;

  async function tick() {
    if (stopped) return;
    if (inflight) { requested = true; return; }
    inflight = true;
    try {
      const selected = JSON.stringify([regime(cfg.subscription_regime), cfg.accounts || {}]);
      const snap = await pollOnce(cfg);
      if (!stopped && selected === JSON.stringify([regime(cfg.subscription_regime), cfg.accounts || {}])) onSnapshot(snap);
      else requested = true;
    } catch (err) {
      console.error("poll failed", err.message);
    } finally {
      inflight = false;
      if (requested && !stopped) { requested = false; tick(); }
    }
  }

  function arm() {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, (cfg.poll_interval_secs || 5) * 1000);
  }

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
