const https = require("https");
const http = require("http");
const { URL } = require("url");

const TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 6 });
const httpAgent = new http.Agent({ keepAlive: false, maxSockets: 6 });

function request(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      reject(new Error("Unsupported protocol"));
      return;
    }
    const lib = u.protocol === "http:" ? http : https;
    const agent = u.protocol === "http:" ? httpAgent : httpsAgent;
    const payload = body == null ? null : Buffer.from(body);
    let settled = false;
    let req;

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (err) reject(err);
      else resolve(val);
    };

    const killer = setTimeout(() => {
      try {
        if (req) req.destroy();
      } catch {
        /* ignore */
      }
      finish(new Error("timeout"));
    }, TIMEOUT_MS);

    try {
      req = lib.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          method,
          agent,
          headers: {
            ...headers,
            ...(payload ? { "Content-Length": payload.length } : {}),
          },
        },
        (res) => {
          const chunks = [];
          let bytes = 0;
          res.on("data", (c) => {
            bytes += c.length;
            if (bytes > MAX_RESPONSE_BYTES) {
              finish(new Error("Response too large"));
              res.destroy();
              req.destroy();
            } else chunks.push(c);
          });
          res.on("aborted", () => finish(new Error("Response aborted")));
          res.on("end", () => {
            finish(null, {
              status: res.statusCode,
              text: Buffer.concat(chunks).toString("utf8"),
              headers: res.headers,
            });
          });
          res.on("error", finish);
        }
      );
      req.on("error", finish);
      if (payload) req.write(payload);
      req.end();
    } catch (err) {
      finish(err);
    }
  });
}

async function getJson(url, headers) {
  const res = await request("GET", url, { headers });
  let json = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch {
    json = null;
  }
  return { ...res, json };
}

async function postJson(url, headers, obj) {
  const res = await request("POST", url, {
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(obj),
  });
  let json = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch {
    json = null;
  }
  return { ...res, json };
}

async function postForm(url, headers, fields) {
  const body = new URLSearchParams(fields).toString();
  const res = await request("POST", url, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
  });
  let json = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch {
    json = null;
  }
  return { ...res, json };
}

module.exports = { request, getJson, postJson, postForm, TIMEOUT_MS };
