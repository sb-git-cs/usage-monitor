const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../src/net/parsers");
const F = require("../src/net/format");

test("host:port parsing covers IPv4, bracketed and nettop-style IPv6, and mapped addresses", () => {
  assert.deepEqual(p.splitHostPort("192.168.1.14:43674"), { ip: "192.168.1.14", port: 43674 });
  assert.deepEqual(p.splitHostPort("[2001:db8::1]:443"), { ip: "2001:db8::1", port: 443 });
  assert.deepEqual(p.splitHostPort("[::ffff:93.184.216.34]:80"), { ip: "93.184.216.34", port: 80 });
  assert.deepEqual(p.splitHostPort("2607:f8b0:4005:80a::200e.443"), { ip: "2607:f8b0:4005:80a::200e", port: 443 });
  assert.deepEqual(p.splitHostPort("fe80::1%en0.5353"), { ip: "fe80::1", port: 5353 });
  assert.deepEqual(p.splitHostPort("[fe80::1]%eth0:22"), { ip: "fe80::1", port: 22 });
  assert.equal(p.splitHostPort("*:*"), null);
  assert.equal(p.splitHostPort("Address:Port"), null);
  assert.equal(p.isLoopback("127.0.0.53"), true);
  assert.equal(p.isLoopback("::1"), true);
  assert.equal(p.isLoopback("10.0.0.1"), false);
});

test("nettop CSV: skips the cumulative first block and attaches flows to their process", () => {
  const samples = [];
  const parser = p.createNettopParser((rows) => samples.push(rows));
  const lines = [
    ",bytes_in,bytes_out,",
    "kernel_task.0,999999,999999,",
    "Google Chrome H.487,5000000,100000,",
    ",bytes_in,bytes_out,",
    "kernel_task.0,3600,2347,",
    "Google Chrome H.487,1000,200,",
    "tcp4 192.168.1.2:52429<->142.250.72.100:443,900,150,",
    "tcp6 2001:db8::5.51000<->2607:f8b0:4005:80a::200e.443,100,50,",
    "udp4 *:5353<->*:*,0,0,",
    "tcp4 127.0.0.1:5000<->127.0.0.1:6000,10,10,",
    "syslogd.362,0,22701,",
  ];
  for (const l of lines) parser.line(l);
  assert.equal(samples.length, 0, "a block is only complete once the next one starts or output idles");
  parser.flush();
  assert.equal(samples.length, 1);
  const [kernel, chrome, syslog] = samples[0];
  assert.deepEqual({ name: kernel.name, pid: kernel.pid, rx: kernel.rx, tx: kernel.tx }, { name: "kernel_task", pid: 0, rx: 3600, tx: 2347 });
  assert.equal(chrome.name, "Google Chrome H");
  assert.equal(chrome.pid, 487);
  assert.deepEqual(chrome.flows, [
    { ip: "142.250.72.100", port: 443, proto: "tcp", rx: 900, tx: 150 },
    { ip: "2607:f8b0:4005:80a::200e", port: 443, proto: "tcp", rx: 100, tx: 50 },
  ]);
  assert.equal(syslog.tx, 22701);
});

test("nettop CSV with the default time column (no -J) is read by header position", () => {
  const samples = [];
  const parser = p.createNettopParser((rows) => samples.push(rows));
  const header = "time,,interface,state,bytes_in,bytes_out,rx_dupe,rx_ooo,re-tx,rtt_avg,rcvsize,tx_win,tc_class,tc_mgt,cc_algo,P,C,R,W,arch,";
  parser.line(header);
  parser.line("12:49:52.399032,firefox.5356,,,1,1,0,0,0,,,,,,,,,,,,");
  parser.line(header);
  parser.line("12:49:53.399032,firefox.5356,,,5427,1386,0,0,0,,,,,,,,,,,,");
  parser.line("12:49:53.392327,tcp4 192.168.254.212:52429<->34.117.65.55:443,en7,Established,5427,1386,0,0,0,39.81 ms,131072,69376,BE,-,cubic,-,-,-,-,so,");
  parser.line(header);
  assert.equal(samples.length, 1);
  assert.equal(samples[0][0].name, "firefox");
  assert.equal(samples[0][0].rx, 5427);
  assert.deepEqual(samples[0][0].flows[0], { ip: "34.117.65.55", port: 443, proto: "tcp", rx: 5427, tx: 1386 });
});

test("macOS helpers group app bundles and read ps output", () => {
  const chromeHelper =
    "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/131/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper";
  assert.deepEqual(p.macIdentity(chromeHelper, "Google Chrome H"), { key: "/Applications/Google Chrome.app", path: "/Applications/Google Chrome.app", name: "Google Chrome" });
  assert.deepEqual(p.macIdentity("/usr/sbin/mDNSResponder"), { key: "/usr/sbin/mDNSResponder", path: "/usr/sbin/mDNSResponder", name: "mDNSResponder" });
  assert.deepEqual(p.macIdentity("curl", "curl"), { key: "proc:curl", path: null, name: "curl" });
  assert.deepEqual(p.macIdentity(undefined, "kernel_task"), { key: "proc:kernel_task", path: null, name: "kernel_task" });
  const ps = p.parsePs("  487 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n    1 /sbin/launchd\n");
  assert.equal(ps.get(487), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(ps.get(1), "/sbin/launchd");
});

const SS = `State Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
ESTAB 0      0      192.168.1.14:43674 142.250.72.100:443 users:(("chrome",pid=3387,fd=66))
\t cubic wscale:7,7 rto:204 rtt:3.197/1.43 ato:40 mss:1448 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:10 bytes_sent:2317 bytes_acked:2318 bytes_received:2960 segs_out:12 segs_in:11 data_segs_out:5 data_segs_in:6 send 36.2Mbps lastsnd:2000 lastrcv:1990 lastack:1990 pacing_rate 72.4Mbps delivery_rate 11.6Mbps delivered:6 app_limited busy:30ms rcv_space:14480 rcv_ssthresh:64088 minrtt:1.5
ESTAB 0      0      [2001:db8::2]:50000 [2606:4700::6810:84e5]:443 users:(("firefox",pid=4100,fd=91),("firefox",pid=4100,fd=92))
\t cubic bytes_sent:500 bytes_acked:400 bytes_received:10000
ESTAB 0 0 127.0.0.1:5000 127.0.0.1:6000 users:(("node",pid=1,fd=3))
\t bytes_acked:10 bytes_received:10
ESTAB 0 0 10.0.0.2:40000 [::ffff:93.184.216.34]:80
\t bytes_sent:5 bytes_received:7
`;

test("ss -tinp output: multi-line records, IPv6, process info and counters", () => {
  const recs = p.parseSs(SS);
  assert.equal(recs.length, 4);
  assert.deepEqual(recs[0], {
    state: "ESTAB",
    local: { ip: "192.168.1.14", port: 43674 },
    peer: { ip: "142.250.72.100", port: 443 },
    pid: 3387,
    comm: "chrome",
    rx: 2960,
    tx: 2318,
  });
  assert.equal(recs[1].peer.ip, "2606:4700::6810:84e5");
  assert.equal(recs[1].pid, 4100);
  assert.equal(recs[1].tx, 400, "bytes_acked is preferred over bytes_sent");
  assert.equal(recs[3].pid, null, "sockets of other users have no process");
  assert.equal(recs[3].peer.ip, "93.184.216.34");
  assert.equal(recs[3].tx, 5, "bytes_sent is used when bytes_acked is missing");
  // ss -O puts everything on one line.
  const one = p.parseSs('ESTAB 0 0 10.0.0.2:1 1.1.1.1:443 users:(("curl",pid=9,fd=3)) cubic bytes_acked:50 bytes_received:70');
  assert.deepEqual([one[0].rx, one[0].tx, one[0].comm], [70, 50, "curl"]);
});

test("socket deltas: baseline, growth, new sockets, counter resets and loopback", () => {
  const recs = p.parseSs(SS);
  const first = p.diffSockets(new Map(), recs, true);
  assert.deepEqual(first.deltas, [], "the first poll only records starting points");
  assert.equal(first.next.size, 3, "loopback sockets are ignored");
  const grown = recs.map((r) => ({ ...r, rx: r.rx + 100, tx: r.tx + 10 }));
  const second = p.diffSockets(first.next, grown, false);
  assert.deepEqual(
    second.deltas.map((d) => [d.pid, d.rx, d.tx]),
    [
      [3387, 100, 10],
      [4100, 100, 10],
      [null, 100, 10],
    ]
  );
  const fresh = { state: "ESTAB", local: { ip: "10.0.0.2", port: 5 }, peer: { ip: "8.8.8.8", port: 443 }, pid: 7, comm: "x", rx: 500, tx: 40 };
  const reset = { ...grown[0], rx: 3, tx: 1 };
  const third = p.diffSockets(second.next, [reset, fresh], false);
  assert.deepEqual(
    third.deltas.map((d) => [d.pid, d.rx, d.tx]),
    [
      [3387, 3, 1],
      [7, 500, 40],
    ]
  );
});

test("desktop entries give names and the real program of an Exec line", () => {
  const entry = p.parseDesktopEntry(
    "[Desktop Entry]\nName=Firefox Web Browser\nName[de]=Firefox-Webbrowser\nExec=env MOZ_X=1 /usr/lib/firefox/firefox %u\nIcon=firefox\nType=Application\n[Desktop Action new]\nName=New Window\nExec=firefox --new-window\n"
  );
  assert.deepEqual(entry, { name: "Firefox Web Browser", exec: "env MOZ_X=1 /usr/lib/firefox/firefox %u", icon: "firefox", type: "Application" });
  assert.equal(p.execProgram(entry.exec), "/usr/lib/firefox/firefox");
  assert.equal(p.execProgram('"/opt/My App/app" --flag'), "/opt/My App/app");
  assert.equal(p.execProgram("%U"), null);
  assert.equal(p.parseDesktopEntry("[Other]\nName=x"), null);
});

test("byte formatting, size parsing and CSV cells", () => {
  assert.equal(F.formatBytes(0), "0 B");
  assert.equal(F.formatBytes(1023), "1023 B");
  assert.equal(F.formatBytes(1536), "1.50 KB");
  assert.equal(F.formatBytes(50 * 1024 ** 2), "50.0 MB");
  assert.equal(F.formatBytes(512 * 1024 ** 3), "512 GB");
  assert.equal(F.formatRate(2048), "2.00 KB/s");
  assert.deepEqual(
    [0, 0.2, 512, 999, 1000, 9000, 150 * 1024, 1023 * 1024, 1.5 * 1024 ** 2, 2 * 1024 ** 3].map(F.formatRateShort),
    ["0 B/s", "0 B/s", "512 B/s", "999 B/s", "1.0 KB/s", "8.8 KB/s", "150 KB/s", "1.0 MB/s", "1.5 MB/s", "2.0 GB/s"]
  );
  assert.equal(F.formatBytes(-5), "0 B");
  assert.equal(F.parseSize("1.5 GB"), 1.5 * 1024 ** 3);
  assert.equal(F.parseSize("500mb"), 500 * 1024 ** 2);
  assert.equal(F.parseSize("12"), 12);
  assert.equal(F.parseSize("lots"), null);
  assert.equal(F.parseSize("0"), null);
  assert.equal(F.csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(F.csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(F.csvCell(-5), "-5");
  assert.equal(F.rangeMinutes("all"), 0);
  assert.equal(F.rangeMinutes("bogus"), 60);
});
