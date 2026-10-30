// api-relay.js with the pVM deployment carrier switch (PVM_SERVING; relay/pvm-serving.mjs; RELAY-SERVING.md), driven as the
// REAL relay process against a stub Base JSON-RPC ledger, the way test/api-relay.test.mjs drives it:
//   - OFF (the default): /x/<id>/pvm/* takes exactly the path any other /x path takes; nothing of the carrier runs.
//   - ON without the configuration it needs: those two routes answer a plain, empty 503 -- never the ordinary /x proxy.
//   - ON and configured: the ledger's runner only (an unknown deployment, or a runner with no live pVM tunnel: a plain 404),
//     the two paths RESERVED on the API host (an ordinary app's own /x/<id>/pvm/evidence is a 404, its subdomain is its
//     own), the method/prefix/size refusals, the relay's OWN client identity for the rate (clientIp: the last
//     X-Forwarded-For hop under TRUSTED_PROXY), both buckets, and a ledger that never answers: 504 and the pending cap.
// A synthetic phone cannot attach to this process (its AVF verifier pins Google's roots, correctly, with no override), so
// the splice itself is tested on the real tunnel hub through the same wiring function in test/pvm-relay-serving.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import net from "node:net";
import { bootDaemon, listenOnFreePort } from "./helpers/daemon.mjs";

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const W = (v) => (typeof v === "string" ? v.replace(/^0x/, "").toLowerCase() : BigInt(v).toString(16)).padStart(64, "0");
function tupleOf(d) {   // EnclaveDeployments schema rev 2 (as test/api-relay.test.mjs)
  const strs = [d.appRef, "", ""].map((s) => { const hex = Buffer.from(s, "utf8").toString("hex"); return { body: W(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0"), words: 1 + Math.ceil(hex.length / 64) }; });
  let off = 17 * 32; const heads = strs.map((s) => { const h = W(off); off += s.words * 32; return h; });
  return [W(d.id), W(d.owner), ...heads, W(0), W(10), W(8080), W(1), W(1), W(1700000000), W(3), W(5_000_000), W(0), W(d.runner ?? "0x" + "0".repeat(64)), W("0x" + "0".repeat(40)), W(d.leaseUntil ?? 0)].join("") + strs.map((s) => s.body).join("");
}
const encPage = (rows) => { const t = rows.map(tupleOf); let off = rows.length * 32; const heads = t.map((x) => { const h = W(off); off += x.length / 2; return h; }); return "0x" + W(32) + W(rows.length) + heads.join("") + t.join(""); };
const ID = (b) => "0x" + b.repeat(32);
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
let LEDGER = [{ id: ID("33"), owner: "0x" + "aa".repeat(20), appRef: "ipfs://pvm", runner: "0x" + "22".repeat(32), leaseUntil: FUTURE }];   // a live lease; its runner is nowhere live
function stubRpc({ hang = false } = {}) {
  return http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    if (hang) return;   // a ledger that never answers
    const q = JSON.parse(b || "{}"); const one = (m) => { const data = String(m.params?.[0]?.data || "");
      if (data.startsWith("0x06661abd")) return "0x" + W(LEDGER.length);
      if (m.method === "eth_call" && data.length >= 138) { const start = Number(BigInt("0x" + data.slice(10, 74))), n = Number(BigInt("0x" + data.slice(74, 138))); return encPage(LEDGER.slice(start, start + n)); }
      if (m.method === "eth_call") return "0x" + W(0);   // any other view (schema probes, address-book reads): a zero word
      if (m.method === "eth_chainId") return "0x2105"; if (m.method === "eth_blockNumber") return "0x1"; return "0x"; };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(q) ? q.map((m) => ({ jsonrpc: "2.0", id: m.id, result: one(m) })) : { jsonrpc: "2.0", id: q.id, result: one(q) })); }); });
}
async function relay(t, env = {}, rpcOpts = {}, { dir = RELAY_DIR, enclaves = "http://127.0.0.1:1" } = {}) {
  const rpc = stubRpc(rpcOpts); await listenOnFreePort(rpc);
  t.after(() => rpc.close());
  const { child, port, log } = await bootDaemon({ tries: 1,
    start: (p) => spawn(process.execPath, [path.join(dir, "api-relay.js")], { stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ENCLAVES: enclaves, API_RELAY_PORT: String(p), API_RELAY_BIND: "127.0.0.1", BASE_RPC: `http://127.0.0.1:${rpc.address().port}`,
             RPC_FALLBACKS: "0", DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20), FEATURED_VIEWS_FILE: path.join(os.tmpdir(), `feat-views-${p}.json`),
             PVM_SERVING: "", PVM_APP_IDS: "", PVM_APP_RUNTIME_IDS: "", METAL_AVF_CODE_HASHES: "", METAL_AVF_AUTHORITY_HASHES: "", PVM_CPU_CODE_HASHES: "", PVM_CPU_MODELS: "", ...env } }),
    claimed: (l, p) => l.includes(`[api-relay] :${p}`), ready: async (p) => (await fetch(`http://127.0.0.1:${p}/health`)).ok,
  });
  t.after(() => { child.kill("SIGKILL"); });
  return { port, log };
}
const req = (port, method, p, body = "", headers = {}) => new Promise((resolve) => {
  const q = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => resolve({ status: r.statusCode, body: b, type: r.headers["content-type"], headers: r.headers })); });
  q.on("error", () => resolve({ status: 0, body: "", headers: {} })); q.end(body);
});
const CONFIGURED = { PVM_SERVING: "1", METAL_AVF_CODE_HASHES: "aa".repeat(32), METAL_AVF_AUTHORITY_HASHES: "cd".repeat(64), PVM_CPU_CODE_HASHES: "bb".repeat(32),
  PVM_CPU_MODELS: JSON.stringify([{ sha256: "5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48", name: "m", selftestSha256: "dd".repeat(32), minDecodeTokS: 10 }]),
  PVM_APP_IDS: "ee".repeat(32), PVM_APP_RUNTIME_IDS: "d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba" };
// an ordinary (non-pVM) enclave that owns deployment 66 on the ledger (runner = keccak256(its endpoint), the registry's id
// rule) and answers every /x path with what it received -- so a test sees exactly what the relay forwarded
async function appEnclave(t) {
  const seen = [];
  const e = http.createServer((req, res) => { seen.push(req.url);
    if (req.url === "/availability") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5 })); }
    if (req.method === "HEAD") { res.statusCode = 200; return res.end(); }
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { const h = { ...req.headers }; for (const k of ["host", "content-length", "connection", "x-forwarded-for", "x-real-ip"]) delete h[k];
      res.setHeader("content-type", "application/json"); res.setHeader("x-app", "own"); res.end(JSON.stringify({ app: "OWN RESPONSE", headers: h, body: b })); }); });
  // a WebSocket handshake reaching the app is answered by the app itself, and noted
  e.on("upgrade", (req, sock) => { seen.push("UPGRADE " + req.url); sock.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nx-app: own\r\n\r\n"); });
  await new Promise((r) => e.listen(0, "127.0.0.1", r)); t.after(() => e.close());
  const endpoint = `http://127.0.0.1:${e.address().port}`, { keccak256, stringToBytes } = await import("viem");
  return { endpoint, seen, row: { id: ID("66"), owner: "0x" + "aa".repeat(20), appRef: "ipfs://ordinary", runner: keccak256(stringToBytes(endpoint)), leaseUntil: FUTURE } };
}
// a raw WebSocket handshake through the relay: the status and head of whatever answers it
const upgrade = (port, p) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1", () => s.write(`GET ${p} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));   // gitleaks:allow -- RFC 6455's sample key
  let b = ""; const done = () => { s.destroy(); resolve({ status: Number((/^HTTP\/1\.1 (\d{3})/.exec(b) || [])[1] || 0), head: b.split("\r\n\r\n")[0] }); };
  s.on("data", (d) => { b += d; if (b.includes("\r\n\r\n")) done(); }); s.on("close", done); s.on("error", done); s.setTimeout(5000, done);
});
const same = (a, b) => { const drop = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => !["date", "content-length", "etag", "keep-alive"].includes(k))); return JSON.stringify(drop(a)) === JSON.stringify(drop(b)); };

test("PVM_SERVING OFF (the default): /x/<id>/pvm/* is an ordinary /x path -- same status, body, response headers and forwarded headers -- and the carrier module is not even loaded", async (t) => {
  const app = await appEnclave(t); LEDGER = [LEDGER[0], app.row];
  const { port, log } = await relay(t, {}, {}, { enclaves: app.endpoint });
  const auth = { authorization: "Bearer should-be-stripped", "x-test": "1" };
  const pvm = await req(port, "POST", `/x/${ID("66")}/pvm/evidence`, "EVIDENCE x\n", auth), other = await req(port, "POST", `/x/${ID("66")}/pvm-lookalike`, "EVIDENCE x\n", auth);
  assert.equal(pvm.status, 200); assert.equal(JSON.parse(pvm.body).app, "OWN RESPONSE", "OFF: the app's own path is the app's");
  assert.deepEqual(JSON.parse(pvm.body).headers, JSON.parse(other.body).headers, "the relay forwarded the same headers on both paths");
  assert.ok(same(pvm.headers, other.headers), `the same response headers: ${JSON.stringify(pvm.headers)} vs ${JSON.stringify(other.headers)}`);
  for (const id of [ID("33"), ID("99")]) {
    const a = await req(port, "POST", `/x/${id}/pvm/evidence`, "x"), b = await req(port, "POST", `/x/${id}/some/app/path`, "x");
    assert.equal(a.status, b.status, id); assert.equal(a.body, b.body); assert.ok(same(a.headers, b.headers));
  }
  const up = await upgrade(port, `/x/${ID("66")}/pvm/evidence`);
  assert.equal(up.status, 101); assert.match(up.head, /x-app: own/); assert.ok(app.seen.includes(`UPGRADE /x/${ID("66")}/pvm/evidence`), "a WebSocket upgrade there is the app's");
  assert.doesNotMatch(log(), /\[pvm-serving\]/);
  for (const v of ["0", "false", "off", "no", "enabled", " "]) {
    const r = await relay(t, { PVM_SERVING: v }, {}, { enclaves: app.endpoint });
    assert.equal(JSON.parse((await req(r.port, "POST", `/x/${ID("66")}/pvm/evidence`, "x")).body).app, "OWN RESPONSE", `PVM_SERVING=${JSON.stringify(v)} is OFF`);
  }
  LEDGER = [LEDGER[0]];
});

test("OFF carries no new code: with a deliberately BROKEN pvm-serving.mjs beside it, an OFF relay boots and serves; an ON relay refuses to start", async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "relay-broken-"));
  for (const f of fs.readdirSync(RELAY_DIR)) if (f !== "api-relay.js" && f !== "pvm-serving.mjs") fs.symlinkSync(path.join(RELAY_DIR, f), path.join(d, f));
  fs.copyFileSync(path.join(RELAY_DIR, "api-relay.js"), path.join(d, "api-relay.js"));
  fs.writeFileSync(path.join(d, "pvm-serving.mjs"), 'throw new Error("a deliberately broken pvm-serving.mjs");\n');
  // every OFF value, not only unset: the relay's own switch test decides the import, and must agree with the module's
  for (const v of [undefined, "", "0", "false", "off", "no", "enabled", " "]) {
    const off = await relay(t, v === undefined ? {} : { PVM_SERVING: v }, {}, { dir: d });
    assert.equal((await req(off.port, "GET", "/health")).status, 200, `PVM_SERVING=${JSON.stringify(v)} boots without the module`);
    assert.notEqual((await req(off.port, "POST", `/x/${ID("33")}/pvm/evidence`, "x")).status, 0);
  }
  await assert.rejects(relay(t, CONFIGURED, {}, { dir: d }), /never claimed a port/, "ON loads the module at startup: a broken one stops the relay, it never serves half-built");
});

test("PVM_SERVING ON without its configuration: both pVM routes answer the same plain empty 503 (no Retry-After); every other route serves; the log names what is missing", async (t) => {
  const app = await appEnclave(t); LEDGER = [LEDGER[0], app.row];
  const bare = await relay(t, { PVM_SERVING: "1" }, {}, { enclaves: app.endpoint });
  for (const [m, p] of [["POST", `/x/${ID("33")}/pvm/evidence`], ["POST", `/x/${ID("33")}/pvm/sealed`], ["POST", `/x/${ID("66")}/pvm/sealed`], ["GET", `/x/${ID("99")}/pvm/evidence`]]) {
    const r = await req(bare.port, m, p, "x"); assert.equal(r.status, 503, `${m} ${p}`); assert.equal(r.body, ""); assert.equal(r.headers["retry-after"], undefined);
    assert.equal(r.headers.connection, "close", "refused before its body is read: the connection closes (a reused socket would be reset)");
  }
  assert.equal((await req(bare.port, "GET", "/health")).status, 200);
  assert.equal(JSON.parse((await req(bare.port, "POST", `/x/${ID("66")}/other`, "x")).body).app, "OWN RESPONSE", "the ordinary /x path serves");
  // every other route answers exactly as an OFF relay does (a stub ledger answers only some views: the property is equality)
  const off = await relay(t, {}, {}, { enclaves: app.endpoint });
  for (const p of ["/health", "/v1/deployments", `/v1/deployments/${ID("66")}`, `/v1/deployments/${ID("33")}`, "/v1/enclaves", "/nope"]) {
    const [x, y] = [await req(bare.port, "GET", p), await req(off.port, "GET", p)];
    assert.equal(x.status, y.status, p); const norm = (v) => v.replace(/"\d{4}-\d\d-\d\dT[^"]*Z"/g, "T").replace(/":\d{10,13}\b/g, '":N'); assert.equal(norm(x.body), norm(y.body), p);
  }
  assert.ok(!app.seen.some((u) => u.includes("/pvm/")), "no pVM route reached the app");
  assert.match(bare.log(), /\[pvm-serving\] ON but not configured.*Missing: AVF attach.*pVM CPU policy.*app admission policy/);
  const appOnly = await relay(t, { PVM_SERVING: "1", PVM_APP_IDS: CONFIGURED.PVM_APP_IDS, PVM_APP_RUNTIME_IDS: CONFIGURED.PVM_APP_RUNTIME_IDS });
  assert.equal((await req(appOnly.port, "POST", `/x/${ID("33")}/pvm/evidence`, "x")).status, 503);
  assert.match(appOnly.log(), /Missing: AVF attach \(METAL_AVF_\*\); the pVM CPU policy/); assert.doesNotMatch(appOnly.log(), /app admission policy/);
  // the app policy in the ABI/2 wire form exactly: a typo nulls it (503 and a named line), it is never repaired
  const a = "ee".repeat(32), b = "ab".repeat(32);
  for (const bad of [a.slice(1), "0x" + a, a.toUpperCase(), `${a},${a}`, `${a},`, `${a},,${b}`]) {
    const r = await relay(t, { ...CONFIGURED, PVM_APP_IDS: bad });
    assert.equal((await req(r.port, "POST", `/x/${ID("33")}/pvm/evidence`, "x")).status, 503, JSON.stringify(bad)); assert.match(r.log(), /Missing: the app admission policy/);
  }
  LEDGER = [LEDGER[0]];
});

test("PVM_SERVING ON and configured: the ledger runner only -- an ordinary app's own /pvm/evidence is RESERVED (404, never the app's answer) -- plain refusals, and the relay's own client identity", async (t) => {
  const app = await appEnclave(t); LEDGER = [LEDGER[0], app.row];
  const { port, log } = await relay(t, { ...CONFIGURED, PVM_APP_IDS: `${"ee".repeat(32)} , ${"ab".repeat(32)}`, APP_DOMAIN: "app.test", METAL_TUNNEL_TOKENS: "box1:lab-box-attach" }, {}, { enclaves: app.endpoint });
  assert.match(log(), /\[pvm-serving\] ON: the tunnel hub admits 2 app\(s\) x 1 runtime\(s\)/, "the HUB's policy (whitespace around commas is allowed)");
  const post = (id, what = "evidence", body = "EVIDENCE " + "ab".repeat(32) + "\n", h = {}) => req(port, "POST", `/x/${id}/pvm/${what}`, body, h);
  // the reservation: deployment 66 runs an ordinary app on a live https enclave; its runner is not a pVM tunnel
  const shadow = await post(ID("66"));
  assert.equal(shadow.status, 404); assert.equal(shadow.body, ""); assert.ok(!app.seen.some((u) => u.includes("/pvm/")), "the app never saw the request");
  const lookalike = await post(ID("66").slice(0, 10));
  assert.equal(lookalike.status, 404); assert.ok(!app.seen.some((u) => u.includes("/pvm/")), "a prefix of it neither: never the app's answer");
  assert.equal(JSON.parse((await req(port, "POST", `/x/${ID("66")}/other`, "x")).body).app, "OWN RESPONSE", "its other paths are untouched");
  // the app's OWN origin (its subdomain) is never the carrier: the same path there is the app's, whatever it names
  for (const p of ["/pvm/evidence", `/x/${ID("66")}/pvm/evidence`, `/x/${ID("33")}/pvm/sealed`]) {
    const own = await req(port, "POST", p, "x", { host: `${ID("66").slice(2, 10)}.app.test` });
    assert.equal(own.status, 200, p); assert.equal(JSON.parse(own.body).app, "OWN RESPONSE", `the subdomain's ${p} is the app's`);
  }
  assert.ok(app.seen.some((u) => u.endsWith(`/x/${ID("33")}/pvm/sealed`) && u.startsWith(`/x/${ID("66").slice(0, 10)}`)), `carried under the app's own /x path: ${JSON.stringify(app.seen)}`);
  app.seen.length = 0;
  for (const id of [ID("99"), ID("33")]) { const r = await post(id); assert.equal(r.status, 404, id); assert.equal(r.body, ""); }
  // WebSocket upgrades are NOT reserved: one on the same path takes the ordinary /x upgrade path to the app, as OFF
  const up = await upgrade(port, `/x/${ID("66")}/pvm/evidence`);
  assert.equal(up.status, 101); assert.match(up.head, /x-app: own/); assert.ok(app.seen.includes(`UPGRADE /x/${ID("66")}/pvm/evidence`), "the app answered the handshake itself");
  const g = await req(port, "GET", `/x/${ID("33")}/pvm/evidence`, "a body"); assert.equal(g.status, 405); assert.equal(g.headers.connection, "close");
  assert.equal((await req(port, "GET", "/health")).status, 200, "the next request after an early refusal is served");
  // the BOOTSTRAP route /t/<name>/pvm/evidence is claimed ONLY for a name attached as a pVM (AVF) tunnel: a token-attached box's
  // own path of that name is proxied to the box exactly as before, and a name with no tunnel gets the ordinary /t/ answer
  const { WebSocket } = await import("ws");
  const box = new WebSocket(`ws://127.0.0.1:${port}/v1/fleet-tunnel`, { headers: { "x-metal-name": "box1", "x-metal-token": "lab-box-attach" } });
  box.on("message", (d) => { const f = JSON.parse(d); if (f.t === "req") box.send(JSON.stringify({ t: "res", id: f.id, status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from(`BOX:${f.method} ${f.path}`).toString("base64") })); });
  await new Promise((r) => box.on("open", r)); t.after(() => box.close());
  let boxed = null; for (let i = 0; i < 40 && !(boxed && boxed.status === 200); i++) { boxed = await req(port, "POST", "/t/box1/pvm/evidence", "EVIDENCE " + "ab".repeat(32) + "\n"); if (boxed.status !== 200) await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(boxed.status, 200, JSON.stringify(boxed)); assert.equal(boxed.body, "BOX:POST /pvm/evidence", "a non-pVM tunnel's /t/<name>/pvm/evidence is its own, untouched");
  const none = await req(port, "POST", "/t/no-pvm-tunnel/pvm/evidence", "EVIDENCE " + "ab".repeat(32) + "\n");
  assert.equal(none.status, 404); assert.equal(JSON.parse(none.body).error, "no_tunnel", "no tunnel under that name: the ordinary /t/ answer, not the carrier's");
  assert.equal((await post("0x3333333333")).status, 404, "a prefix never resolves");
  assert.equal((await post(ID("33"), "evidence", "E".repeat(300))).status, 413);
  // identity = the relay's clientIp: the LAST X-Forwarded-For hop (TRUSTED_PROXY), the socket when there is none
  const as = (last, first = "203.0.113.9") => ({ "x-forwarded-for": `${first}, ${last}` });
  const drain = async (h, dep = ID("98")) => { let n = 0; while (n < 80 && (await post(dep, "evidence", undefined, h)).status !== 429) n++; return n; };
  const nA = await drain(as("198.51.100.7", "10.0.0.1"));
  assert.ok(nA >= 29 && nA <= 36, `one client: its own bucket of 30 (+ refill) -- ${nA}`);
  assert.equal((await post(ID("98"), "evidence", undefined, as("198.51.100.7", "192.0.2.200"))).status, 429, "another first entry, same last hop: the same client");
  assert.equal((await post(ID("98"), "evidence", undefined, as("198.51.100.8"))).status, 404, "another last hop is another client, with its own bucket");
  assert.equal((await post(ID("97"))).status, 404, "a direct hit with no X-Forwarded-For keys on the socket, and works");
  // the per-deployment bucket (60, a courtesy to the VM): two clients spend deployment 96's budget; a THIRD, fresh client
  // is then refused on the deployment -- one buyer's traffic can spend a deployment's budget against its other buyers
  await drain(as("198.51.100.20"), ID("96")); await drain(as("198.51.100.21"), ID("96"));
  let c = 0, st = 0; while (c < 6 && (st = (await post(ID("96"), "evidence", undefined, as("198.51.100.22"))).status) !== 429) c++;
  assert.equal(st, 429, `a fresh client is refused on the deployment's bucket after ${c} request(s)`); assert.ok(c < 6);
  const lines = log().split("\n").filter((l) => l.startsWith("[pvm-serving] {"));
  assert.ok(lines.length > 0 && lines.every((l) => !/EVIDENCE|abababababababab|"nonce"|"chain"/.test(l)), "carrier lines: sizes and ids only");
  LEDGER = [LEDGER[0]];
});

test("PVM_SERVING ON and configured, a ledger that never answers: a plain 504 at the bound; the fifth concurrent lookup of one client is 429 at once; the counter is released afterwards", async (t) => {
  const { port } = await relay(t, CONFIGURED, { hang: true });
  const t0 = Date.now(), hdr = { "x-forwarded-for": "198.51.100.50" };
  const four = [1, 2, 3, 4].map(() => req(port, "POST", `/x/${ID("33")}/pvm/evidence`, "EVIDENCE x\n", hdr));
  await new Promise((r) => setTimeout(r, 300));
  const fifth = await req(port, "POST", `/x/${ID("33")}/pvm/evidence`, "EVIDENCE x\n", hdr);
  assert.equal(fifth.status, 429, "four lookups pending for this client: the fifth is refused at once"); assert.ok(Date.now() - t0 < 2000);
  for (const r of await Promise.all(four)) { assert.equal(r.status, 504); assert.equal(r.body, ""); }
  assert.ok(Date.now() - t0 < 15000);
  const sixth = await req(port, "POST", `/x/${ID("33")}/pvm/evidence`, "EVIDENCE x\n", hdr);
  assert.equal(sixth.status, 504, "the counter was released on every timed-out lookup: the client is admitted again");
});
