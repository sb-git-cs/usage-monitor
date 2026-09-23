const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

// Load each module with isolated state and explicit dependencies. Never read real logins.
function load(file, mocks = {}, internals = []) {
  const filename = path.resolve(__dirname, "..", file);
  const realRequire = createRequire(filename);
  const mod = { exports: {} };
  const source = fs.readFileSync(filename, "utf8") +
    (internals.length ? `\nObject.assign(module.exports, { ${internals.join(", ")} });` : "");
  new Function("require", "module", "exports", "__dirname", "__filename", source)(
    (id) => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id),
    mod, mod.exports, path.dirname(filename), filename
  );
  return mod.exports;
}

module.exports = { load };
