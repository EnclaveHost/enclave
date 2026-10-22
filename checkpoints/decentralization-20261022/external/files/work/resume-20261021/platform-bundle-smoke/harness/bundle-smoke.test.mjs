// ARTIFACT-LEVEL smoke of the GENERATED metal/guest/platform-api.bundle.mjs: the actual bundle file, laid out as
// metal/build-image.mjs lays it out (/opt/metal/platform-api.bundle.mjs + /opt/metal/fixtures/tpm-roots.pem), started
// exactly as the platform-api role starts its relay child (argv "--relay-child", stdio with an IPC channel, the
// role's barrier protocol answered "committed"). Everything external is a local mock: a ledger JSON-RPC (the ABI stub
// copied from test/api-relay.test.mjs) and two custody RPCs whose mode the test sets (ok-empty / hang / fail).
// No public network, no chain write, no real key: test keys only, a fresh AUTH_DATA_DIR per run.
//   BUNDLE_DIR=<dir holding platform-api.bundle.mjs [+ fixtures/]> node --test bundle-smoke.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

const BUNDLE_DIR = path.resolve(process.env.BUNDLE_DIR || "");
const BUNDLE = path.join(BUNDLE_DIR, "platform-api.bundle.mjs");
assert.ok(fs.existsSync(BUNDLE), `no bundle at ${BUNDLE}`);
const WORK = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "pa-bundle-smoke-"));
const SECRETS_KEY = "ab".repeat(32);                         // a test key, generated for this fixture only
const OWNER = privateKeyToAccount("0x" + "41".repeat(32));
const STRANGER = privateKeyToAccount("0x" + "43".repeat(32));
const LOCAL = "0x" + "d1".repeat(32), NONE = "0x" + "d2".repeat(32);
const VALUE = "bundle-smoke-secret-value-7f3a";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the ledger stub (copied from test/api-relay.test.mjs: schema rev-2 EnclaveDeployments count/getPage) ----------
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
    W(d.gpuMilli ?? 0), W(d.cpuMilli ?? 10), W(d.appPort ?? 8080), W(d.isPublic ? 1 : 0), W(d.active ? 1 : 0),
    W(d.createdAt ?? 1700000000), W(d.rate ?? 3), W(d.balance6 ?? 0), W(d.spent6 ?? 0),
    W(d.runner ?? "0x" + "0".repeat(64)), W(d.runnerOperator ?? "0x" + "0".repeat(40)), W(d.leaseUntil ?? 0),
  ].join("") + strs.map((s) => s.body).join("");
}
function encPage(rows) {
  const tuples = rows.map(tupleOf);
  let off = rows.length * 32;
  const heads = tuples.map((t) => { const h = W(off); off += t.length / 2; return h; });
  return "0x" + W(32) + W(rows.length) + heads.join("") + tuples.join("");
}
const LEDGER = [
  { id: LOCAL, owner: OWNER.address, appRef: "ipfs://smoke-local", active: true, balance6: 5_000_000 },
  { id: NONE, owner: OWNER.address, appRef: "ipfs://smoke-none", active: true, balance6: 5_000_000 },
];
function stubRpc(ledger = LEDGER) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body);
      const one = (m) => {
        if (m.method !== "eth_call") return "0x";
        const data = m.params[0].data;
        if (data.startsWith("0x5d1b72b6")) return "0x" + W(2);
        if (data.startsWith("0x06661abd")) return "0x" + W(ledger.length);
        const start = Number(BigInt("0x" + data.slice(10, 74)));
        const n = Number(BigInt("0x" + data.slice(74, 138)));
        return encPage(ledger.slice(start, start + n));
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(q) ? q.map((m) => ({ jsonrpc: "2.0", id: m.id, result: one(m) })) : { jsonrpc: "2.0", id: q.id, result: one(q) }));
    });
  });
}
// ---------- the custody RPCs: "hang" never answers (the 2026-10-21 quorum stall), "fail" answers HTTP 500 at once ----------
let custodyMode = "hang", custodyCalls = 0;
const custodyRpc = () => http.createServer((req, res) => {
  custodyCalls++;
  req.resume();
  if (custodyMode === "fail") { res.writeHead(500); res.end("upstream down"); }
  // hang: hold the socket open, never write
});
const listen = async (s) => { s.listen(0, "127.0.0.1"); await once(s, "listening"); return `http://127.0.0.1:${s.address().port}`; };
const ledgerSrv = stubRpc(), cust1 = custodyRpc(), cust2 = custodyRpc();
const LEDGER_URL = await listen(ledgerSrv), C1 = await listen(cust1), C2 = await listen(cust2);

// ---------- the bundle, started as the role starts its relay child ----------
const kids = [];
async function startBundle({ dataDir, custody }) {
  const env = { PATH: process.env.PATH, PLATFORM_API_ROLE: "relay-child", AUTH_DATA_DIR: dataDir, API_RELAY_BIND: "127.0.0.1", API_RELAY_PORT: "0",
    ENCLAVES: "http://127.0.0.1:1", BASE_RPC: LEDGER_URL, RPC_FALLBACKS: "0", DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20),
    FEATURED_VIEWS_FILE: path.join(dataDir, "featured-views.json"), SECRETS_KEY, RELAY_HVNODE_ATTACH: "1",
    ...(custody ? { CUSTODY_VAULT: "0x" + "77".repeat(20), CUSTODY_RPCS: `${C1},${C2}`, CUSTODY_MIN_AGREE: "2" } : {}) };
  const child = spawn(process.execPath, [BUNDLE, "--relay-child"], { env, cwd: dataDir, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  kids.push(child);
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  child.on("message", (m) => { if (m && m.t === "barrier") child.send({ t: "barrier", id: m.id, ok: true }); });
  const port = await new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error("no listening message in 60 s:\n" + log.slice(-1500))), 60_000);
    child.on("message", (m) => { if (m && m.t === "listening") { clearTimeout(t); ok(m.port); } });
    child.on("exit", (code) => { clearTimeout(t); no(Object.assign(new Error(`bundle exited ${code}:\n${log.slice(-1500)}`), { code, log })); });
  });
  return { base: `http://127.0.0.1:${port}`, child, log: () => log,
           stop: async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); } } };
}
const post = async (base, p, body, timeoutMs = 20_000) => {
  const t0 = Date.now();
  try {
    const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json, text, ms: Date.now() - t0 };
  } catch (e) { return { status: 0, error: e.name, ms: Date.now() - t0, text: "" }; }
};
const signed = async (acct, message) => acct.signMessage({ message });

test.after(async () => {
  for (const k of kids) if (k.exitCode === null) k.kill("SIGKILL");
  for (const s of [ledgerSrv, cust1, cust2]) { s.closeAllConnections?.(); s.close(); }
  fs.rmSync(WORK, { recursive: true, force: true });
});

const DATA = path.join(WORK, "data"); fs.mkdirSync(DATA);
let R;   // the running bundle of the current phase

test("packaging: the relay child reads the TPM roots SIDECAR beside the bundle (fixtures/tpm-roots.pem); without it, it refuses to start on exactly that path", async () => {
  const side = path.join(BUNDLE_DIR, "fixtures", "tpm-roots.pem");
  assert.ok(fs.existsSync(side), "the sidecar must be laid out beside the bundle (metal/build-image.mjs)");
  // a copy of the SAME bundle without its sidecar (the bundle's own directory is never altered)
  const bare = path.join(WORK, "bare"); fs.mkdirSync(bare);
  fs.copyFileSync(BUNDLE, path.join(bare, "platform-api.bundle.mjs"));
  const err = await startBundleAt(bare).then(() => null, (e) => e);
  assert.ok(err, "the bundle must not start without its sidecar while RELAY_HVNODE_ATTACH is on");
  assert.match(err.log || err.message, new RegExp(`ENOENT.*${path.join(bare, "fixtures", "tpm-roots.pem").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
});
async function startBundleAt(dir) {
  const d = fs.mkdtempSync(path.join(WORK, "bare-data-"));
  const env = { PATH: process.env.PATH, PLATFORM_API_ROLE: "relay-child", AUTH_DATA_DIR: d, API_RELAY_BIND: "127.0.0.1", API_RELAY_PORT: "0",
    ENCLAVES: "http://127.0.0.1:1", BASE_RPC: LEDGER_URL, RPC_FALLBACKS: "0", DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20), SECRETS_KEY, RELAY_HVNODE_ATTACH: "1" };
  const child = spawn(process.execPath, [path.join(dir, "platform-api.bundle.mjs"), "--relay-child"], { env, cwd: d, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  kids.push(child);
  let log = ""; child.stdout.on("data", (x) => (log += x)); child.stderr.on("data", (x) => (log += x));
  child.on("message", (m) => { if (m && m.t === "barrier") child.send({ t: "barrier", id: m.id, ok: true }); });
  return new Promise((ok, no) => {
    const t = setTimeout(() => { child.kill("SIGKILL"); no(Object.assign(new Error("timeout"), { log })); }, 30_000);
    child.on("message", (m) => { if (m && m.t === "listening") { clearTimeout(t); child.kill("SIGKILL"); ok(m.port); } });
    child.on("exit", (code) => { clearTimeout(t); no(Object.assign(new Error(`exited ${code}`), { code, log })); });
  });
}

test("phase A (custody off): the bundle starts as a relay child (sidecar in place) and /health answers 200", async () => {
  R = await startBundle({ dataDir: DATA, custody: false });
  const r = await fetch(R.base + "/health");
  assert.equal(r.status, 200);
});

test("CORS: the three ENS origins get an EXACT Allow-Origin and never Allow-Credentials; the apex keeps credentials; untrusted origins get none", async () => {
  const ask = async (o) => { const r = await fetch(R.base + "/health", { headers: { Origin: o } }); await r.arrayBuffer();
    return [r.headers.get("access-control-allow-origin"), r.headers.get("access-control-allow-credentials")]; };
  for (const o of ["https://enclavehost.eth", "https://enclavehost.eth.link", "https://enclavehost.eth.limo"]) assert.deepEqual(await ask(o), [o, null], o);
  for (const o of ["https://enclave.host", "https://www.enclave.host"]) assert.deepEqual(await ask(o), [o, "true"], o);
  for (const o of ["https://evil.example", "https://enclavehost.eth.evil.example", "http://enclavehost.eth", "null"]) assert.deepEqual(await ask(o), [null, null], o);
});

test("secrets: the owner stores a record through the bundle; strangers and unsigned or forged requests never get the value", async () => {
  const { createHash } = await import("node:crypto");
  const payload = JSON.stringify({ set: { API_TOKEN: VALUE } });
  // every signed message distinct: personal_sign is deterministic, so the same (id, expiry) twice IS a replay (409)
  let k = 0; const exp = () => Math.floor(Date.now() / 1000) + 300 + (k++);
  let e = exp();
  const put = await post(R.base, `/v1/secrets/${LOCAL}`, { payload, expiry: e,
    signature: await signed(OWNER, `enclave-secrets:put:${LOCAL}:${e}:${createHash("sha256").update(payload, "utf8").digest("hex")}`) });
  assert.equal(put.status, 200, put.text);
  // positive control: the owner reads it back (so the refusals below are the gate, not a broken fixture)
  e = exp();
  const own = await post(R.base, `/v1/secrets/${LOCAL}/get`, { expiry: e, signature: await signed(OWNER, `enclave-secrets:get:${LOCAL}:${e}`) });
  assert.equal(own.status, 200, own.text); assert.equal(own.body.env.API_TOKEN, VALUE);
  // a stranger's valid signature, no signature, a replayed owner signature, and a forged fleet fetch: all refused, no value
  e = exp();
  const stranger = await post(R.base, `/v1/secrets/${LOCAL}/get`, { expiry: e, signature: await signed(STRANGER, `enclave-secrets:get:${LOCAL}:${e}`) });
  assert.equal(stranger.status, 403, stranger.text); assert.equal(stranger.body.error, "not_owner");
  const unsigned = await post(R.base, `/v1/secrets/${LOCAL}/get`, { expiry: exp() });
  assert.equal(unsigned.status, 422, unsigned.text);
  e = exp(); const sig = await signed(OWNER, `enclave-secrets:get:${LOCAL}:${e}`);
  assert.equal((await post(R.base, `/v1/secrets/${LOCAL}/get`, { expiry: e, signature: sig })).status, 200);
  const replay = await post(R.base, `/v1/secrets/${LOCAL}/get`, { expiry: e, signature: sig });
  assert.equal(replay.status, 409, replay.text);
  const ts = Math.floor(Date.now() / 1000);
  const forged = await post(R.base, "/v1/secrets/fetch", { id: LOCAL, endpoint: "https://enclave1.example", ts, sig: "00".repeat(32) });
  assert.ok(forged.status >= 400 && forged.status < 500, forged.text);
  for (const r of [stranger, unsigned, replay, forged]) assert.ok(!r.text.includes(VALUE), "the value must never appear in a refused answer");
  await R.stop();
});

test("phase B (custody ON, both custody RPCs HANG): exists answers yes from the local record well inside a runner's 5 s; a deployment with no record is never answered a false no", async () => {
  custodyMode = "hang";
  R = await startBundle({ dataDir: DATA, custody: true });
  assert.match(R.log(), /\[custody\] vault 0x7777/);
  const local = await post(R.base, "/v1/secrets/exists", { id: LOCAL }, 5000);
  assert.equal(local.status, 200, `${local.status} ${local.error || local.text} after ${local.ms} ms`);
  assert.deepEqual(local.body, { id: LOCAL, exists: true });
  assert.ok(local.ms < 5000, `${local.ms} ms`);
  assert.ok(custodyCalls > 0, "the custody read was really attempted (and stalled)");
  const none = await post(R.base, "/v1/secrets/exists", { id: NONE }, 5000);
  assert.ok(!(none.status === 200 && none.body && none.body.exists === false), "never a false no while custody is unknown");
  assert.ok(none.status === 0 || none.status === 503, `${none.status} ${none.text}`);
});

test("phase B (custody RPCs FAIL fast): the local record still answers yes; no record answers 503 custody_unconfirmed; the plaintext fetch path does not open", async () => {
  custodyMode = "fail";
  const local = await post(R.base, "/v1/secrets/exists", { id: LOCAL }, 5000);
  assert.equal(local.status, 200, local.text); assert.deepEqual(local.body, { id: LOCAL, exists: true });
  const none = await post(R.base, "/v1/secrets/exists", { id: NONE }, 5000);
  assert.equal(none.status, 503, none.text); assert.equal(none.body.error, "custody_unconfirmed");
  const ts = Math.floor(Date.now() / 1000), endpoint = "https://enclave1.example";
  const hmac = createHmac("sha256", createHmac("sha256", Buffer.from(SECRETS_KEY, "hex")).update("fetch-auth v1").digest()).update(`${LOCAL}:${endpoint}:${ts}`).digest("hex");
  const fetched = await post(R.base, "/v1/secrets/fetch", { id: LOCAL, endpoint, ts, sig: hmac }, 20_000);
  assert.notEqual(fetched.status, 200, fetched.text);
  assert.ok(!fetched.text.includes(VALUE), "no plaintext while custody is unconfirmed / the endpoint is not the lease holder");
  await R.stop();
});
