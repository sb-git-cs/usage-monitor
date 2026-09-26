// Pure parsers for the command-line tools the macOS and Linux providers read.
const net = require("net");
const path = require("path");

function normalizeIp(raw) {
  let ip = String(raw || "").trim().replace(/^\[|\]$/g, "");
  const zone = ip.indexOf("%");
  if (zone > 0) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  return net.isIP(ip) ? ip : null;
}

function isLoopback(ip) {
  return !ip || ip === "::1" || /^127\./.test(ip) || ip === "0.0.0.0" || ip === "::";
}

function port(text) {
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0;
}

// "1.2.3.4:443", "[2001:db8::1]:443", "[::ffff:1.2.3.4]:443", "fe80::1%en0.5353" (nettop), "2001:db8::1.443".
function splitHostPort(text) {
  const s = String(text || "").trim();
  if (!s || s.startsWith("*")) return null;
  let m = /^\[([^\]]+)\](?:%[^:\s]+)?:(\d+|\*)$/.exec(s);
  if (m) {
    const ip = normalizeIp(m[1]);
    return ip ? { ip, port: port(m[2]) } : null;
  }
  m = /^(\d{1,3}(?:\.\d{1,3}){3})(?:%[^:.\s]+)?[:.](\d+|\*)$/.exec(s);
  if (m) return net.isIP(m[1]) ? { ip: m[1], port: port(m[2]) } : null;
  // Unbracketed IPv6: nettop separates the port with '.', old ss versions with ':'.
  for (const sep of [".", ":"]) {
    const i = s.lastIndexOf(sep);
    if (i <= 0) continue;
    const ip = normalizeIp(s.slice(0, i));
    if (ip && ip.includes(":")) return { ip, port: port(s.slice(i + 1)) };
  }
  return null;
}

// ---- macOS nettop -L 0 -d (CSV, one block per interval) -------------------------

// Calls onSample(rows) once per complete interval. The first block holds totals since
// each socket opened rather than deltas, so it is skipped.
function createNettopParser(onSample) {
  let header = null;
  let blocks = 0;
  let rows = [];
  let current = null;

  function finish() {
    if (header && blocks > 1 && rows.length) onSample(rows);
    rows = [];
    current = null;
  }

  function line(text) {
    const trimmed = String(text || "").replace(/\r$/, "");
    if (!trimmed) return;
    const cells = trimmed.split(",");
    if (cells.includes("bytes_in") && cells.includes("bytes_out")) {
      finish();
      header = { name: cells.indexOf(""), rx: cells.indexOf("bytes_in"), tx: cells.indexOf("bytes_out") };
      blocks++;
      return;
    }
    if (!header || header.name < 0) return;
    const name = cells[header.name] || "";
    const rx = Number(cells[header.rx]);
    const tx = Number(cells[header.tx]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) return;
    const flow = /^(tcp|udp)[46]\s+(.+?)<->(.+)$/.exec(name);
    if (flow) {
      if (!current) return;
      const remote = splitHostPort(flow[3]);
      if (remote && !isLoopback(remote.ip)) current.flows.push({ ip: remote.ip, port: remote.port, proto: flow[1], rx, tx });
      return;
    }
    const proc = /^(.*)\.(\d+)$/.exec(name);
    if (!proc) {
      current = null;
      return;
    }
    current = { name: proc[1], pid: Number(proc[2]), rx, tx, flows: [] };
    rows.push(current);
  }

  return { line, flush: finish };
}

// ps -o pid=,comm= output -> Map(pid -> executable path or name)
function parsePs(text) {
  const out = new Map();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(raw);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

// Groups helpers inside an app bundle (e.g. every Chrome helper) under the outer .app.
function macIdentity(exec, name) {
  if (exec && exec.startsWith("/")) {
    const i = exec.indexOf(".app/");
    if (i > 0 || exec.endsWith(".app")) {
      const bundle = i > 0 ? exec.slice(0, i + 4) : exec;
      return { key: bundle, path: bundle, name: path.posix.basename(bundle, ".app") };
    }
    return { key: exec, path: exec, name: path.posix.basename(exec) };
  }
  const label = String(exec || name || "unknown").replace(/^-/, "");
  return { key: `proc:${label.toLowerCase()}`, path: null, name: label };
}

// ---- Linux ss -tinpH ------------------------------------------------------------

function parseSs(text) {
  const records = [];
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^\s/.test(raw)) {
      if (cur) cur.info += ` ${raw.trim()}`;
      continue;
    }
    cur = { head: raw.trim(), info: "" };
    records.push(cur);
  }
  return records.map(parseSsRecord).filter(Boolean);
}

function parseSsRecord({ head, info }) {
  const all = `${head} ${info}`;
  let tokens = head.split(/\s+/);
  if (/^(tcp|tcp6|mptcp)$/i.test(tokens[0])) tokens = tokens.slice(1);
  if (tokens.length < 5) return null;
  const local = splitHostPort(tokens[3]);
  const peer = splitHostPort(tokens[4]);
  if (!local || !peer) return null;
  const users = /users:\(\("((?:[^"\\]|\\.)*)",pid=(\d+)/.exec(all);
  const num = (name) => {
    const m = new RegExp(`(?:^|\\s)${name}:(\\d+)`).exec(all);
    return m ? Number(m[1]) : null;
  };
  const acked = num("bytes_acked");
  return {
    state: tokens[0],
    local,
    peer,
    pid: users ? Number(users[2]) : null,
    comm: users ? users[1] : null,
    rx: num("bytes_received") || 0,
    tx: acked != null ? acked : num("bytes_sent") || 0,
  };
}

// Turns cumulative per-socket counters into per-interval deltas. On the first poll
// (baseline) existing sockets only set their starting point.
function diffSockets(prev, records, baseline) {
  const next = new Map();
  const deltas = [];
  for (const r of records) {
    if (isLoopback(r.peer.ip) || r.peer.ip === r.local.ip) continue;
    const key = `${r.local.ip}|${r.local.port}|${r.peer.ip}|${r.peer.port}`;
    const before = prev.get(key);
    next.set(key, { rx: r.rx, tx: r.tx });
    let rx;
    let tx;
    if (before && r.rx >= before.rx && r.tx >= before.tx) {
      rx = r.rx - before.rx;
      tx = r.tx - before.tx;
    } else if (baseline) {
      continue;
    } else {
      rx = r.rx;
      tx = r.tx;
    }
    if (rx || tx) deltas.push({ pid: r.pid, comm: r.comm, ip: r.peer.ip, port: r.peer.port, rx, tx });
  }
  return { next, deltas };
}

// ---- Linux .desktop entries (names and icons) -----------------------------------

function parseDesktopEntry(text) {
  const entry = {};
  let inMain = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inMain = line === "[Desktop Entry]";
      continue;
    }
    if (!inMain) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k === "Name" && entry.name == null) entry.name = v;
    else if (k === "Exec") entry.exec = v;
    else if (k === "TryExec") entry.tryExec = v;
    else if (k === "Icon") entry.icon = v;
    else if (k === "StartupWMClass") entry.wmClass = v;
    else if (k === "Type") entry.type = v;
  }
  return entry.name ? entry : null;
}

// First real program in an Exec line, skipping env assignments and field codes.
function execProgram(exec) {
  const tokens = String(exec || "").match(/"[^"]*"|\S+/g) || [];
  let i = 0;
  if (tokens[i] === "env") i++;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const prog = (tokens[i] || "").replace(/^"|"$/g, "");
  return prog && !prog.startsWith("%") ? prog : null;
}

module.exports = {
  normalizeIp,
  isLoopback,
  splitHostPort,
  createNettopParser,
  parsePs,
  macIdentity,
  parseSs,
  diffSockets,
  parseDesktopEntry,
  execProgram,
};
