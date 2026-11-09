// Stub: the usage reading is still to come; this only tells installed from not installed.
const paths = require("../paths");
const { emptyProvider } = require("../models");

const DISPLAY = "Qwen Code";

function installed() {
  return paths.cliOnPath("qwen") || [paths.qwenHome()].some((p) => paths.fileExists(p));
}

async function fetchUsage() {
  if (!installed()) return emptyProvider("qwen", DISPLAY, { state: "not_installed", hint: "Qwen Code not found" });
  return emptyProvider("qwen", DISPLAY, { state: "logged_out", hint: "Run: qwen, then /auth" });
}

function accountRef() {
  return null;
}

module.exports = { id: "qwen", displayName: DISPLAY, fetchUsage, accountRef };
