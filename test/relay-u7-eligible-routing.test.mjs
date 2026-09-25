// U7: tenant traffic goes ONLY to a host the relay holds ELIGIBLE (computeEligible, the evidence rule placement already
// uses). Drives the REAL api-relay as a child process against a stub Base JSON-RPC ledger, three dialed stub boxes and a
// token-attached tunnel box. Every box answers for EVERY id it is asked about (the hostile-answer case), so a request
// that reaches one is visible in its log.
//   - an eligible lease holder is routed on every tenant path: /x/<id>, /v1/deployments/<id>, the app subdomain, the
//     on-demand TLS gate and a WebSocket upgrade;
//   - an INELIGIBLE lease holder is refused on every one of them, with the reason, and receives nothing;
//   - an on-chain id whose holder is not live, whose lease is not live, or whose ledger cannot be read is REFUSED, and no
//     box is probed for it (no fallback authorization);
//   - an owner learned from an ineligible box's own listing is never used as a route (cache bypass);
//   - a holder that LOSES eligibility stops receiving traffic at the next availability poll;
//   - an explicitly addressed tunnel box (/t/<name>/..., its e<hex>.<BOX_ZONE> hostname, HTTP and WebSocket) carries
//     tenant paths only when eligible; its own surfaces stay reachable.
//   run: node --test test/relay-u7-eligible-routing.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { bootDaemon, listenOnFreePort } from "./helpers/daemon.mjs";

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const { keccak256, stringToBytes } = await import("viem");
const { WebSocket } = await import("ws");

// ---------- the stub ledger: EnclaveDeployments count()/getPage(), schema rev 2 (as test/api-relay.test.mjs) ----------
const W = (v) => (typeof v === "string" ? v.replace(/^0x/, "").toLowerCase() : BigInt(v).toString(16)).padStart(64, "0");
function tupleOf(d) {
  const strs = [d.appRef, d.ports ?? "", d.configCid ?? ""].map((s) => {
    const hex = Buffer.from(s, "utf8").toString("hex");
    return { body: W(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0"), words: 1 + Math.ceil(hex.length / 64) };
  });
  let off = 17 * 32;
  const strHeads = strs.map((s) => { const h = W(off); off += s.words * 32; return h; });
  return [
    W(d.id), W(d.owner), strHeads[0], strHeads[1], strHeads[2],
    W(0), W(10), W(8080), W(1), W(1), W(1700000000), W(3), W(5_000_000), W(0),
    W(d.runner ?? "0x" + "0".repeat(64)), W("0x" + "0".repeat(40)), W(d.leaseUntil ?? 0),
  ].join("") + strs.map((s) => s.body).join("");
}
function encPage(rows) {
  const tuples = rows.map(tupleOf);
  let off = rows.length * 32;
  const heads = tuples.map((t) => { const h = W(off); off += t.length / 2; return h; });
  return "0x" + W(32) + W(rows.length) + heads.join("") + tuples.join("");
}
function stubRpc(ledger, { broken = false } = {}) {
  return http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body);
      const one = (m) => {
        if (broken || m.method !== "eth_call") return "0x";
        const data = m.params[0].data;
        if (data.startsWith("0x5d1b72b6")) return "0x" + W(2);
        if (data.startsWith("0x06661abd")) return "0x" + W(ledger.length);
        const start = Number(BigInt("0x" + data.slice(10, 74))), n = Number(BigInt("0x" + data.slice(74, 138)));
        return encPage(ledger.slice(start, start + n));
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(q) ? q.map((m) => ({ jsonrpc: "2.0", id: m.id, result: one(m) }))
                                              : { jsonrpc: "2.0", id: q.id, result: one(q) }));
    });
  });
}

// ---------- stub boxes: each answers for EVERY id, and logs what reached it ----------
function stubBox(label, { eligible, lists = [] }) {
  const box = { label, eligible, log: [] };
  box.server = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    if (u === "/availability") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5, nodeVcpus: 8, nodeRamGb: 32,
                                      ...(box.eligible ? { teeCpu: "amd-sev-snp" } : {}) }));
    }
    box.log.push(`${req.method} ${u}`);
    if (u === "/v1/deployments") {      // its own listing: claims `lists` (teaches the relay's owner cache)
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data: lists.map((id) => ({ id, status: "running" })), cursor: null }));
    }
    if (box.refuse && box.refuse(u)) { res.statusCode = 404; return res.end("{}"); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ servedBy: label }));
  });
  box.server.on("upgrade", (req, socket) => {
    box.log.push(`UPGRADE ${req.url}`);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.end();
  });
  return box;
}

async function startRelay(t, { enclaves, ledger, broken = false, env = {} }) {
  const rpc = stubRpc(ledger, { broken }); await listenOnFreePort(rpc);
  const { child, port } = await bootDaemon({
    start: (port) => spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], {
      env: { ...process.env, ENCLAVES: enclaves, API_RELAY_PORT: String(port), API_RELAY_BIND: "127.0.0.1",
             BASE_RPC: `http://127.0.0.1:${rpc.address().port}`, RPC_FALLBACKS: "0", DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20),
             ADDRESS_BOOK_ADDRESS: "", APP_DOMAIN: "app.enclave.host", AVAIL_POLL_SEC: "1",
             FEATURED_VIEWS_FILE: path.join(os.tmpdir(), `feat-views-u7-${port}.json`), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    claimed: (log, port) => log.includes(`[api-relay] :${port}`),
    ready: async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).ok,
  });
  t.after(() => { child.kill("SIGKILL"); rpc.close(); });
  return `http://127.0.0.1:${port}`;
}
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub) => `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
const getJ = async (origin, p, headers = {}) => {
  const r = await fetch(origin + p, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};
// a WebSocket upgrade through the relay: resolves the status line's code (101 when spliced to a box)
const upgrade = (origin, p, headers = {}) => new Promise((resolve, reject) => {
  const u = new URL(origin + p);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search,
    headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), ...headers } });
  req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
  req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
  req.on("error", (e) => (e.code === "ECONNRESET" ? resolve("reset") : reject(e)));
  req.end();
});
const waitFor = async (pred, ms = 8000) => { const until = Date.now() + ms; while (Date.now() < until) { if (await pred()) return true; await delay(100); } return false; };

const OWNER = "0x" + "aa".repeat(20);
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const D = (b) => "0x" + b.repeat(32);
const D_E = D("e1"), D_I = D("c2"), D_GONE = D("c3"), D_UNLEASED = D("c4"), D_FLIP = D("c5");
const idOf = (url) => keccak256(stringToBytes(url));

async function fleet(t) {
  const elig = stubBox("eligible", { eligible: true }), inel = stubBox("ineligible", { eligible: false, lists: [D_E, "dep_zzz"] });
  const flip = stubBox("flip", { eligible: true, lists: ["dep_zzz"] });   // hosts the non-ledger id while eligible
  elig.refuse = (u) => u.startsWith("/x/dep_zzz");            // the other eligible box does NOT host it
  for (const b of [elig, inel, flip]) { b.server.listen(0, "127.0.0.1"); await once(b.server, "listening"); t.after(() => b.server.close()); }
  const url = (b) => `http://127.0.0.1:${b.server.address().port}`;
  const ledger = [
    { id: D_E, owner: OWNER, appRef: "ipfs://e", runner: idOf(url(elig)), leaseUntil: FUTURE },
    { id: D_I, owner: OWNER, appRef: "ipfs://i", runner: idOf(url(inel)), leaseUntil: FUTURE },
    { id: D_GONE, owner: OWNER, appRef: "ipfs://g", runner: "0x" + "77".repeat(32), leaseUntil: FUTURE },   // holder not live
    { id: D_UNLEASED, owner: OWNER, appRef: "ipfs://u" },                                                    // nobody runs it
    { id: D_FLIP, owner: OWNER, appRef: "ipfs://f", runner: idOf(url(flip)), leaseUntil: FUTURE },
  ];
  return { elig, inel, flip, url, ledger };
}
const host = (id) => ({ "x-forwarded-host": `${id.slice(2, 10)}.app.enclave.host` });

test("U7: an ELIGIBLE lease holder is routed on every tenant path; an INELIGIBLE one is refused on every one and receives nothing", async (t) => {
  const f = await fleet(t);
  const origin = await startRelay(t, { enclaves: [f.elig, f.inel, f.flip].map(f.url).join(","), ledger: f.ledger });
  assert.ok(await waitFor(async () => (await getJ(origin, "/enclaves")).body?.enclaves?.length === 3), "three live rows");

  // the eligible holder: data plane, control plane, app subdomain, TLS gate, WebSocket
  let r = await getJ(origin, `/x/${D_E}/`);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.servedBy, "eligible");
  r = await getJ(origin, `/v1/deployments/${D_E}/attestation`, { authorization: "Bearer " + jwt(OWNER) });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.servedBy, "eligible");
  r = await getJ(origin, "/", host(D_E));
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.servedBy, "eligible");
  assert.equal((await fetch(origin + `/internal/tls-ask?domain=${D_E.slice(2, 10)}.app.enclave.host`)).status, 200);
  assert.equal(await upgrade(origin, "/", host(D_E)), 101, "a WebSocket to the eligible holder is spliced");

  // the INELIGIBLE holder: every path refuses, with the reason, and the box sees no tenant request at all
  const before = f.inel.log.length;
  r = await getJ(origin, `/x/${D_I}/`);
  assert.equal(r.status, 503); assert.equal(r.body.error, "host_ineligible");
  assert.match(r.body.message, /not eligible to serve tenant apps: its build never named its CPU technology/);
  r = await getJ(origin, `/v1/deployments/${D_I}/logs`, { authorization: "Bearer " + jwt(OWNER) });
  assert.equal(r.status, 503); assert.equal(r.body.error, "host_ineligible");
  r = await getJ(origin, "/", host(D_I));
  assert.equal(r.status, 503); assert.equal(r.body.error, "host_ineligible");
  assert.equal((await fetch(origin + `/internal/tls-ask?domain=${D_I.slice(2, 10)}.app.enclave.host`)).status, 404, "no certificate for its hostname");
  assert.equal(await upgrade(origin, "/", host(D_I)), 503, "no WebSocket either");
  assert.equal(await upgrade(origin, `/x/${D_I}/ws`), 503);
  // the bare record read (GET /v1/deployments/<id>) falls back to the public ledger row instead of forwarding
  r = await getJ(origin, `/v1/deployments/${D_I}`, { authorization: "Bearer " + jwt(OWNER) });
  assert.equal(r.status, 200); assert.equal(r.body.ledger, true, "the ledger row answers; the ineligible box is not asked");
  // the signed-in LIST fans the caller's session out to eligible hosts only (enclave-d1's review): the ineligible box
  // never receives a session it could replay through the relay
  assert.equal((await getJ(origin, "/v1/deployments", { authorization: "Bearer " + jwt(OWNER) })).status, 200);
  assert.ok(f.elig.log.includes("GET /v1/deployments"), "the eligible host was asked");
  // ...and a sign-in pinned to the ineligible box lands on an eligible one instead (sticky), never on it
  r = await getJ(origin, `/v1/auth/nonce?enclave=${encodeURIComponent(f.url(f.inel))}`);
  assert.notEqual(r.body?.servedBy, "ineligible", JSON.stringify(r.body));
  assert.deepEqual(f.inel.log.slice(before), [], "no tenant request, session or sign-in reached the ineligible holder");
});

test("U7: unknown, unleased, unreachable or unreadable answers REFUSE and never become a probe (fallback bypass)", async (t) => {
  const f = await fleet(t);
  const origin = await startRelay(t, { enclaves: [f.elig, f.inel, f.flip].map(f.url).join(","), ledger: f.ledger });
  assert.ok(await waitFor(async () => (await getJ(origin, "/enclaves")).body?.enclaves?.length === 3));
  const probes = () => [f.elig, f.inel, f.flip].flatMap((b) => b.log.filter((l) => l.startsWith("HEAD ")));
  let r = await getJ(origin, `/x/${D_GONE}/`);
  assert.equal(r.status, 503); assert.equal(r.body.error, "runner_unreachable", "the holder is not live: no other box may answer for it");
  r = await getJ(origin, `/x/${D_UNLEASED}/`);
  assert.equal(r.status, 404); assert.equal(r.body.error, "not_running");
  // an unknown id right after: the fresh ledger read is on its 5 s cooldown, so the answer is "not yet", never a probe
  const UNKNOWN = "0x" + "c9".repeat(32);
  r = await getJ(origin, `/x/${UNKNOWN}/`);
  assert.equal(r.status, 503); assert.equal(r.body.error, "not_yet_visible");
  await delay(5200);
  r = await getJ(origin, `/x/${UNKNOWN}/`);
  assert.equal(r.status, 404); assert.equal(r.body.error, "not_found", "after the cooldown, a fresh read says no");
  assert.equal((await fetch(origin + `/internal/tls-ask?domain=${D_GONE.slice(2, 10)}.app.enclave.host`)).status, 404);
  assert.deepEqual(probes(), [], "no box was probed for an on-chain id: every box here would have answered 'mine'");

  // a relay whose ledger cannot be read refuses on-chain ids outright, and probes nobody
  const b2 = stubBox("eligible-2", { eligible: true }); b2.server.listen(0, "127.0.0.1"); await once(b2.server, "listening"); t.after(() => b2.server.close());
  const blind = await startRelay(t, { enclaves: `http://127.0.0.1:${b2.server.address().port}`, ledger: [], broken: true });
  assert.ok(await waitFor(async () => (await getJ(blind, "/enclaves")).body?.enclaves?.length === 1));
  r = await getJ(blind, `/x/${D_E}/`);
  assert.equal(r.status, 503); assert.equal(r.body.error, "ledger_unavailable");
  assert.deepEqual(b2.log.filter((l) => l.startsWith("HEAD ")), [], "no probe when the ledger is unreadable");
  // a ledger configured only through the address book, not resolved yet: ledger-shaped ids wait, and are not probed
  const unresolved = await startRelay(t, { enclaves: `http://127.0.0.1:${b2.server.address().port}`, ledger: [], broken: true,
                                           env: { DEPLOYMENTS_ADDRESS: "", ADDRESS_BOOK_ADDRESS: "0x" + "34".repeat(20) } });
  assert.ok(await waitFor(async () => (await getJ(unresolved, "/enclaves")).body?.enclaves?.length === 1));
  r = await getJ(unresolved, `/x/${D_E}/`);
  assert.equal(r.status, 503); assert.equal(r.body.error, "ledger_unavailable");
  assert.deepEqual(b2.log.filter((l) => l.startsWith("HEAD ")), [], "no probe while the configured ledger is unresolved");
});

test("U7: a cached owner is used only while eligible (cache bypass); a non-ledger id probes eligible hosts only", async (t) => {
  const f = await fleet(t);
  const origin = await startRelay(t, { enclaves: [f.elig, f.inel, f.flip].map(f.url).join(","), ledger: f.ledger });
  assert.ok(await waitFor(async () => (await getJ(origin, "/enclaves")).body?.enclaves?.length === 3));
  // the signed-in list fans out to the ELIGIBLE hosts: the flip box lists dep_zzz, which teaches the owner cache
  assert.equal((await getJ(origin, "/v1/deployments", { authorization: "Bearer " + jwt(OWNER) })).status, 200);
  let r = await getJ(origin, "/x/dep_zzz/");
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.servedBy, "flip");
  // the ledger decides an on-chain id, whatever any listing said
  r = await getJ(origin, `/x/${D_E}/`);
  assert.equal(r.status, 200); assert.equal(r.body.servedBy, "eligible");
  // the cached owner loses eligibility: the cache no longer routes, and the probe asks eligible hosts only
  f.flip.eligible = false;
  assert.ok(await waitFor(async () => (await getJ(origin, "/enclaves")).body?.enclaves?.find((e) => e.endpoint === f.url(f.flip))?.eligible === false));
  const flipBefore = f.flip.log.length, inelBefore = f.inel.log.length;
  r = await getJ(origin, "/x/dep_zzz/");
  assert.equal(r.status, 404, JSON.stringify(r.body));
  assert.equal(f.flip.log.length, flipBefore, "the cached (now ineligible) owner received nothing");
  assert.deepEqual(f.inel.log.slice(inelBefore), [], "the ineligible box that claims every id was neither routed to nor probed");
  assert.ok(f.elig.log.includes("HEAD /x/dep_zzz"), "the eligible host was probed for the non-ledger id");
});

test("U7: a holder that LOSES eligibility stops receiving tenant traffic at the next availability poll", async (t) => {
  const f = await fleet(t);
  const origin = await startRelay(t, { enclaves: [f.elig, f.inel, f.flip].map(f.url).join(","), ledger: f.ledger });
  assert.ok(await waitFor(async () => (await getJ(origin, "/enclaves")).body?.enclaves?.length === 3));
  let r = await getJ(origin, `/x/${D_FLIP}/`);
  assert.equal(r.status, 200); assert.equal(r.body.servedBy, "flip");
  f.flip.eligible = false;                                    // its evidence is gone
  assert.ok(await waitFor(async () => (await getJ(origin, `/x/${D_FLIP}/`)).status === 503), "refused after the next poll");
  r = await getJ(origin, `/x/${D_FLIP}/`);
  assert.equal(r.body.error, "host_ineligible");
  const n = f.flip.log.length;
  assert.equal((await getJ(origin, "/", host(D_FLIP))).status, 503);
  assert.equal(await upgrade(origin, `/x/${D_FLIP}/ws`), 503);
  assert.equal(f.flip.log.length, n, "the cached owner from before did not carry traffic");
  f.flip.eligible = true;                                      // and it comes back when the evidence does
  assert.ok(await waitFor(async () => (await getJ(origin, `/x/${D_FLIP}/`)).status === 200));
});

test("U7: an explicitly addressed INELIGIBLE tunnel box is default-deny: only its own read-only surfaces pass (/t/<name> and its box hostname, HTTP and WebSocket)", async (t) => {
  const NAME = "e0123456789abcdef";
  const origin = await startRelay(t, { enclaves: "http://127.0.0.1:1", ledger: [],
    env: { METAL_TUNNEL_TOKENS: `${NAME}:tok-secret`, BOX_ZONE: "box.test" } });
  // a token-attached box: it proves nothing about its CPU, so it is not eligible; it answers every path 200
  const seen = [], headersSeen = [], streams = [];
  const ws = new WebSocket(origin.replace(/^http/, "ws") + "/v1/fleet-tunnel", { headers: { "x-metal-name": NAME, "x-metal-token": "tok-secret" } });
  t.after(() => ws.close());
  ws.on("message", (d) => {
    const f = JSON.parse(d);
    if (f.t === "s+") { streams.push(f); return; }                  // a raw stream (a spliced WebSocket upgrade)
    if (f.t !== "req") return;
    seen.push(`${f.method} ${f.path}`); headersSeen.push(f.headers || {});
    const body = f.path.startsWith("/availability") ? { cpuShareFree: 0.5, nodeVcpus: 8 } : { servedBy: "tunnel" };
    ws.send(JSON.stringify({ t: "res", id: f.id, status: 200,
                             headers: { "content-type": "application/json", "set-cookie": "planted=1; Path=/" },   // it tries to plant a cookie on the relay's origin
                             body: Buffer.from(JSON.stringify(body)).toString("base64") }));
  });
  await once(ws, "open");
  assert.ok(await waitFor(async () => ((await getJ(origin, "/enclaves")).body?.enclaves || []).some((e) => e.endpoint === `tunnel://${NAME}`)));
  const boxHost = { "x-forwarded-host": `${NAME}.box.test` };
  // its own read-only surfaces stay reachable, by path and by box hostname
  // ("/v1/./health" is resolved to "/v1/health" by the client and the relay's own URL parse BEFORE the gate, so the box
  //  receives exactly its own surface: that is the same request, not an encoding of another)
  for (const p of ["/availability", "/Availability", "/availability/", "/v1/health", "/v1/./health", "/v1/attestation", "/.well-known/tinfoil-attestation"])
    assert.equal((await getJ(origin, `/t/${NAME}${p}`)).status, 200, p);
  assert.equal((await getJ(origin, "/availability", boxHost)).status, 200);
  assert.equal((await getJ(origin, "/.well-known/tinfoil-attestation", boxHost)).status, 200);
  // everything else is refused: the tenant paths, enclave-5d's five, the encodings, the collection, and any other path
  const before = seen.length;
  const refused = async (p, h = {}, init = {}) => {
    const r = await fetch(origin + p, { headers: h, ...init });
    const b = await r.json().catch(() => null);
    assert.equal(r.status, 503, `${init.method || "GET"} ${p} ${JSON.stringify(h)}`); assert.equal(b?.error, "host_ineligible", p);
  };
  const tenant = `/x/${D_E}/`;
  for (const p of [tenant, `/v1/deployments/${D_E}/logs`, "/v1/deployments",                               // tenant paths
                   `/X/${D_E}/`, `/V1/Deployments/${D_E}/logs`,                                            // enclave-5d's case variants
                   `//x/${D_E}/`, `/%78/${D_E}/`, `/v1//deployments/${D_E}`, `/v1/%64eployments/${D_E}`, `/%2578/${D_E}/`,
                   "/v1/tls-bridge", "/hello", "/v1/secrets", "/%E0%A4%A",                                 // anything else
                   "/v1/attestation/verify", "/.well-known/other",                                          // exact entries, no prefixes
                   // enclave-5d's round-2 finding: a raw tenant path that CANONICALIZES to an own surface
                   `/x/${D_E}/..%2F..%2Favailability`, `/x/${D_E}/..%2f..%2f.well-known/tinfoil-attestation`,
                   `/x/${D_E}/..%252F..%252Favailability`, `/v1/deployments/${D_E}/..%2F..%2F..%2Fv1%2Fhealth`,
                   "//availability", "/%61vailability"])
    await refused(`/t/${NAME}${p}`);
  for (const p of [`/X/${D_E}/`, `/v1/Deployments/${D_E}`, tenant, "/v1/deployments",
                   `/x/${D_E}/..%2F..%2Favailability`]) await refused(p, boxHost);   // by box hostname
  await refused(`/t/${NAME}/v1/deployments`, {}, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await refused(`/t/${NAME}/v1/attestation`, {}, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(await upgrade(origin, `/t/${NAME}${tenant}ws`), 503);
  assert.equal(await upgrade(origin, `${tenant}ws`, boxHost), 503);
  assert.equal(await upgrade(origin, `/t/${NAME}/X/${D_E}/ws`), 503);
  assert.deepEqual(seen.slice(before), [], "nothing but its own surfaces reached the ineligible tunnel box");

  // CREDENTIALS (Codex's review): an ineligible box's own public surfaces get the request WITHOUT the caller's
  // credentials, and its Set-Cookie never reaches the client. Synthetic sentinels only.
  const SENT = "sentinel-" + randomBytes(8).toString("hex");
  const cred = { authorization: `Bearer ${SENT}`, cookie: `session=${SENT}`, "proxy-authorization": `Basic ${SENT}` };
  for (const [p, h] of [[`/t/${NAME}/availability`, cred], ["/availability", { ...cred, ...boxHost }],
                        [`/t/${NAME}/v1/attestation`, cred], ["/.well-known/tinfoil-attestation", { ...cred, ...boxHost }]]) {
    const n = headersSeen.length;
    const r = await fetch(origin + p, { headers: h });
    assert.equal(r.status, 200, p);
    const got = headersSeen.slice(n);
    assert.equal(got.length, 1, p);
    assert.ok(!JSON.stringify(got).includes(SENT), `${p}: the box received a credential: ${JSON.stringify(got)}`);
    assert.equal(r.headers.get("set-cookie"), null, `${p}: the box's Set-Cookie is not relayed`);
  }
  // no WebSocket upgrade reaches an ineligible box at all, own surfaces included (none of them is a WebSocket)
  const s0 = streams.length;
  assert.equal(await upgrade(origin, `/t/${NAME}/availability`, { authorization: `Bearer ${SENT}` }), 503);
  assert.equal(await upgrade(origin, "/availability", { ...boxHost, cookie: `session=${SENT}` }), 503);
  assert.equal(streams.length, s0, "no stream was opened toward the ineligible box");
});

test("U7: a customer's own hostname routes, and earns an edge certificate, only while its deployment's holder is eligible", async (t) => {
  const f = await fleet(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "u7-domains-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rec = (hostname, deploymentId) => ({ hostname, deploymentId, status: "active", owner: OWNER });
  fs.writeFileSync(path.join(dir, "domains.json"), JSON.stringify({ byHost: { "good.customer-shop.net": rec("good.customer-shop.net", D_E), "bad.customer-shop.net": rec("bad.customer-shop.net", D_I) } }));
  const origin = await startRelay(t, { enclaves: [f.elig, f.inel, f.flip].map(f.url).join(","), ledger: f.ledger, env: { AUTH_DATA_DIR: dir } });
  assert.ok(await waitFor(async () => (await getJ(origin, "/enclaves")).body?.enclaves?.length === 3));
  let r = await getJ(origin, "/", { "x-forwarded-host": "good.customer-shop.net" });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.servedBy, "eligible");
  assert.equal((await fetch(origin + "/internal/tls-ask?domain=good.customer-shop.net")).status, 200);
  const before = f.inel.log.length;
  r = await getJ(origin, "/", { "x-forwarded-host": "bad.customer-shop.net" });
  assert.equal(r.status, 503); assert.equal(r.body.error, "host_ineligible");
  assert.equal((await fetch(origin + "/internal/tls-ask?domain=bad.customer-shop.net")).status, 404, "no edge certificate for a name routed to an ineligible holder");
  assert.equal(await upgrade(origin, "/", { "x-forwarded-host": "bad.customer-shop.net" }), 404, "the WebSocket router does not route custom domains at all");
  assert.deepEqual(f.inel.log.slice(before), []);
});
