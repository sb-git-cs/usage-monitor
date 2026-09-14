const https = require("https");
const http = require("http");
const { URL } = require("url");

const TIMEOUT_MS = 8000;

function request(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const payload = body == null ? null : Buffer.from(body);
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          ...headers,
          ...(payload ? { "Content-Length": payload.length } : {}),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, text, headers: res.headers });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
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
