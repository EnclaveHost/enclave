// Wallet sessions on the routes the relay FORWARDS to a host. The site signs host-routed owner calls with the
// browser's wallet session (`Authorization: EnclaveSession v1 ...`, bound to method + host+path+query + body hash +
// time, single-use nonce); the HOST verifies it against the chain. So the relay must hand that header and the
// exact path through untouched, at most once per host, and where the relay answers itself (the list's ledger
// merge) it verifies the session for the owner it names.
// Drives the REAL api-relay as a child process against a stub Base JSON-RPC ledger and a dialed stub host that
// records every request (method, path+query, Host, Authorization). Part 2 runs the relay with sessions ON against
// anvil + the real SessionVault (skips without Foundry or a built SDK).
//   run: node --test test/relay-session-forward.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { bootDaemon, listenOnFreePort } from "./helpers/daemon.mjs";
import { haveFoundry, startChain, deployPlatform, KEYS } from "./helpers/sessions-chain.mjs";

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const SDK = new URL("../sdk/sessions/dist/node.mjs", import.meta.url);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const { keccak256, stringToBytes } = await import("viem");

// ---------- the stub ledger: EnclaveDeployments count()/getPage(), schema rev 2 (as test/api-relay.test.mjs) ----------
const W = (v) => (typeof v === "string" ? v.replace(/^0x/, "").toLowerCase() : BigInt(v).toString(16)).padStart(64, "0");
function tupleOf(d) {
  const strs = [d.appRef, "", ""].map((s) => {
    const hex = Buffer.from(s, "utf8").toString("hex");
    return { body: W(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0"), words: 1 + Math.ceil(hex.length / 64) };
  });
  let off = 17 * 32;
  const heads = strs.map((s) => { const h = W(off); off += s.words * 32; return h; });
  return [
    W(d.id), W(d.owner), heads[0], heads[1], heads[2],
    W(0), W(10), W(8080), W(0), W(1), W(1700000000), W(3), W(5_000_000), W(0),
    W(d.runner ?? "0x" + "0".repeat(64)), W("0x" + "0".repeat(40)), W(d.leaseUntil ?? 0),
  ].join("") + strs.map((s) => s.body).join("");
}
function encPage(rows) {
  const tuples = rows.map(tupleOf);
  let off = rows.length * 32;
  const heads = tuples.map((t) => { const h = W(off); off += t.length / 2; return h; });
  return "0x" + W(32) + W(rows.length) + heads.join("") + tuples.join("");
}
function stubRpc(ledger) {
  return http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body);
      const one = (m) => {
        if (m.method !== "eth_call") return "0x";
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

// ---------- the host: eligible (its RAD names SEV-SNP), records everything that reaches it ----------
// `sessions`: false plays a host that predates sessions (401 to any EnclaveSession header, like an old supervisor's
// Bearer-only `authed`); true plays an updated one (any EnclaveSession header is taken - its verification is the
// host agent's to test, not the relay's).
async function stubHost(t, { sessions }) {
  const h = { log: [] };
  h.server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/availability")
        return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5, nodeVcpus: 8, nodeRamGb: 32, teeCpu: "amd-sev-snp" }));
      h.log.push({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers.authorization, body });
      const isSession = /^EnclaveSession /.test(req.headers.authorization || "");
      if (isSession && !sessions) { res.statusCode = 401; return res.end(JSON.stringify({ message: "Missing or invalid session" })); }
      if (req.url.split("?")[0] === "/v1/deployments") return res.end(JSON.stringify({ data: h.rows || [], cursor: null }));
      res.end(JSON.stringify({ servedBy: "host", method: req.method, url: req.url }));
    });
  });
  h.server.listen(0, "127.0.0.1"); await once(h.server, "listening");
  t.after(() => h.server.close());
  h.url = `http://127.0.0.1:${h.server.address().port}`;
  return h;
}

async function startRelay(t, { enclaves, ledger, env = {} }) {
  const rpc = stubRpc(ledger); await listenOnFreePort(rpc);
  const { child, port } = await bootDaemon({
    start: (port) => spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], {
      env: { ...process.env, ENCLAVES: enclaves, API_RELAY_PORT: String(port), API_RELAY_BIND: "127.0.0.1",
             BASE_RPC: `http://127.0.0.1:${rpc.address().port}`, RPC_FALLBACKS: "0", DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20),
             ADDRESS_BOOK_ADDRESS: "", AVAIL_POLL_SEC: "1", SESSIONS_RELAYER_KEY: "",
             FEATURED_VIEWS_FILE: path.join(os.tmpdir(), `feat-views-sf-${port}.json`), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    claimed: (log, port) => log.includes(`[api-relay] :${port}`),
    ready: async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).ok,
    tries: 3, timeoutMs: 30000,
  });
  t.after(() => { child.kill("SIGKILL"); rpc.close(); });
  return `http://127.0.0.1:${port}`;
}
const call = async (origin, method, p, headers = {}, body) => {
  const r = await fetch(origin + p, { method, headers, body });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const waitFor = async (pred, ms = 8000) => { const until = Date.now() + ms; while (Date.now() < until) { if (await pred()) return true; await delay(100); } return false; };
const hostLive = (origin, url) => waitFor(async () => ((await call(origin, "GET", "/enclaves")).body?.enclaves || [])
  .some((e) => e.endpoint === url && e.eligible === true));

const OWNER = "0x" + "aa".repeat(20);
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const D = (b) => "0x" + b.repeat(32);
// a syntactically real header; this relay never verifies it on a forwarded route (the host does)
const SESSION = "EnclaveSession v1 vault=0x" + "ab".repeat(20) + ",sid=0x" + "cd".repeat(32)
  + ",ts=" + Math.floor(Date.now() / 1000) + ",n=AAAAAAAAAAAAAAAA,x=" + "A".repeat(43) + ",y=" + "A".repeat(43) + ",sig=" + "A".repeat(86);

test("forwarded owner routes: the session header and the exact path+query reach the lease holder untouched, once", async (t) => {
  const h = await stubHost(t, { sessions: true });
  const ID = D("e1");
  const ledger = [{ id: ID, owner: OWNER, appRef: "ipfs://e", runner: keccak256(stringToBytes(h.url)), leaseUntil: FUTURE }];
  const origin = await startRelay(t, { enclaves: h.url, ledger });
  assert.ok(await hostLive(origin, h.url), "the host is live and eligible");

  const routes = [
    ["GET", `/v1/deployments/${ID}/logs?tail=200`],
    ["GET", `/v1/deployments/${ID}/attestation`],
    ["POST", `/v1/deployments/${ID}/restart`],
    ["POST", `/v1/deployments/${ID}/app-token`],
    ["DELETE", `/v1/deployments/${ID}?evacuate=1`],
    ["DELETE", `/v1/deployments/${ID}`],
  ];
  for (const [method, p] of routes) {
    const before = h.log.length;
    const r = await call(origin, method, p, { Authorization: SESSION });
    assert.equal(r.status, 200, `${method} ${p}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.servedBy, "host");
    const got = h.log.slice(before);
    assert.equal(got.length, 1, `${method} ${p} reached the host exactly once (a session header is single-use per host)`);
    assert.equal(got[0].method, method);
    assert.equal(got[0].url, p, "path and query unchanged");
    assert.equal(got[0].auth, SESSION, "Authorization unchanged");
    assert.equal(got[0].host, new URL(h.url).host, "a DIALED host sees its own endpoint as Host (proxyTo sets it)");
    assert.equal(got[0].body, "", "no body invented");
  }
  // a body travels byte for byte (the signature covers its sha256)
  const raw = '{"a":1,  "b":"x"}';
  const before = h.log.length;
  await call(origin, "POST", `/v1/deployments/${ID}/restart`, { Authorization: SESSION, "content-type": "application/json" }, raw);
  assert.equal(h.log[before].body, raw);

  // the bare record read: forwarded once with the header, the host's live row answers
  const b0 = h.log.length;
  const bare = await call(origin, "GET", `/v1/deployments/${ID}`, { Authorization: SESSION });
  assert.equal(bare.status, 200);
  assert.equal(bare.body.servedBy, "host");
  assert.deepEqual(h.log.slice(b0).map((x) => [x.method, x.url, x.auth]), [["GET", `/v1/deployments/${ID}`, SESSION]]);
});

test("a host that predates sessions: per-deployment 401 reaches the browser (its cue to fall back); the bare read and the list still answer from the ledger", async (t) => {
  const h = await stubHost(t, { sessions: false });
  const ID = D("e2");
  const ledger = [
    { id: ID, owner: OWNER, appRef: "ipfs://e", runner: keccak256(stringToBytes(h.url)), leaseUntil: FUTURE },
    { id: D("e3"), owner: OWNER, appRef: "ipfs://q" },
    { id: D("e4"), owner: "0x" + "bb".repeat(20), appRef: "ipfs://other" },
  ];
  const origin = await startRelay(t, { enclaves: h.url, ledger });
  assert.ok(await hostLive(origin, h.url));

  const logs = await call(origin, "GET", `/v1/deployments/${ID}/logs?tail=200`, { Authorization: SESSION });
  assert.equal(logs.status, 401, "the old host's 401 is passed through untouched");
  assert.equal(logs.body.message, "Missing or invalid session");

  const bare = await call(origin, "GET", `/v1/deployments/${ID}`, { Authorization: SESSION });
  assert.equal(bare.status, 200, "the host's 401 on a bare read falls through to the ledger");
  assert.equal(bare.body.ledger, true);

  // the list on a relay with sessions OFF: it cannot verify the header, so the ledger is scoped by ?owner=; the header
  // still fans out to the host unchanged, and every host answering it 401 is not a 401 for the caller
  const b0 = h.log.length;
  const list = await call(origin, "GET", `/v1/deployments?owner=${OWNER}`, { Authorization: SESSION });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.data.map((d) => d.id).sort(), [ID, D("e3")].sort(), "the owner's ledger rows, nobody else's");
  assert.deepEqual(h.log.slice(b0).map((x) => [x.method, x.url, x.auth]), [["GET", `/v1/deployments?owner=${OWNER}`, SESSION]],
    "fanned out once, path and header unchanged");
});

test("a non-ledger id is never PROBED with a session header (single-use: the probe would spend it)", async (t) => {
  const h = await stubHost(t, { sessions: true });
  const origin = await startRelay(t, { enclaves: h.url, ledger: [] });
  assert.ok(await hostLive(origin, h.url));
  const b0 = h.log.length;
  const r = await call(origin, "GET", "/v1/deployments/dep_abc123/logs", { Authorization: SESSION });
  assert.equal(r.status, 200, "found by the credential-free /x probe, then forwarded");
  const got = h.log.slice(b0);
  assert.deepEqual(got.filter((x) => x.auth).map((x) => [x.method, x.url, x.auth]),
    [["GET", "/v1/deployments/dep_abc123/logs", SESSION]], "the session reached the host exactly once: the real request");
  assert.ok(got.some((x) => x.method === "HEAD" && x.url === "/x/dep_abc123" && !x.auth), "the probe carried no credential");
});

// ---------- part 2: the relay verifies a session where it answers itself ----------
const skip = !haveFoundry() || !fs.existsSync(SDK) ? "needs Foundry (anvil + forge) and a built SDK (cd sdk/sessions && npm run build)" : false;
let chain, P, sdk, tmp;
before(async () => {
  if (skip) return;
  sdk = await import(SDK.href);
  chain = await startChain();
  P = await deployPlatform(chain);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-session-fwd-"));
});
after(() => { chain?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test("the list: a session the relay verifies (api.status) names its owner and vault for the ledger merge; the header fans out unchanged; replays and wrong hosts are refused", { skip }, async (t) => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const owner = privateKeyToAccount(KEYS.owner);
  const vault = await sdk.vaultAddress(chain.pc, P.factory, owner.address);
  const h = await stubHost(t, { sessions: false });            // an old host: it 401s the session; the list must not
  const ledger = [
    { id: D("f1"), owner: owner.address, appRef: "ipfs://wallet-held" },
    { id: D("f2"), owner: vault, appRef: "ipfs://vault-held" },
    { id: D("f3"), owner: "0x" + "bb".repeat(20), appRef: "ipfs://someone-else" },
  ];
  const dataDir = fs.mkdtempSync(path.join(tmp, "relay-"));
  const origin = await startRelay(t, { enclaves: h.url, ledger, env: {
    AUTH_DATA_DIR: dataDir, SESSIONS_RELAYER_KEY: KEYS.relayer, SESSIONS_NETWORK: "local", SESSIONS_CHAIN_ID: "31337",
    SESSIONS_RPC: chain.rpc, SESSIONS_FACTORY: P.factory, SESSIONS_BOOK: P.book, SESSIONS_USDC: P.usdc,
    SESSIONS_ROUTER: P.router, SESSIONS_START_BLOCK: String(P.deployBlock), SESSIONS_ETH_USD: "3000" } });
  assert.ok(await hostLive(origin, h.url));

  // a browser session, opened through THIS relay
  const store = new sdk.MemoryStore();
  const { signer, record } = await sdk.newSessionKey(store, { relay: origin, chainId: 31337, label: "this browser", extractable: true });
  const grant = sdk.buildGrant({ sessionKey: signer.keyHash, label: "this browser", preset: "browser", policy: { budget: 0n, expiresIn: 3600 } });
  const ownerSigner = { address: owner.address, signTypedData: (td) => owner.signTypedData(td) };
  await sdk.openSession({ relay: new sdk.RelayClient(origin), owner: ownerSigner, chainId: 31337, vault, grant });
  const session = await sdk.sessionFromRecord(await sdk.completeSession(store, record, { vault, owner: owner.address, grant, rpc: chain.rpc }));

  const url = origin + "/v1/deployments";
  const hdr = await session.apiAuthorization("GET", url);
  const b0 = h.log.length;
  const r = await call(origin, "GET", "/v1/deployments", { Authorization: hdr });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.map((d) => d.id).sort(), [D("f1"), D("f2")].sort(),
    "no ?owner=: the verified session scopes the ledger merge to its owner's rows and its vault's");
  assert.deepEqual(h.log.slice(b0).map((x) => [x.url, x.auth]), [["/v1/deployments", hdr]], "the header fanned out to the host unchanged");

  // a ?owner= naming someone else does not widen or move a verified session's scope
  const other = await call(origin, "GET", "/v1/deployments?owner=0x" + "bb".repeat(20),
    { Authorization: await session.apiAuthorization("GET", url + "?owner=0x" + "bb".repeat(20)) });
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.data.map((d) => d.id).sort(), [D("f1"), D("f2")].sort());

  // single use: the same header again is refused at the relay (and never fanned out)
  const b1 = h.log.length;
  const again = await call(origin, "GET", "/v1/deployments", { Authorization: hdr });
  assert.equal(again.status, 401);
  assert.match(again.body.message, /replayed/);
  assert.equal(h.log.length, b1, "a refused session reaches no host");

  // signed for another host: refused (the relay checks the Host it was reached on)
  const wrong = await session.apiAuthorization("GET", "https://api.enclave.host/v1/deployments");
  const w = await call(origin, "GET", "/v1/deployments", { Authorization: wrong });
  assert.equal(w.status, 401);
});
