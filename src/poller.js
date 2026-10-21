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
const backoff = {};
const pending = {};
const pendingScope = {};
let activePoll = null;
let activeKey = null;
const ADAPTER_TIMEOUT_MS = 12000;
const ACCOUNT_TIMEOUT_MS = 5000;
// While the screen is locked or the computer is idle, providers are asked at most this often.
const AWAY_INTERVAL_SECS = 60;

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

// Retry-After is seconds or a date; without one, each refusal in a row doubles the wait (1 min to 1 h).
function backoffMs(retryAfter, strikes) {
  const secs = Number(retryAfter);
  const asked = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - Date.now();
  return Math.min(Math.max(asked > 0 ? asked : 60_000 * 2 ** (strikes - 1), 60_000), 3_600_000);
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
      // The X Subscription setting only changes what Grok and Cursor read; other plans keep their
      // cache and history when it is switched.
      const selected = ["grok", "cursor"].includes(id) ? regime(cfg.subscription_regime) : "legacy";
      let scope;
      try {
        // The signed-in account, from the tool's own files. A token never keys the cache: it changes
        // on every refresh, which would split one account's readings and history.
        const account = adapters[id].accountRef
          ? await withTimeout(Promise.resolve().then(() => adapters[id].accountRef(cfg)), ACCOUNT_TIMEOUT_MS, id).catch(() => null) : null;
        scope = createHash("sha256").update(JSON.stringify([id, selected, cfg.accounts?.[id] || "", account || "unidentified"])).digest("hex").slice(0, 32);
        const cached = previous?.cached_readings?.[`${id}|${scope}`] || (prevById[id]?.cache_scope === scope ? prevById[id] : null);
        if (backoff[scope] && Date.now() < backoff[scope].until) {
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
        fresh.subscription_regime = selected;
        if (fresh && fresh._rateLimited) {
          const strikes = (backoff[scope]?.strikes || 0) + 1;
          backoff[scope] = { strikes, until: Date.now() + backoffMs(fresh._retryAfter, strikes) };
        } else if (fresh && fresh.status && fresh.status.state === "ok") {
          delete backoff[scope];
        }
        delete fresh._rateLimited;
        delete fresh._retryAfter;
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
          subscription_regime: selected,
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
  let away = false;

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
    const secs = cfg.poll_interval_secs || 5;
    timer = setInterval(tick, (away ? Math.max(secs, AWAY_INTERVAL_SECS) : secs) * 1000);
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
    // Away: slower; back: read at once, then at the chosen interval.
    setAway(next) {
      if (stopped || !!next === away) return;
      away = !!next;
      arm();
      if (!away) tick();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

module.exports = { start, pollOnce, AWAY_INTERVAL_SECS };
