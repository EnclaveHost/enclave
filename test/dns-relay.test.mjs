// relay/dns-relay.js — the authoritative server and its challenge-push API.
//
// Two things here are load-bearing for security. The push API is what makes
// DNS-01 issuance possible for app names, so its auth gate decides who can mint
// a certificate for a subdomain of the platform. And the server is an
// authoritative UDP/TCP DNS endpoint: every answer it will emit at some
// attacker's request is an amplification budget, which is why the challenge
// store is bounded on both axes (an authorized pusher can still mint one entry
// per distinct VALUE, and every value under a name lands in the same response).
//
// Driven as a real daemon on ephemeral ports — the module binds sockets at
// import, so there is no seam short of running it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "11".repeat(32);                       // the DERIVED DNS_TXT_KEY, 64 hex
const APP_ZONE = "app.test", IP_ZONE = "ip.test";

let proc, dnsPort, apiPort;

const freePort = () => new Promise((res) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

before(async () => {
  dnsPort = await freePort(); apiPort = await freePort();
  proc = spawn(process.execPath, [path.join(ROOT, "relay", "dns-relay.js")], {
    env: { ...process.env, IP_ZONE, APP_ZONE, NS_NAME: "ns1.test", ENCLAVES: "https://example.invalid",
           DNS_PORT: String(dnsPort), DNS_API_PORT: String(apiPort), DNS_API_BIND: "127.0.0.1",
           DNS_TXT_KEY: KEY, APP_A: "203.0.113.7" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.resume(); proc.stderr.resume();
  for (let i = 0; i < 100; i++) {                  // wait for the api to answer
    try { if ((await fetch(`http://127.0.0.1:${apiPort}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("dns-relay did not come up");
});
after(() => { try { proc.kill("SIGKILL"); } catch {} });

// ---- challenge-push API ------------------------------------------------------

async function push(body, { sig, method = "POST" } = {}) {
  const raw = JSON.stringify(body);
  const headers = { "content-type": "application/json" };
  const mac = sig === null ? null : (sig ?? createHmac("sha256", KEY).update(raw).digest("hex"));
  if (mac) headers["x-relay-sig"] = mac;
  const r = await fetch(`http://127.0.0.1:${apiPort}/v1/txt`, { method, headers, body: raw });
  return { status: r.status, body: await r.json() };
}
const chal = (label) => `_acme-challenge.${label}.${APP_ZONE}`;

test("push: the fleet HMAC is required, and it signs the exact body", async () => {
  assert.equal((await push({ name: chal("a"), value: "v" }, { sig: null })).status, 401);
  assert.equal((await push({ name: chal("a"), value: "v" }, { sig: "00".repeat(32) })).status, 401);
  // a signature over a DIFFERENT body does not carry
  const other = createHmac("sha256", KEY).update(JSON.stringify({ name: chal("z"), value: "v" })).digest("hex");
  assert.equal((await push({ name: chal("a"), value: "v" }, { sig: other })).status, 401);
  assert.equal((await push({ name: chal("a"), value: "v" })).status, 200);
});

test("push: names outside _acme-challenge under a served zone are refused", async () => {
  for (const name of ["www." + APP_ZONE,                       // not a challenge name
                      "_acme-challenge.elsewhere.example",     // not our zone
                      "_acme-challenge." + IP_ZONE,            // the ip zone has no TXT surface
                      "_acme-challenge." + APP_ZONE + ".evil.example"])
    assert.equal((await push({ name, value: "v" })).status, 400, name);
});

test("push: a stale or future timestamp is refused when one is signed in", async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await push({ name: chal("t"), value: "v", ts: now - 3600 })).status, 401);
  assert.equal((await push({ name: chal("t"), value: "v", ts: now + 3600 })).status, 401);
  assert.equal((await push({ name: chal("t"), value: "v", ts: now })).status, 200);
});

test("push: values per name are capped — authorization is not a quantity", async () => {
  const name = chal("cap");
  let last;
  for (let i = 0; i < 20; i++) last = await push({ name, value: `value-${i}` });
  assert.equal(last.status, 200);
  assert.equal(last.body.values, 8, "the per-name cap holds no matter how many are pushed");
  // and the newest survives: it is the one being validated
  const answers = await txtQuery(name);
  assert.ok(answers.includes("value-19"), "newest challenge kept");
  assert.equal(answers.length, 8);
});

test("push: ttlSec can only shorten the cap, never extend it", async () => {
  assert.equal((await push({ name: chal("ttl"), value: "v", ttlSec: 30 })).body.ttlSec, 30);
  assert.equal((await push({ name: chal("ttl2"), value: "v", ttlSec: 999999 })).body.ttlSec, 600);
});

test("push: DELETE removes just that value", async () => {
  const name = chal("del");
  await push({ name, value: "keep" });
  await push({ name, value: "drop" });
  assert.equal((await push({ name, value: "drop" }, { method: "DELETE" })).body.values, 1);
  assert.deepEqual(await txtQuery(name), ["keep"]);
});

// ---- the resolver ------------------------------------------------------------

// minimal query builder/parser: one question, no compression in what we send
function encodeName(n) {
  const parts = n.split(".").filter(Boolean).map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, "latin1")]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}
function query(name, type) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(0x4242, 0); h.writeUInt16BE(0x0100, 2); h.writeUInt16BE(1, 4);
  const q = Buffer.concat([encodeName(name), Buffer.from([0, type, 0, 1])]);
  return Buffer.concat([h, q]);
}
// ask over TCP (2-byte framing) so nothing is truncated
function ask(name, type) {
  return new Promise((resolve, reject) => {
    const msg = query(name, type);
    const s = net.connect(dnsPort, "127.0.0.1", () => {
      const len = Buffer.alloc(2); len.writeUInt16BE(msg.length); s.write(Buffer.concat([len, msg]));
    });
    let buf = Buffer.alloc(0);
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 2 || buf.length < 2 + buf.readUInt16BE(0)) return;
      s.destroy(); resolve(buf.subarray(2, 2 + buf.readUInt16BE(0)));
    });
    s.on("error", reject);
    s.setTimeout(4000, () => { s.destroy(); reject(new Error("dns timeout")); });
  });
}
// skip the question, walk the answer section, return { rcode, records: [{type, rdata}] }
function parse(msg) {
  const rcode = msg.readUInt16BE(2) & 0xf, an = msg.readUInt16BE(6);
  let o = 12;
  const skipName = () => { for (;;) { const l = msg[o]; if (l === 0) { o++; return; } if (l & 0xc0) { o += 2; return; } o += 1 + l; } };
  skipName(); o += 4;
  const records = [];
  for (let i = 0; i < an; i++) {
    skipName();
    const type = msg.readUInt16BE(o), rdlen = msg.readUInt16BE(o + 8);
    records.push({ type, rdata: msg.subarray(o + 10, o + 10 + rdlen) });
    o += 10 + rdlen;
  }
  return { rcode, records };
}
async function txtQuery(name) {
  const { records } = parse(await ask(name, 16));
  return records.filter((r) => r.type === 16).map((r) => {
    const out = []; let i = 0;
    while (i < r.rdata.length) { const n = r.rdata[i]; out.push(r.rdata.subarray(i + 1, i + 1 + n).toString("utf8")); i += 1 + n; }
    return out.join("");
  });
}

test("resolver: names outside the served zones are REFUSED, not resolved", async () => {
  assert.equal(parse(await ask("example.com", 1)).rcode, 5);
  assert.equal(parse(await ask("app.test.evil.example", 1)).rcode, 5);
  assert.equal(parse(await ask("anything." + APP_ZONE, 1)).rcode, 0);     // wildcard zone: exists
});

test("resolver: an unknown deployment prefix is NXDOMAIN, never a guess", async () => {
  assert.equal(parse(await ask("deadbeefdeadbeef." + IP_ZONE, 28)).rcode, 3);
  assert.equal(parse(await ask("zz." + IP_ZONE, 28)).rcode, 3);           // not hex
  assert.equal(parse(await ask("abc." + IP_ZONE, 28)).rcode, 3);          // shorter than 8
});
