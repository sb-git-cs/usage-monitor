// Stub: the usage reading is still to come; this only tells installed from not installed.
const paths = require("../paths");
const { emptyProvider } = require("../models");

const DISPLAY = "Amp";

function installed() {
  return paths.cliOnPath("amp") || [paths.ampHome(), paths.ampDataDir()].some((p) => paths.fileExists(p));
}

async function fetchUsage() {
  if (!installed()) return emptyProvider("amp", DISPLAY, { state: "not_installed", hint: "Amp not found" });
  return emptyProvider("amp", DISPLAY, { state: "logged_out", hint: "Run: amp login" });
}

function accountRef() {
  return null;
}

module.exports = { id: "amp", displayName: DISPLAY, fetchUsage, accountRef };
