// Stub: the usage reading is still to come; this only tells installed from not installed.
const paths = require("../paths");
const { emptyProvider } = require("../models");

const DISPLAY = "Kimi Code";

function installed() {
  return paths.cliOnPath("kimi") || [paths.kimiCodeHome()].some((p) => paths.fileExists(p));
}

async function fetchUsage() {
  if (!installed()) return emptyProvider("kimi", DISPLAY, { state: "not_installed", hint: "Kimi Code not found" });
  return emptyProvider("kimi", DISPLAY, { state: "logged_out", hint: "Run: kimi login" });
}

function accountRef() {
  return null;
}

module.exports = { id: "kimi", displayName: DISPLAY, fetchUsage, accountRef };
