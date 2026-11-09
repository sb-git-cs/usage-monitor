// Stub: the usage reading is still to come; this only tells installed from not installed.
const paths = require("../paths");
const { emptyProvider } = require("../models");

const DISPLAY = "Kiro";

function installed() {
  return paths.cliOnPath("kiro-cli") || [paths.kiroHome(), ...paths.kiroDataDirs()].some((p) => paths.fileExists(p));
}

async function fetchUsage() {
  if (!installed()) return emptyProvider("kiro", DISPLAY, { state: "not_installed", hint: "Kiro not found" });
  return emptyProvider("kiro", DISPLAY, { state: "logged_out", hint: "Run: kiro-cli login" });
}

function accountRef() {
  return null;
}

module.exports = { id: "kiro", displayName: DISPLAY, fetchUsage, accountRef };
