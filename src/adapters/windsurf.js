// Stub: the usage reading is still to come; this only tells installed from not installed.
const paths = require("../paths");
const { emptyProvider } = require("../models");

const DISPLAY = "Windsurf";

function installed() {
  return paths.cliOnPath("devin") || [paths.devinDataDir(), paths.devinConfigDir(), ...paths.devinStateDbs()].some((p) => paths.fileExists(p));
}

async function fetchUsage() {
  if (!installed()) return emptyProvider("windsurf", DISPLAY, { state: "not_installed", hint: "Windsurf not found" });
  return emptyProvider("windsurf", DISPLAY, { state: "logged_out", hint: "Run: devin auth login" });
}

function accountRef() {
  return null;
}

module.exports = { id: "windsurf", displayName: DISPLAY, fetchUsage, accountRef };
