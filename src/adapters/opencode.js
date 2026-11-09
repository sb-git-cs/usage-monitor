// Stub: the usage reading is still to come; this only tells installed from not installed.
const paths = require("../paths");
const { emptyProvider } = require("../models");

const DISPLAY = "OpenCode";

function installed() {
  return paths.cliOnPath("opencode") || [paths.opencodeDataDir()].some((p) => paths.fileExists(p));
}

async function fetchUsage() {
  if (!installed()) return emptyProvider("opencode", DISPLAY, { state: "not_installed", hint: "OpenCode not found" });
  return emptyProvider("opencode", DISPLAY, { state: "logged_out", hint: "Run: opencode auth login" });
}

function accountRef() {
  return null;
}

module.exports = { id: "opencode", displayName: DISPLAY, fetchUsage, accountRef };
