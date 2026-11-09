const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const models = require("../src/models");
const config = require("../src/config");
const accounts = require("../src/accounts");
const { RESUME, ID_RE } = require("../src/session-log");
const { OTHER_CLIS } = require("../src/sessions");

const NEWER = ["windsurf", "kiro", "amp", "opencode", "qwen", "kimi"];
const ids = models.PROVIDERS.map((p) => p.id);

function ui() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve("../src/models"), "utf8"), context);
  vm.runInContext(fs.readFileSync(require.resolve("../src/ui/format"), "utf8"), context);
  return context;
}

test("every provider is wired into the poller, config, accounts, resume and the marks", () => {
  const poller = fs.readFileSync(require.resolve("../src/poller"), "utf8");
  const context = ui();
  const marks = vm.runInContext("MARKS", context);
  const titles = vm.runInContext("MARK_TITLES", context);
  for (const id of ids) {
    assert.match(poller, new RegExp(`require\\("./adapters/${id}"\\)`), `${id} adapter`);
    const adapter = require(`../src/adapters/${id}`);
    assert.equal(adapter.id, id);
    assert.equal(typeof adapter.fetchUsage, "function");
    assert.ok(config.CHIP_KEYS.includes(id), `${id} chip key`);
    assert.ok(config.ACCOUNT_IDS.includes(id), `${id} account id`);
    assert.ok(accounts.TOOLS[id], `${id} accounts tool`);
    assert.ok(marks[id], `${id} mark`);
    assert.ok(titles[id], `${id} mark title`);
  }
  for (const id of NEWER) {
    assert.ok(OTHER_CLIS.some((c) => c.tool === id), `${id} session pattern`);
    assert.equal(typeof require(`../src/records/${id}`).read, "function", `${id} records`);
  }
  for (const id of ["claude", "codex", "grok", "gemini", "cursor-agent", "copilot", "agy", "windsurf", "kiro", "amp", "opencode", "qwen", "kimi"]) {
    assert.ok(RESUME[id], `${id} resume`);
  }
});

test("the newer providers stay off the strip until installed", () => {
  for (const id of NEWER) assert.ok(models.OPTIONAL_PROVIDERS.has(id));
});

test("session ids of every tool pass the id check, unsafe text does not", () => {
  for (const id of ["brisk-otter", "T-019bfb1e-0a4f-70bb-9034-8f07cc01c4b5", "ses_01HZXABCDEFGHJKMNPQRSTVWXY", "sess_abc123",
    "session_abc123", "0d8c3b80-8574-71da-42b2-318b8494425f"]) {
    assert.ok(ID_RE.test(id), id);
  }
  for (const id of ["../x", "a b", 'a"b', "a&b", "", "-x"]) assert.ok(!ID_RE.test(id), id);
});
