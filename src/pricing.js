// What observed transcript tokens would cost at pay-as-you-go API list prices, in USD. Subscription
// plans (Claude Pro/Max, ChatGPT) are not billed per token, so this is a yardstick, not a bill.
// Prices per million tokens, checked 2026-11-17 against the providers' own pages:
//   https://platform.claude.com/docs/en/about-claude/pricing
//   https://developers.openai.com/api/docs/pricing
// A model that is not listed there has no price here: its tokens are reported as unpriced, never guessed.
const PRICES_CHECKED = "2026-11-17";

// Claude: [input, 5-minute cache write, 1-hour cache write, cache read, output].
const CLAUDE = {};
const claude = (names, rates, extra = {}) => { for (const n of names) CLAUDE[n] = { rates, ...extra }; };
claude(["fable-5-2", "mythos-5-2"], [8, 10, 16, 0.20, 40], { fast: [16, 80], geo: true });
claude(["fable-5-1", "mythos-5-1"], [10, 12.5, 20, 0.25, 50], { geo: true });
claude(["fable-5", "mythos-5"], [10, 12.5, 20, 1, 50], { geo: true });
claude(["opus-5-5"], [4, 5, 8, 0.20, 20], { fast: [8, 40], geo: true });
claude(["opus-5"], [5, 6.25, 10, 0.50, 25], { fast: [10, 50], geo: true });
claude(["opus-4-8"], [5, 6.25, 10, 0.50, 25], { fast: [10, 50], geo: true });
claude(["opus-4-7", "opus-4-6"], [5, 6.25, 10, 0.50, 25], { geo: true });
claude(["opus-4-5"], [5, 6.25, 10, 0.50, 25]);
claude(["opus-4-1", "opus-4"], [15, 18.75, 30, 1.50, 75]);
claude(["sonnet-5-5"], [2, 2.5, 4, 0.10, 10], { geo: true });
claude(["sonnet-5"], [2, 2.5, 4, 0.20, 10], { geo: true });
claude(["sonnet-4-6"], [3, 3.75, 6, 0.30, 15], { geo: true });
claude(["sonnet-4-5", "sonnet-4"], [3, 3.75, 6, 0.30, 15]);
// A Haiku 5.5 request whose prompt (input, cache reads and writes) is over 100,000 tokens pays the higher row.
claude(["haiku-5-5"], [0.10, 0.125, 0.20, 0.01, 0.50], { long: { over: 100_000, rates: [0.50, 0.625, 1, 0.05, 2.50] }, geo: true });
claude(["haiku-4-5"], [1, 1.25, 2, 0.10, 5]);

// OpenAI: [input, cached input, cache write (shortest retention), output]; null write: written tokens
// are plain input. A request whose prompt is over 272,000 tokens pays the long row where one exists.
const OPENAI = {};
const openai = (name, rates, long = null) => { OPENAI[name] = { rates, long: long && { over: 272_000, rates: long } }; };
openai("gpt-6-astra", [10, 1, 12.5, 50], [20, 2, 25, 75]);
openai("gpt-6.1-sol", [2, 0.10, 2.5, 10], [4, 0.20, 5, 15]);
openai("gpt-6.1-terra", [1, 0.05, 1.25, 5], [2, 0.10, 2.5, 7.5]);
openai("gpt-6-luna", [0.10, 0.01, 0.125, 0.50], [0.20, 0.02, 0.25, 0.75]);
openai("gpt-6-sol", [2, 0.20, 2.5, 10], [4, 0.40, 5, 15]);
openai("gpt-5.6-sol", [4, 0.40, 5, 20], [8, 0.80, 10, 30]);
openai("gpt-5.6-terra", [2, 0.20, 2.5, 12], [4, 0.40, 5, 18]);
openai("gpt-5.6-luna", [0.20, 0.02, 0.25, 1.20], [0.40, 0.04, 0.50, 1.80]);
openai("gpt-5.5", [5, 0.50, null, 30], [10, 1, null, 45]);
openai("gpt-5.4", [2.5, 0.25, null, 15], [5, 0.50, null, 22.5]);
openai("gpt-5.4-mini", [0.75, 0.075, null, 4.5]);
openai("gpt-5.4-nano", [0.20, 0.02, null, 1.25]);
openai("gpt-5.3-codex", [1.75, 0.175, null, 14]);
openai("gpt-5.2", [1.75, 0.175, null, 14]);
openai("gpt-5.1", [1.25, 0.125, null, 10]);
openai("gpt-5", [1.25, 0.125, null, 10]);
openai("gpt-5-mini", [0.25, 0.025, null, 2]);
openai("gpt-5-nano", [0.05, 0.005, null, 0.40]);

// Transcript model names: Claude's lose "claude-" in tokens.js; a dated snapshot ("sonnet-4-5-20250929")
// is priced as its model.
function claudeKey(model) {
  return String(model || "").toLowerCase().replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// USD for one model response, or null when the model has no list price. item: the token fields of
// tokens.js (input uncached, cache_read, cache_write, cache_write_1h within it, output), plus speed and geo.
function costOf(provider, model, item) {
  const prompt = item.input + item.cache_read + item.cache_write;
  if (provider === "claude") {
    const p = CLAUDE[claudeKey(model)];
    if (!p) return null;
    let [input, write5m, write1h, read, output] = p.long && prompt > p.long.over ? p.long.rates : p.rates;
    // Fast mode has its own input and output prices; the cache multipliers apply on top.
    if (item.speed === "fast" && p.fast) {
      const scale = p.fast[0] / input;
      [input, write5m, write1h, read, output] = [p.fast[0], write5m * scale, write1h * scale, read * scale, p.fast[1]];
    }
    const hour = Math.min(item.cache_write, item.cache_write_1h || 0);
    const usd = (item.input * input + (item.cache_write - hour) * write5m + hour * write1h + item.cache_read * read + item.output * output) / 1e6;
    // US-only inference (inference_geo "us") costs 1.1x on Claude 4.6 and later.
    return item.geo === "us" && p.geo ? usd * 1.1 : usd;
  }
  if (provider === "codex") {
    const p = OPENAI[String(model || "").toLowerCase()];
    if (!p) return null;
    const [input, cached, write, output] = p.long && prompt > p.long.over ? p.long.rates : p.rates;
    return (item.input * input + item.cache_read * cached + item.cache_write * (write ?? input) + item.output * output) / 1e6;
  }
  return null;
}

module.exports = { costOf, claudeKey, PRICES_CHECKED };
