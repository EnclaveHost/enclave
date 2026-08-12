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
import http from "node:http";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "11".repeat(32);                       // the DERIVED DNS_TXT_KEY, 64 hex
const APP_ZONE = "app.test", IP_ZONE = "ip.test";

let proc, dnsPort, apiPort;

// The API relay's /v1/relays, stubbed: which deployments chose a relay, and the
// address that relay answers on. "chosen4" took a v4-only relay, "chosen6" a
// v6-only one; every other label in the zone made no choice at all.
const RELAY_MAP = { labels: {
  chosen4: { relay: "us-west", a: "198.51.100.9" },
  chosen6: { relay: "v6only",  aaaa: "2001:db8:beef::9" },
} };
let mapServer, mapPort;

const freePort = () => new Promise((res) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

// freePort() reserves nothing: it binds :0, reads the number and CLOSES, so
// under a full parallel run another test's server can take that port before the
// daemon gets there. Then /health answers 200 from a stranger, the readiness
// check passes, and every assertion below runs against the wrong server - which
// is exactly how this file once reported an unsigned TXT push as ACCEPTED.
// So prove identity, not just liveness: /health echoes our zone names, which no
// other daemon in the suite will. If the port was stolen (or the daemon died on
// EADDRINUSE), start over on a fresh one.
async function boot() {
  dnsPort = await freePort(); apiPort = await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, "relay", "dns-relay.js")], {
    env: { ...process.env, IP_ZONE, APP_ZONE, NS_NAME: "ns1.test", ENCLAVES: "https://example.invalid",
           DNS_PORT: String(dnsPort), DNS_API_PORT: String(apiPort), DNS_API_BIND: "127.0.0.1",
           DNS_TXT_KEY: KEY, APP_A: "203.0.113.7", APP_AAAA: "2001:db8::7",
           RELAY_MAP_URL: `http://127.0.0.1:${mapPort}/v1/relays` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (p.exitCode != null) break;                 // died (port taken, config) - retry
    try {
      const r = await fetch(`http://127.0.0.1:${apiPort}/health`);
      const j = r.ok ? await r.json().catch(() => null) : null;
      // the relay map is fetched in the same poll the daemon runs at boot, but
      // the API is listening before that poll returns - wait for the labels or
      // the zone tests race the first fetch
      if (j && j.zones && j.zones.app === APP_ZONE && j.relayLabels === 2) return { p, log: () => log };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  try { p.kill("SIGKILL"); } catch {}
  return { p: null, log: () => log };
}

before(async () => {
  mapServer = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url.startsWith("/v1/relays") ? RELAY_MAP : {}));
  });
  mapServer.listen(0, "127.0.0.1"); await once(mapServer, "listening");
  mapPort = mapServer.address().port;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await boot();
    if (r.p) { proc = r.p; return; }
    if (attempt === 2) throw new Error(`dns-relay did not come up on its own port after 3 tries:\n${r.log()}`);
  }
});
after(() => { try { proc.kill("SIGKILL"); } catch {} try { mapServer.close(); } catch {} });

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

test("push: a malformed request target is refused, and the daemon survives it", async () => {
  // installProcessGuards turns a synchronous throw in a request listener into
  // exit(1), and this daemon is the authoritative DNS for the app zone — one
  // bad request must not darken every app hostname on the platform.
  const raw = (target) => new Promise((resolve, reject) => {
    const s = net.connect(apiPort, "127.0.0.1", () =>
      s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let out = ""; s.setTimeout(5000, () => { s.destroy(); reject(new Error("timeout")); });
    s.on("data", (d) => (out += d)); s.on("close", () => resolve(out)); s.on("error", reject);
  });
  assert.match(await raw("http://elsewhere.example/health"), /^HTTP\/1\.1 400 /);
  assert.match(await raw("*"), /^HTTP\/1\.1 400 /);
  // still serving, both planes
  assert.equal((await fetch(`http://127.0.0.1:${apiPort}/health`)).status, 200);
  assert.equal(parse(await ask("example.com", 1)).rcode, 5);
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

/* ---- zone 2: the wildcard is the DEFAULT answer, not the only one -----------
   A deployment may choose which relay carries its traffic ({"network":{"relay":
   "us-west"}} on-chain). Nothing inside a CVM acts on that: it is consumed
   HERE. The API relay resolves the choices to label -> address and this server
   answers the app's own name with it instead of the zone-wide one. */

test("resolver: a deployment that chose a relay gets that relay's address, not the wildcard", async () => {
  const { rcode, records } = parse(await ask("chosen4." + APP_ZONE, 1));
  assert.equal(rcode, 0);
  assert.equal(records.length, 1);
  assert.equal([...records[0].rdata].join("."), "198.51.100.9");
  // …and everything that did NOT choose still answers from the wildcard
  const other = parse(await ask("anything-else." + APP_ZONE, 1));
  assert.equal([...other.records[0].rdata].join("."), "203.0.113.7");
});

test("resolver: a chosen relay answers only from ITS OWN addresses, never the zone's other family", async () => {
  // The trap this exists to avoid: falling back per family would send every
  // v6-preferring client to the DEFAULT relay while v4 clients used the chosen
  // one — not a fallback, a silent half-undo of the owner's choice, and the
  // hardest kind of routing bug to see from outside.
  const v6 = parse(await ask("chosen4." + APP_ZONE, 28));
  assert.equal(v6.rcode, 0, "the name exists");
  assert.equal(v6.records.length, 0, "…but its relay declares no IPv6, so AAAA is empty - NOT the zone's 2001:db8::7");
  // the zone-wide AAAA is real, which is what makes the assertion above mean something
  const wild = parse(await ask("no-choice-here." + APP_ZONE, 28));
  assert.equal(wild.records.length, 1);
  assert.equal(wild.records[0].rdata.length, 16);

  // and the mirror image: a v6-only relay answers AAAA and leaves A empty
  const v6only = parse(await ask("chosen6." + APP_ZONE, 28));
  assert.equal(v6only.records.length, 1);
  assert.equal(v6only.records[0].rdata.readUInt16BE(0), 0x2001);
  assert.equal(parse(await ask("chosen6." + APP_ZONE, 1)).records.length, 0);
});

test("resolver: choosing a relay changes nothing else about the zone", async () => {
  // dns-01 issuance runs against the app's own name, so a deployment that moved
  // relays must still be able to mint its certificate. The challenge name is a
  // label deeper than the choice and is unaffected by it.
  assert.equal((await push({ name: chal("chosen4"), value: "tok" })).status, 200);
  assert.deepEqual(await txtQuery(chal("chosen4")), ["tok"]);
  // the apex is still the apex
  assert.equal(parse(await ask(APP_ZONE, 6)).records[0].type, 6);
  // and a deeper name under a chosen label is wildcard territory, as before
  const deep = parse(await ask("sub.chosen4." + APP_ZONE, 1));
  assert.equal([...deep.records[0].rdata].join("."), "203.0.113.7");
});
