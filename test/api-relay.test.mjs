// api-relay ledger-backed deployments — the public API must return EVERY
// on-chain deployment a wallet owns, hosted by an enclave or not. Drives the
// REAL relay as a child process against a stub Base JSON-RPC (serving
// ABI-encoded EnclaveDeployments pages) and fake/dead in-test "enclaves":
// fleet-down list/get answer from the ledger alone; fleet-up merges hosted
// rows (which win by id) with ledger-only rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { bootDaemon, listenOnFreePort } from "./helpers/daemon.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ABI fixtures: EnclaveDeployments.count()/getPage() --------------
// The stub plays a schema rev-2 ledger (17-field Deployment, no sshPubKey).
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

// ---------- the ledger under test -------------------------------------------
const OWNER   = "0x" + "aa".repeat(20);
const OTHER   = "0x" + "bb".repeat(20);
const RUNNER  = "0x" + "22".repeat(32);
const FUTURE  = Math.floor(Date.now() / 1000) + 3600;
const ID = (b) => "0x" + b.repeat(32);
const LEDGER = [
  { id: ID("11"), owner: OWNER, appRef: "ipfs://queued", active: true,  balance6: 5_000_000, spent6: 0 },                                   // funded, unclaimed
  { id: ID("22"), owner: OWNER, appRef: "ipfs://stopped", active: false, balance6: 1_000_000, spent6: 500_000 },                            // owner-stopped
  { id: ID("33"), owner: OWNER, appRef: "ipfs://claimed", active: true,  balance6: 2_000_000, spent6: 100_000, runner: RUNNER, leaseUntil: FUTURE }, // lease live, runner silent
  { id: ID("44"), owner: OWNER, appRef: "ipfs://unpaid", active: true, balance6: 0, spent6: 0 },                                            // created, never funded
  { id: ID("55"), owner: OTHER, appRef: "ipfs://foreign", active: true,  balance6: 9_000_000, spent6: 0 },                                  // someone else's
  { id: ID("88"), owner: OWNER, appRef: "ipfs://drained", active: true,  balance6: 2, spent6: 4_999_998, runner: RUNNER, leaseUntil: 1700000500 }, // ran, lease over, balance < rate
];

// ---------- harness ----------------------------------------------------------
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub, exp = Math.floor(Date.now() / 1000) + 3600) => `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub, exp })}.x`;

async function freePort() {
  const s = net.createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const p = s.address().port; s.close(); return p;
}
function stubRpc(ledger = LEDGER) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body);
      const one = (m) => {
        if (m.method !== "eth_call") return "0x";
        const data = m.params[0].data;
        if (data.startsWith("0x5d1b72b6")) return "0x" + W(2);                        // deploymentsSchema() -> rev 2
        if (data.startsWith("0x06661abd")) return "0x" + W(ledger.length);            // count()
        const start = Number(BigInt("0x" + data.slice(10, 74)));
        const n = Number(BigInt("0x" + data.slice(74, 138)));
        return encPage(ledger.slice(start, start + n));                               // getPage(start, n)
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(q)
        ? q.map((m) => ({ jsonrpc: "2.0", id: m.id, result: one(m) }))
        : { jsonrpc: "2.0", id: q.id, result: one(q) }));
    });
  });
}
async function startRelay(t, { enclaves, ledger, env = {} }) {
  const rpc = stubRpc(ledger); await listenOnFreePort(rpc);
  // the relay must prove it won the port before /health means anything: every
  // daemon here serves /health, so a stranger holding the port answers 200 just
  // as happily. api-relay logs "[api-relay] :<port>" from inside its listen
  // callback, which is reached only on a successful bind.
  const { child, port } = await bootDaemon({
    start: (port) => spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], {
      env: { ...process.env, ENCLAVES: enclaves, API_RELAY_PORT: String(port), API_RELAY_BIND: "127.0.0.1",
             BASE_RPC: `http://127.0.0.1:${rpc.address().port}`, RPC_FALLBACKS: "0", DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20),
             FEATURED_VIEWS_FILE: path.join(os.tmpdir(), `feat-views-${port}.json`), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    claimed: (log, port) => log.includes(`[api-relay] :${port}`),
    ready: async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).ok,
  });
  t.after(() => { child.kill("SIGKILL"); rpc.close(); });
  return `http://127.0.0.1:${port}`;
}
const getJson = async (origin, p, tok) => {
  const r = await fetch(origin + p, { headers: tok ? { Authorization: "Bearer " + tok } : {} });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---------- fleet DOWN: the ledger alone answers -----------------------------
test("api-relay: zero live enclaves — list returns every on-chain deployment the wallet owns", async (t) => {
  const origin = await startRelay(t, { enclaves: "http://127.0.0.1:1" });   // dead enclave -> live=[]

  const { status, body } = await getJson(origin, "/v1/deployments", jwt(OWNER));
  assert.equal(status, 200);
  const rows = body.data;
  assert.equal(rows.length, 5, "all five of the owner's ledger records, none of the foreign one");
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by[ID("11")].status, "queued");
  assert.equal(by[ID("22")].status, "stopped");
  assert.equal(by[ID("33")].status, "claimed");
  assert.equal(by[ID("44")].status, "awaiting_payment");
  assert.equal(by[ID("88")].status, "unfunded", "drained work (balance < rate) must not read as queued: nothing will claim it");
  assert.ok(rows.every((r) => r.ledger === true), "rows are marked as ledger-synthesized");
  assert.equal(by[ID("11")].image.reference, "ipfs://queued");
  assert.equal(by[ID("11")].paidUsdc, "5.00");
  assert.equal(by[ID("22")].paidUsdc, "1.50", "paid = balance + spent");
  assert.ok(by[ID("33")].onchain.leaseUntil, "live lease surfaces its expiry");
  // remaining runtime counts the PREPAID lease tail, not just the balance:
  // 2_000_000 balance / rate 3 = 666_666s funded + up to 3600s of live lease
  assert.ok(by[ID("33")].timeRemainingSec > 666_666, "a live lease adds its prepaid tail to timeRemainingSec");
  assert.ok(by[ID("33")].timeRemainingSec <= 666_666 + 3600, "…but no more than the lease that was bought");
  assert.equal(by[ID("88")].timeRemainingSec, 0, "drained + expired lease = nothing left");

  // TOKENLESS listing: a connected wallet's address is enough (?owner= scopes
  // the public ledger rows - no SIWE popup needed just to see your fleet)
  const noTok = await getJson(origin, "/v1/deployments?owner=" + OWNER);
  assert.equal(noTok.status, 200);
  assert.equal(noTok.body.data.length, 5, "owner param scopes the same 5 rows without any token");
  assert.ok(noTok.body.data.every((r) => r.ledger === true));
  // scoping is NOT authentication: ledger rows are public on-chain data
  const foreign = await getJson(origin, "/v1/deployments?owner=" + OTHER);
  assert.equal(foreign.body.data.length, 1, "any address's public rows are listable");
  // neither token nor owner -> 401 (nothing to scope the list by)
  assert.equal((await getJson(origin, "/v1/deployments")).status, 401);
  // expired token and no owner -> 401 too
  assert.equal((await getJson(origin, "/v1/deployments", jwt(OWNER, 1))).status, 401);
  // tokenless bare read: ?owner= scopes, and even unscoped reads resolve
  // (records are public); prefixes disambiguate within the scope
  const noTokOne = await getJson(origin, "/v1/deployments/" + ID("11") + "?owner=" + OWNER);
  assert.equal(noTokOne.status, 200);
  assert.equal(noTokOne.body.status, "queued");

  // bare record read: full id and unique prefix both resolve from the ledger
  const one = await getJson(origin, "/v1/deployments/" + ID("11"), jwt(OWNER));
  assert.equal(one.status, 200);
  assert.equal(one.body.status, "queued");
  const pre = await getJson(origin, "/v1/deployments/0x2222", jwt(OWNER));
  assert.equal(pre.status, 200, "prefix resolves");
  assert.equal(pre.body.id, ID("22"));
  // someone else's record and unknown ids stay invisible
  assert.equal((await getJson(origin, "/v1/deployments/" + ID("55"), jwt(OWNER))).status, 404);
  assert.equal((await getJson(origin, "/v1/deployments/" + ID("99"), jwt(OWNER))).status, 404);
  // subpaths (logs/attestation) still need a live enclave
  assert.equal((await getJson(origin, "/v1/deployments/" + ID("11") + "/logs", jwt(OWNER))).status, 503);

  // fleet-down honesty: the API front door is UP (health says so instead of
  // crying no_capacity), and auth failures explain what is actually down
  const health = await getJson(origin, "/v1/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.enclaves, 0);
  const nonce = await getJson(origin, "/v1/auth/nonce?address=" + OWNER);
  assert.equal(nonce.status, 503);
  assert.equal(nonce.body.error, "auth_unavailable", "sign-in failures name the real cause, not generic no_capacity");
  assert.match(nonce.body.message, /enclave-issued/);
});

/* A RELAY is a host that carries network but sells no compute — same registry,
   same registration, no contract change. "No resources at all" is the whole
   definition, and it has to do two jobs at once:

     - presentation: the console badges the row as a relay and lists the network
       services it declared, instead of drawing empty capacity bars that would
       read as a box that is FULL;
     - safety: it must stay out of the serving set. That set decides the
       fleet-minimum spec* fields and every fleet-AND capability flag, so one box
       advertising zero vCPUs inside it collapses the minima and turns the
       feature flags false FLEET-WIDE. That is the metal0 sizing incident, and a
       resourceless relay reproduces it exactly unless it is excluded. */
test("api-relay: a resourceless box reads as a relay, and never as capacity", async (t) => {
  const relayBox = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability") return res.end(JSON.stringify({
      gpu: false, type: "cpu", cpuShareFree: 0, gpuShareFree: 0, maxShare: 0,
      nodeVcpus: 0, nodeRamGb: 0, claimEnabled: false,
      relay: { sni: true, tcp: true, udp: false, egress: true, tunnelHub: false,
               region: "eu-north", v6Prefix: "2a01:4f9:c013:9b52::/64", ports: "1-49999" },
    }));
    res.statusCode = 404; res.end("{}");
  });
  const hostBox = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability") return res.end(JSON.stringify({
      gpu: false, type: "cpu", cpuShareFree: 0.5, maxShare: 0.5, nodeVcpus: 8, nodeRamGb: 32 }));
    res.statusCode = 404; res.end("{}");
  });
  for (const s of [relayBox, hostBox]) { s.listen(0, "127.0.0.1"); await once(s, "listening"); }
  t.after(() => { relayBox.close(); hostBox.close(); });

  const origin = await startRelay(t, { enclaves:
    `http://127.0.0.1:${relayBox.address().port},http://127.0.0.1:${hostBox.address().port}` });
  const { status, body } = await getJson(origin, "/enclaves");
  assert.equal(status, 200);

  const rows = Object.fromEntries(body.enclaves.map((r) => [r.availability.nodeVcpus, r]));
  const relayRow = rows[0], hostRow = rows[8];
  assert.ok(relayRow && hostRow, "both boxes are listed — a relay is still a fleet member");
  assert.equal(relayRow.relay, true, "no resources ⇒ relay");
  assert.equal(relayRow.serving, false, "and never in the set that sizes the fleet");
  assert.equal(hostRow.relay, false, "a box with capacity is not a relay, whatever else it carries");
  assert.equal(hostRow.serving, true);

  assert.equal(body.aggregate.enclaves, 2, "listed");
  assert.equal(body.aggregate.serving, 1, "but only one of them can take work");
  assert.equal(body.aggregate.totalCpuShareFree, 0.5, "the relay adds no buyable capacity");

  // the declared network services survive the trip — this is the payload the
  // console renders in place of capacity bars
  assert.equal(relayRow.availability.relay.sni, true);
  assert.equal(relayRow.availability.relay.region, "eu-north");
  assert.equal(relayRow.availability.relay.v6Prefix, "2a01:4f9:c013:9b52::/64");
});

/* The fail-safe half of the same rule. "No resources" must mean DECLARED zero,
   never a field the box didn't send: an older enclave that omits nodeVcpus is a
   host of unknown size, and reading it as a relay would quietly pull real
   capacity out of the serving set — the fleet shrinking with nothing logged. */
test("api-relay: an enclave that omits its size is a host, not a relay", async (t) => {
  const terse = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability")               // no nodeVcpus, no nodeRamGb
      return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5 }));
    res.statusCode = 404; res.end("{}");
  });
  terse.listen(0, "127.0.0.1"); await once(terse, "listening");
  t.after(() => terse.close());

  const origin = await startRelay(t, { enclaves: `http://127.0.0.1:${terse.address().port}` });
  const { body } = await getJson(origin, "/enclaves");
  assert.equal(body.enclaves[0].relay, false, "silence is not a claim of emptiness");
  assert.equal(body.enclaves[0].serving, true, "and it keeps taking work");
});

// ---------- fleet UP: hosted rows win, ledger fills the gaps -----------------
test("api-relay: live enclave rows merge with ledger-only rows, deduped by id", async (t) => {
  const hosted = { id: ID("33"), status: "running", owner: OWNER, image: { reference: "ipfs://claimed" },
                   resources: { gpuShare: 0, cpuShare: 0.01 } };
  const enclave = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability") return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5, nodeVcpus: 8, nodeRamGb: 32 }));
    if (req.url === "/v1/deployments" && req.method === "GET") return res.end(JSON.stringify({ data: [hosted], cursor: null }));
    res.statusCode = 404; res.end("{}");
  });
  enclave.listen(0, "127.0.0.1"); await once(enclave, "listening");
  t.after(() => enclave.close());

  const origin = await startRelay(t, { enclaves: `http://127.0.0.1:${enclave.address().port}` });
  const { status, body } = await getJson(origin, "/v1/deployments", jwt(OWNER));
  assert.equal(status, 200);
  const by = Object.fromEntries(body.data.map((r) => [r.id, r]));
  assert.equal(body.data.length, 5, "hosted row + the 4 ledger-only rows, no duplicate for the hosted id");
  assert.equal(by[ID("33")].status, "running", "the enclave's live row wins over the ledger view");
  assert.equal(by[ID("33")].ledger, undefined);
  assert.equal(by[ID("11")].status, "queued");
  assert.ok(by[ID("11")].ledger, "unhosted work still comes from the ledger");

  // a TOKENLESS bare read of a HOSTED id must not proxy (the enclave would
  // 401 it) - the ledger view answers instead
  const bare = await getJson(origin, "/v1/deployments/" + ID("33"));
  assert.equal(bare.status, 200);
  assert.equal(bare.body.status, "claimed", "tokenless hosted read serves the ledger view, not a proxied 401");
  assert.ok(bare.body.ledger);
});

// ---------- lease + live runner: the ledger view says "running" --------------
// The dashboard's tokenless list is built purely from ledger rows; a deployment
// whose lease-holder is a live, answering enclave must read "running", not sit
// on "claimed" forever. The match is the registry's id rule: keccak256(endpoint).
test("api-relay: a leased deployment whose runner is live reads as running, even tokenless", async (t) => {
  const enclave = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability") return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5 }));
    res.statusCode = 404; res.end("{}");
  });
  enclave.listen(0, "127.0.0.1"); await once(enclave, "listening");
  t.after(() => enclave.close());
  const endpoint = `http://127.0.0.1:${enclave.address().port}`;
  const { keccak256, stringToBytes } = await import("viem");
  const ledger = [
    { id: ID("66"), owner: OWNER, appRef: "ipfs://hosted", active: true, balance6: 2_000_000, spent6: 100_000,
      runner: keccak256(stringToBytes(endpoint)), leaseUntil: FUTURE },     // lease live, runner IS the live enclave
    { id: ID("77"), owner: OWNER, appRef: "ipfs://orphaned", active: true, balance6: 2_000_000, spent6: 100_000,
      runner: RUNNER, leaseUntil: FUTURE },                                 // lease live, runner unknown/absent
  ];

  const origin = await startRelay(t, { enclaves: endpoint, ledger });
  const { status, body } = await getJson(origin, "/v1/deployments?owner=" + OWNER);
  assert.equal(status, 200);
  const by = Object.fromEntries(body.data.map((r) => [r.id, r]));
  assert.equal(by[ID("66")].status, "running", "lease live + runner answering = running, no session needed");
  assert.equal(by[ID("77")].status, "claimed", "lease live but runner silent stays claimed");
  const bare = await getJson(origin, "/v1/deployments/" + ID("66"));
  assert.equal(bare.status, 200);
  assert.equal(bare.body.status, "running", "the tokenless bare read agrees");
});

// ---------- free self-hosting: the status a seller's own row must NOT get ----
// SOURCE-PINNED, deliberately. Reaching hostedFree() for real needs a live
// enclave discovered from the on-chain REGISTRY (only those rows carry a
// payoutWallet), and discoverRegistry drops any endpoint on a loopback/private
// host — the SSRF guard that exists so a permissionless registry can never make
// this relay dial its own localhost. Every harness here therefore runs on
// STATIC_ENCLAVES, which have no registry entry at all. So pin the logic where
// it can be seen; the money-side behaviour is proven in
// contracts/foundry/test/EnclaveDeployments.selfHost.t.sol and the runner side
// in test/rate-cap.test.mjs.
test("api-relay: a free self-hosted row reads queued, never awaiting_payment or unfunded", () => {
  const src = fs.readFileSync(path.join(RELAY_DIR, "api-relay.js"), "utf8");
  // the verdict itself: an ANSWERING enclave that has declared this owner
  assert.match(src, /const hostedFree = \(owner\) => \{[\s\S]{0,400}live\.some\(\(e\) => e\.payoutWallet/,
    "hostedFree must be decided from the live fleet's declared payout wallets");
  // both money-shaped statuses have to yield to it, or a seller who owes
  // nothing is told to pay: "awaiting_payment" before the first claim (a free
  // record never gets a balance) and "unfunded" between leases
  assert.match(src, /if \(!free && !\(d\.balance6 > 0n \|\| d\.spent6 > 0n\)\) return "awaiting_payment";/);
  assert.match(src, /return free \|\| d\.balance6 >= d\.rate \? "queued" : "unfunded";/);
  // and the row says so, because before its first claim the record still
  // carries its worst-case CEILING as the rate it would otherwise quote
  assert.match(src, /\.\.\.\(free \? \{ hostedFree: true \} : \{\}\),/);
  assert.match(src, /timeRemainingSec: rate6 > 0 && !free \?/,
    "a free deployment has no funded-time horizon to count down");
  // the plumbing that feeds all of the above: schema 4's field must survive
  // discoverRegistry's projection, or hostedFree is false
  assert.match(src, /payoutWallet: e\.payoutWallet \|\| null/);
  assert.match(src, /\{ name: "payoutWallet", type: "address" \},\n\s*\{ name: "caps", type: "uint64" \}, \{ name: "region", type: "string" \}\]/,
    "the registry tuple must decode schema 4's payout wallet and schema 5's capability pair");
});

// ---------- fleet refuses the token: surface the 401, don't mask it ----------
test("api-relay: a fleet-wide 401 propagates instead of falling back to ledger rows", async (t) => {
  const enclave = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability") return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5 }));
    res.statusCode = 401; res.end(JSON.stringify({ error: "unauthorized", message: "bad token" }));
  });
  enclave.listen(0, "127.0.0.1"); await once(enclave, "listening");
  t.after(() => enclave.close());

  const origin = await startRelay(t, { enclaves: `http://127.0.0.1:${enclave.address().port}` });
  const r = await getJson(origin, "/v1/deployments", jwt(OWNER));
  assert.equal(r.status, 401, "the enclaves' refusal is the answer; public ledger rows must not mask a dead session");
});

// ---------- stranded lease: runner answers but doesn't host the record -------
// ledgerStatus can only see lease + runner-liveness, so a lease that outlived
// its enclave-local record (restart/update wiped state, or the resume found no
// capacity) reads "running" while the app is dark and the owner pays. When the
// signed-in fan-out has the runner's OWN 200 list and the id is absent, the
// merged row must say "claimed" (+ stranded) — observed live 2026-07-17: a
// displaced tenant read RUNNING for a full lease while serving nothing.
test("api-relay: a leased id missing from its live runner's own list downgrades to claimed+stranded", async (t) => {
  const hosted = { id: ID("33"), status: "running", owner: OWNER, image: { reference: "ipfs://served" },
                   resources: { gpuShare: 0.35, cpuShare: 0.01 } };
  const enclave = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability") return res.end(JSON.stringify({ gpu: true, gpuShareFree: 0.14, cpuShareFree: 0.9 }));
    if (req.url === "/v1/deployments" && req.method === "GET") return res.end(JSON.stringify({ data: [hosted], cursor: null }));
    res.statusCode = 404; res.end("{}");
  });
  enclave.listen(0, "127.0.0.1"); await once(enclave, "listening");
  t.after(() => enclave.close());
  const endpoint = `http://127.0.0.1:${enclave.address().port}`;
  const { keccak256, stringToBytes } = await import("viem");
  const us = keccak256(stringToBytes(endpoint));
  const ledger = [
    { id: ID("33"), owner: OWNER, appRef: "ipfs://served", active: true, balance6: 2_000_000, spent6: 100_000,
      runner: us, leaseUntil: FUTURE },          // genuinely hosted: enclave row wins by id
    { id: ID("99"), owner: OWNER, appRef: "ipfs://zombie", active: true, balance6: 2_000_000, spent6: 500_000,
      runner: us, leaseUntil: FUTURE },          // OUR live runner, but its list lacks it -> stranded
    { id: ID("77"), owner: OWNER, appRef: "ipfs://orphan", active: true, balance6: 2_000_000, spent6: 100_000,
      runner: RUNNER, leaseUntil: FUTURE },      // runner not live at all: plain "claimed", not stranded
  ];

  const origin = await startRelay(t, { enclaves: endpoint, ledger });
  const signed = await getJson(origin, "/v1/deployments", jwt(OWNER));
  assert.equal(signed.status, 200);
  const by = Object.fromEntries(signed.body.data.map((r) => [r.id, r]));
  assert.equal(by[ID("33")].status, "running", "the enclave's own row still wins for what it truly hosts");
  assert.equal(by[ID("99")].status, "claimed", "leased-but-unhosted must not read running");
  assert.equal(by[ID("99")].stranded, true, "the downgrade is flagged for UIs");
  assert.ok(by[ID("99")].ledger);
  assert.equal(by[ID("77")].status, "claimed", "dead-runner lease stays claimed");
  assert.equal(by[ID("77")].stranded, undefined, "no stranded flag without an answering runner");

  // tokenless: no fan-out, no runner list to consult -> the pure ledger view
  // keeps "running" (documented best-effort; the signed-in view carries truth)
  const anon = await getJson(origin, "/v1/deployments?owner=" + OWNER);
  const anonBy = Object.fromEntries(anon.body.data.map((r) => [r.id, r]));
  assert.equal(anonBy[ID("99")].status, "running");
  assert.equal(anonBy[ID("99")].stranded, undefined);
});

// ---------- featured-slot view metering --------------------------------------
test("api-relay: featured-view metering — counts once per client per day, serves lifetime totals", async (t) => {
  const origin = await startRelay(t, { enclaves: "http://127.0.0.1:1" });
  const app = "0x" + "ab".repeat(32);
  const post = (body) => fetch(origin + "/v1/featured-view", { method: "POST", body });

  assert.equal((await post(JSON.stringify({ app }))).status, 200);
  assert.equal((await post(JSON.stringify({ app }))).status, 200);   // same client+app+day: accepted, not re-counted

  const { views } = await (await fetch(origin + "/v1/featured-views")).json();
  assert.equal(views[app], 1, "the second beacon from the same client deduped");

  assert.equal((await post("{}")).status, 400, "missing app refused");
  assert.equal((await post(JSON.stringify({ app: "not-an-id" }))).status, 400, "malformed app refused");

  const after = await (await fetch(origin + "/v1/featured-views")).json();
  assert.equal(after.views[app], 1, "refused beacons count nothing");
});

// ---------- the request target itself ----------------------------------------
// Node hands an absolute-form target (`GET http://elsewhere/y`, legal for
// proxies) straight to req.url. The relay routes on the parsed pathname but
// FORWARDS req.url, so two readings of one target reach two different places —
// and the concatenated upstream URL is nonsense either way. Origin-form only.
// The same guard is why a malformed target can never be a fleet outage: a
// synchronous throw in a request listener is an uncaughtException, and this
// daemon exits on those.
test("api-relay: only origin-form request targets are served, and a bad one is not fatal", async (t) => {
  const origin = await startRelay(t, { enclaves: "http://127.0.0.1:1" });
  const port = Number(new URL(origin).port);

  const raw = (target) => new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () =>
      s.write(`GET ${target} HTTP/1.1\r\nHost: api.enclave.host\r\nConnection: close\r\n\r\n`));
    let out = "";
    s.setTimeout(5000, () => { s.destroy(); reject(new Error("timeout")); });
    s.on("data", (d) => (out += d));
    s.on("close", () => resolve(out));
    s.on("error", reject);
  });

  assert.match(await raw("http://elsewhere.example/health"), /^HTTP\/1\.1 400 /, "absolute-form refused");
  assert.match(await raw("*"), /^HTTP\/1\.1 400 /, "asterisk-form refused");
  assert.match(await raw("/health"), /^HTTP\/1\.1 200 /, "origin-form still served");

  // …and the relay is still up: the guard answers, it does not crash the box
  const h = await fetch(origin + "/health");
  assert.equal(h.status, 200);
  // The relay's OWN answers carry the transport headers api.enclave.host never
  // inherited from the apex vhost (it is a different host): a caller that goes
  // straight to the API has no HSTS pin otherwise, and JSON went out sniffable.
  // Proxied TENANT bytes are deliberately not stamped - that is the app's shape.
  assert.equal(h.headers.get("x-content-type-options"), "nosniff");
  assert.match(h.headers.get("strict-transport-security") || "", /^max-age=31536000; includeSubDomains$/);
});

// ---------- deployment-id prefix collisions ----------------------------------
// An app subdomain is a deployment id PREFIX — canonically 8 hex chars, 32
// bits. That is not a birthday problem: ids are keccak256(creator, nonce), so
// an attacker hashes candidate creator addresses offline until one's first id
// shares a victim's prefix (seconds, no gas), then creates that one deployment.
// The ledger closes this at the root from rev 7 on (create reserves the
// prefix), but records minted before that — and any relay pointed at an older
// ledger — still need the router to refuse: a prefix naming two deployments
// names neither, and must never be resolved by "whichever enclave answers the
// probe first", which is a race the attacker can win and then hold in the
// owner cache for five minutes.
test("api-relay: an ambiguous id prefix resolves to nobody, not to whoever answers first", async (t) => {
  const TWIN_A = "0xabcdef01" + "11".repeat(28);
  const TWIN_B = "0xabcdef01" + "22".repeat(28);
  const LONE   = "0x0fedcba9" + "33".repeat(28);
  const ledger = [
    { id: TWIN_A, owner: OWNER, appRef: "ipfs://a", active: true, isPublic: true, balance6: 5_000_000, spent6: 0 },
    { id: TWIN_B, owner: OTHER, appRef: "ipfs://b", active: true, isPublic: true, balance6: 5_000_000, spent6: 0 },
    { id: LONE,   owner: OWNER, appRef: "ipfs://c", active: true, isPublic: true, balance6: 5_000_000, spent6: 0 },
  ];
  // an enclave that claims EVERY id it is probed for — the hostile-answer case
  const enclave = http.createServer((req, res) => {
    if (req.url === "/availability") { res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5, nodeVcpus: 8, nodeRamGb: 32 })); }
    res.statusCode = 200; res.end("served");
  });
  enclave.listen(0, "127.0.0.1"); await once(enclave, "listening");
  t.after(() => enclave.close());

  const origin = await startRelay(t, { enclaves: `http://127.0.0.1:${enclave.address().port}`, ledger,
                                       env: { APP_DOMAIN: "app.enclave.host" } });

  const shared = await fetch(origin + "/x/0xabcdef01/");
  assert.equal(shared.status, 404, "a prefix two ledger rows answer to must not route anywhere");
  // …while an unambiguous prefix still resolves exactly as before
  const lone = await fetch(origin + "/x/0x0fedcba9/");
  assert.equal(lone.status, 200, "an unambiguous prefix must keep working");
  // the on-demand TLS gate reads the same resolver, so a contested hostname
  // never earns a certificate either
  const ask = (label) => fetch(origin + `/internal/tls-ask?domain=${label}.app.enclave.host`);
  assert.equal((await ask("abcdef01")).status, 404, "a contested hostname must not earn a certificate");
  assert.equal((await ask("0fedcba9")).status, 200, "an unambiguous one still does");

  // and the app subdomain itself, which is the whole point of the prefix
  // fetch() forbids setting Host, so route via x-forwarded-host (TRUSTED_PROXY
  // is on by default, which is how Caddy fronts the relay in production)
  const host = (label) => fetch(origin + "/", { headers: { "x-forwarded-host": `${label}.app.enclave.host` } });
  assert.equal((await host("abcdef01")).status, 404, "the contested subdomain serves nobody");
  assert.equal((await host("0fedcba9")).status, 200, "the uncontested one serves its app");
});

// ---------- abandoned stream: the enclave leg dies with the client ------------
// pipe() stops the FLOW when its destination closes but never destroys its
// source, so a client that abandoned an SSE stream used to leave the proxied
// enclave request open forever: the paused pipe backpressured into the app,
// which sat parked in a write that could neither finish nor fail. For llm-chat
// that parked write pins one of ENCLAVE_GGML_MAX_SESSIONS inference slots, and
// a handful of closed tabs wedged the deployment into [sessions_busy] until a
// human restarted it (live 2026-08-08). The proxy must close its upstream leg
// the moment the client goes away.
test("api-relay: a client that dies mid-stream takes the enclave leg down with it", async (t) => {
  const XID = "0x99" + "44".repeat(28);
  const ledger = [
    { id: XID, owner: OWNER, appRef: "ipfs://sse", active: true, isPublic: true, balance6: 5_000_000, spent6: 0 },
  ];
  let upstreamClosed = false;
  const enclave = http.createServer((req, res) => {
    if (req.url === "/availability") { res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5, nodeVcpus: 8, nodeRamGb: 32 })); }
    if (req.method === "HEAD") { res.statusCode = 200; return res.end(); }  // the ownership probe
    // the app: an endless SSE stream. Ticks every 25ms keep bytes MOVING so
    // the relay's idle timeout can never be what cleans this up - only the
    // eager close-propagation under test can.
    res.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setInterval(() => res.write("data: tick\n\n"), 25);
    res.on("close", () => { upstreamClosed = true; clearInterval(timer); });
  });
  enclave.listen(0, "127.0.0.1"); await once(enclave, "listening");
  t.after(() => enclave.close());

  const origin = await startRelay(t, { enclaves: `http://127.0.0.1:${enclave.address().port}`, ledger });

  // open the stream, take one chunk to prove it flows, then die abruptly
  const got = await new Promise((resolve, reject) => {
    const creq = http.get(origin + `/x/${XID}/stream`, (cres) => {
      cres.once("data", () => { creq.destroy(); resolve(true); });
    });
    creq.on("error", reject);
  });
  assert.equal(got, true, "the stream was flowing before the client died");
  for (let i = 0; i < 120 && !upstreamClosed; i++) await delay(25);
  assert.equal(upstreamClosed, true, "the relay must destroy its enclave request when the client dies");
});

// ---------- X-Forwarded-For: which entry is the rate-limit key -----------------

test("api-relay: rate limits key on the PROXY-APPENDED address, not the caller's claim", async (t) => {
  // X-Forwarded-For is a client-writable header that the proxy APPENDS its peer
  // to, so a request sent as `X-Forwarded-For: 1.2.3.4` arrives as
  // `1.2.3.4, <real client>`. Keying on the FIRST entry let anyone mint a fresh
  // bucket per request by varying a header - and this key guards the ACME
  // on-demand-TLS miss limiter (burning the CA's rate limit takes every app
  // hostname down), the passkey/SIWE attempt limits, and the paid featured-view
  // dedupe.
  //
  // /v1/secrets/exists is the probe: relay-owned (so it answers with a dead
  // fleet, unlike /v1/claim-hint, which sits behind the no_capacity guard),
  // unauthenticated, and keyed per IP at capacity 120.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xff-"));
  const origin = await startRelay(t, { enclaves: "http://127.0.0.1:1",
    env: { SECRETS_KEY: "11".repeat(32), AUTH_DATA_DIR: dir } });
  const probe = (xff) => fetch(origin + "/v1/secrets/exists", {
    method: "POST",
    headers: { "content-type": "application/json", ...(xff ? { "x-forwarded-for": xff } : {}) },
    body: JSON.stringify({ id: "0x" + "11".repeat(32) }) }).then((r) => r.status);

  assert.equal(await probe(), 200, "secrets must be enabled for this probe to mean anything");

  // 200 requests each CLAIMING a different origin, all arriving from one real
  // client (the last entry). Keyed on the first entry these are 200 fresh
  // buckets and none is limited; keyed on the last they share one.
  const spoofed = await Promise.all(Array.from({ length: 200 }, (_, i) => probe(`10.9.8.${i % 250}, 203.0.113.9`)));
  const limited = spoofed.filter((s) => s === 429).length;
  assert.ok(limited > 0,
    `200 requests from one real client were all allowed - the spoofable first X-Forwarded-For entry is still the key`);

  // and a genuinely different client is not punished for that burst
  assert.equal(await probe("10.9.8.1, 198.51.100.7"), 200, "a different real client must get its own bucket");
});

// ---------- auth is enclave-scoped: the client may pin which box mints -------
// Every enclave signs sessions with its OWN in-enclave key and verifies only
// its own kid, so a token from the sticky box is rejected everywhere else. Any
// owner-authenticated call on a deployment hosted elsewhere then 401s "Missing
// or invalid session" — which is what Restart/logs/attestation/Move did on a
// metal0-hosted deployment (2026-07-27). ?enclave= pins the SIWE round trip to
// the box that will actually be asked to act.
test("api-relay: ?enclave= pins /v1/auth/* to that box; sticky otherwise", async (t) => {
  const mk = (label, gpu) => {
    const s = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/availability")
        return res.end(JSON.stringify({ gpu, cpuShareFree: 0.5, gpuShareFree: gpu ? 0.5 : 0, nodeVcpus: 8, nodeRamGb: 32 }));
      if (req.url.startsWith("/v1/auth/nonce")) return res.end(JSON.stringify({ nonce: "n", who: label }));
      if (req.url.startsWith("/v1/pricing")) return res.end(JSON.stringify({ who: label }));
      res.statusCode = 404; res.end("{}");
    });
    return s;
  };
  const gpuBox = mk("gpubox", true), cpuBox = mk("cpubox", false);
  for (const s of [gpuBox, cpuBox]) { s.listen(0, "127.0.0.1"); await once(s, "listening"); t.after(() => s.close()); }
  const gpuUrl = `http://127.0.0.1:${gpuBox.address().port}`, cpuUrl = `http://127.0.0.1:${cpuBox.address().port}`;
  const origin = await startRelay(t, { enclaves: `${gpuUrl},${cpuUrl}` });

  const plain = await getJson(origin, "/v1/auth/nonce?address=" + OWNER);
  assert.equal(plain.status, 200);
  assert.equal(plain.body.who, "gpubox", "unpinned auth keeps the sticky box (nonces are per-enclave state)");

  const pinned = await getJson(origin, `/v1/auth/nonce?address=${OWNER}&enclave=${encodeURIComponent(cpuUrl)}`);
  assert.equal(pinned.status, 200);
  assert.equal(pinned.body.who, "cpubox", "a pin routes the whole SIWE round trip to the named box");

  // an unknown name must NOT fail: a pin is an optimization, and not signing in
  // at all is worse than signing in against the wrong box
  const bogus = await getJson(origin, `/v1/auth/nonce?address=${OWNER}&enclave=nosuchbox`);
  assert.equal(bogus.status, 200);
  assert.equal(bogus.body.who, "gpubox", "an unknown pin falls back to sticky rather than erroring");

  // the pin is auth-only: it must not let a caller aim unrelated fleet calls
  const priced = await getJson(origin, `/v1/pricing?enclave=${encodeURIComponent(cpuUrl)}`);
  assert.equal(priced.status, 200);
  assert.equal(priced.body.who, "gpubox", "non-auth paths ignore the pin");
});

// ---------- a Move must take effect on the NEXT call, not in five minutes ----
// The relay caches "which enclave owns this id" for 5 minutes to avoid a
// fan-out probe per request. That cache used to be consulted BEFORE the
// ledger, so the instant a Move rewrote the runner on chain, every
// control-plane call still went to the box that had just given the deployment
// up — and that box answers "No such deployment.", because releasing drops its
// local record. Verify/logs/restart on a just-moved app failed that way for up
// to OWNER_TTL_MS (found 2026-07-28 after a metal0 -> kryptos -> metal0 move).
// The old host keeps a stale row in its OWN list for a while too, which is what
// poisons the cache here — exactly as it does in production.
test("api-relay: the on-chain runner outranks a cached owner, so a moved deployment routes to its new host", async (t) => {
  const ID66 = ID("66");
  const mk = (label, hosts) => http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability")
      return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5, nodeVcpus: 8, nodeRamGb: 32 }));
    // the deployment-scoped call: the previous host has nothing left to serve
    if (req.url.startsWith(`/v1/deployments/${ID66}`)) {
      if (!hosts) { res.statusCode = 404; return res.end(JSON.stringify({ code: "not_found", message: "No such deployment." })); }
      return res.end(JSON.stringify({ who: label }));
    }
    // …but it still LISTS the row (its local record outlives the release), and
    // every row in a 200 list teaches the relay an owner for that id
    if (req.url.split("?")[0] === "/v1/deployments")
      return res.end(JSON.stringify({ data: hosts ? [] : [{ id: ID66, status: "running" }], cursor: null }));
    res.statusCode = 404; res.end("{}");
  });
  const oldHost = mk("oldhost", false), newHost = mk("newhost", true);
  for (const s of [oldHost, newHost]) { s.listen(0, "127.0.0.1"); await once(s, "listening"); t.after(() => s.close()); }
  const oldUrl = `http://127.0.0.1:${oldHost.address().port}`, newUrl = `http://127.0.0.1:${newHost.address().port}`;

  const { keccak256, stringToBytes } = await import("viem");
  const ledger = [
    { id: ID66, owner: OWNER, appRef: "ipfs://moved", active: true, balance6: 2_000_000, spent6: 100_000,
      runner: keccak256(stringToBytes(newUrl)), leaseUntil: FUTURE },       // the chain says: newHost holds the lease
  ];
  const origin = await startRelay(t, { enclaves: `${oldUrl},${newUrl}`, ledger });

  // the signed-in list fans out to BOTH boxes and learns an owner from each
  // row it sees — this is what writes oldHost into the cache for ID66
  const list = await getJson(origin, "/v1/deployments", jwt(OWNER));
  assert.equal(list.status, 200);

  const att = await getJson(origin, `/v1/deployments/${ID66}/attestation`, jwt(OWNER));
  assert.equal(att.status, 200, "a control-plane call on a moved deployment must not 404 on its old host");
  assert.equal(att.body.who, "newhost", "the ledger's runner decides the route, not whatever was cached first");
});

// ---- a box-local miss must not unexist an on-chain record --------------------
// GET /v1/deployments/:id with a session used to STREAM the runner's answer
// through verbatim. A box that verifies the token but holds no local record
// (state wiped by a release restart, a claim not yet re-adopted) answers 404
// "No such deployment." — and the owner's sign-in page repeated it while the
// dashboard, which merges ledger rows, showed the same app running (found
// 2026-08-19, /authorize on a private app). A session minted by a DIFFERENT
// box reads as 401 here for the same non-reason. Both now fall back to the
// ledger row; a 200 is stamped with the box's fleet name, because /authorize
// signs in to dep.enclave and supervisors don't know their own registry name.
test("api-relay: a runner's 404/401 on a bare record read falls back to the ledger row", async (t) => {
  const ID66 = ID("66");
  let answer = "miss";                       // miss | badsession | hosted
  const box = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability")
      return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5, nodeVcpus: 8, nodeRamGb: 32 }));
    if (req.url.split("?")[0] === `/v1/deployments/${ID66}`) {
      if (answer === "miss")       { res.statusCode = 404; return res.end(JSON.stringify({ code: "not_found", message: "No such deployment." })); }
      if (answer === "badsession") { res.statusCode = 401; return res.end(JSON.stringify({ code: "unauthorized", message: "Missing or invalid session." })); }
      return res.end(JSON.stringify({ id: ID66, status: "running", public: false }));   // a supervisor row: no `enclave` field
    }
    if (req.url.split("?")[0] === "/v1/deployments")
      return res.end(JSON.stringify({ data: [], cursor: null }));
    res.statusCode = 404; res.end("{}");
  });
  box.listen(0, "127.0.0.1"); await once(box, "listening"); t.after(() => box.close());
  const boxUrl = `http://127.0.0.1:${box.address().port}`;

  const { keccak256, stringToBytes } = await import("viem");
  const ledger = [{ id: ID66, owner: OWNER, appRef: "ipfs://private", active: true, balance6: 2_000_000, spent6: 100_000,
                    runner: keccak256(stringToBytes(boxUrl)), leaseUntil: FUTURE }];
  const origin = await startRelay(t, { enclaves: boxUrl, ledger });

  // the runner box lost its record: the on-chain row answers, not the box's 404
  const missed = await getJson(origin, `/v1/deployments/${ID66}`, jwt(OWNER));
  assert.equal(missed.status, 200, "a box-local miss must not 404 an on-chain record");
  assert.equal(missed.body.ledger, true, "the ledger row answers in its place");
  assert.equal(missed.body.status, "running", "lease live + runner answering = running");
  assert.ok(missed.body.enclave, "the ledger row still names the serving box");

  // a session the box refuses (minted elsewhere) is a fact about the session,
  // not the deployment: same fallback
  answer = "badsession";
  const foreignSession = await getJson(origin, `/v1/deployments/${ID66}`, jwt(OWNER));
  assert.equal(foreignSession.status, 200, "another box's session must not 401 a public record read");
  assert.equal(foreignSession.body.ledger, true);

  // the box's own answer is preferred when it has one — stamped with the fleet
  // name its row lacks (only the LIST fan-out used to add it, and /authorize
  // needs it on this read too, or a running private app reads as down)
  answer = "hosted";
  const hosted = await getJson(origin, `/v1/deployments/${ID66}`, jwt(OWNER));
  assert.equal(hosted.status, 200);
  assert.equal(hosted.body.status, "running");
  assert.notEqual(hosted.body.ledger, true, "the box's live view answers when it has the record");
  assert.ok(hosted.body.enclave, "the relay stamps the serving box's name onto the box's own row");

  // and the two kinds of tokenless missing say different things: an existing
  // record outside the ?owner= scope is a wrong-wallet story, not a no-such-id one
  const foreign = await getJson(origin, `/v1/deployments/${ID66}?owner=${OTHER}`);
  assert.equal(foreign.status, 404);
  assert.match(foreign.body.message, /different wallet/i, "scoped-out records name the real reason");
  const unknown = await getJson(origin, `/v1/deployments/${ID("99")}?owner=${OTHER}`);
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.message, /no deployment under it/i);
});

// ---- one deployment, one row, even when two boxes claim it ------------------
// Releasing does not delete the ex-runner's local record, so after a Move both
// the new host and the old one answer for the same id. The list pushed both,
// and the stale terminated copy shadowed the live row: terminated reads as
// resumable, so the UI showed Resume; Resume then read the ledger, found it
// already active, skipped the setActive tx and returned having done nothing.
// The app was running the whole time (found 2026-07-28 on a deployment moved
// metal0 -> kryptos -> metal0). The ledger's runner breaks the tie.
test("api-relay: two enclaves claiming one deployment yield ONE row, the on-chain runner's", async (t) => {
  const ID66 = ID("66");
  const mk = (label, status) => http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability")
      return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5, nodeVcpus: 8, nodeRamGb: 32 }));
    if (req.url.split("?")[0] === "/v1/deployments")
      return res.end(JSON.stringify({ data: [{ id: ID66, status, enclave: label }], cursor: null }));
    res.statusCode = 404; res.end("{}");
  });
  // the OLD host answers first and says terminated; the real one says running
  const oldHost = mk("oldhost", "terminated"), newHost = mk("newhost", "running");
  for (const s of [oldHost, newHost]) { s.listen(0, "127.0.0.1"); await once(s, "listening"); t.after(() => s.close()); }
  const oldUrl = `http://127.0.0.1:${oldHost.address().port}`, newUrl = `http://127.0.0.1:${newHost.address().port}`;

  const { keccak256, stringToBytes } = await import("viem");
  const ledger = [{ id: ID66, owner: OWNER, appRef: "ipfs://moved", active: true, balance6: 2_000_000, spent6: 100_000,
                    runner: keccak256(stringToBytes(newUrl)), leaseUntil: FUTURE }];
  const origin = await startRelay(t, { enclaves: `${oldUrl},${newUrl}`, ledger });

  const { status, body } = await getJson(origin, "/v1/deployments", jwt(OWNER));
  assert.equal(status, 200);
  const rows = body.data.filter((r) => String(r.id).toLowerCase() === ID66.toLowerCase());
  assert.equal(rows.length, 1, "a deployment must appear once, however many boxes remember it");
  assert.equal(rows[0].status, "running", "the chain says newhost holds the lease, so its row is the real one");
  assert.equal(rows[0].enclave, "newhost");
});

// ---- the ex-runner is the ONLY box that answers ------------------------------
// The case deduping hosted rows does not reach. Sessions are per-enclave, so
// the fan-out's token is honoured by exactly one box; sign in on the deployment's
// PREVIOUS host and its terminated copy is the only hosted row there is. It then
// suppressed the ledger row (`seen`) and the deployment read TERMINATED, on a box
// that had released it, while the real host served it fine. Screenshotted
// 2026-07-28: "TERMINATED … on kryptos" for an app running on metal0.
test("api-relay: a stale row on an ex-runner never shadows the ledger's live one", async (t) => {
  const ID66 = ID("66");
  // the ONLY enclave that honours this token is the one that no longer hosts it
  const exRunner = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/availability")
      return res.end(JSON.stringify({ gpu: false, cpuShareFree: 0.5, nodeVcpus: 8, nodeRamGb: 32 }));
    if (req.url.split("?")[0] === "/v1/deployments")
      return res.end(JSON.stringify({ data: [{ id: ID66, status: "terminated", enclave: "exrunner" }], cursor: null }));
    res.statusCode = 404; res.end("{}");
  });
  exRunner.listen(0, "127.0.0.1"); await once(exRunner, "listening"); t.after(() => exRunner.close());
  const exUrl = `http://127.0.0.1:${exRunner.address().port}`;

  const { keccak256, stringToBytes } = await import("viem");
  // the chain says a DIFFERENT box holds the live lease
  const realRunner = keccak256(stringToBytes("https://elsewhere.invalid"));
  const ledger = [{ id: ID66, owner: OWNER, appRef: "ipfs://moved", active: true, balance6: 2_000_000, spent6: 100_000,
                    runner: realRunner, leaseUntil: FUTURE }];
  const origin = await startRelay(t, { enclaves: exUrl, ledger });

  const { status, body } = await getJson(origin, "/v1/deployments", jwt(OWNER));
  assert.equal(status, 200);
  const rows = body.data.filter((r) => String(r.id).toLowerCase() === ID66.toLowerCase());
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].status, "terminated",
    "a box the chain says is not the runner must not declare the deployment dead");
  assert.equal(rows[0].ledger, true, "the ledger row answers instead of the ex-runner's copy");
});

/* ---------- /v1/relays: the roster, and the choices made against it ----------
   One endpoint answers both halves of the same question, because they only mean
   anything together. The console asks "which relays can this deployment pick";
   DNS asks "what address does <label>.app.enclave.host answer with". A name the
   picker offers that the zone cannot resolve is a trap, so both are derived here
   from the same two facts: the relay's own /availability block, and the
   deployment's on-chain options envelope.

   Note the names. A fleet row is named by its endpoint's first hostname label,
   so every box in this file - reached over loopback - is called "127". That is
   not a quirk of the test: it is exactly the collision the roster has to handle,
   and the second case below leans on it deliberately. */
const relayBoxWith = (relay) => http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/availability") return res.end(JSON.stringify({
    gpu: false, type: "cpu", cpuShareFree: 0, gpuShareFree: 0, maxShare: 0,
    nodeVcpus: 0, nodeRamGb: 0, claimEnabled: false, relay }));
  res.statusCode = 404; res.end("{}");
});

test("api-relay: /v1/relays publishes the roster and resolves each deployment's choice to an address", async (t) => {
  const box = relayBoxWith({ sni: true, tcp: false, udp: false, egress: false, tunnelHub: false,
                             address: "198.51.100.9", region: "us-west", ports: "1-49999" });
  box.listen(0, "127.0.0.1"); await once(box, "listening");
  t.after(() => box.close());

  // "127" is what this box is called (loopback's first hostname label), so that
  // is the name a deployment has to write in its envelope to choose it.
  const ledger = [
    { id: ID("11"), owner: OWNER, appRef: "ipfs://a", active: true, balance6: 5_000_000,
      configCid: JSON.stringify({ network: { relay: "127" } }) },
    { id: ID("22"), owner: OWNER, appRef: "ipfs://b", active: true, balance6: 5_000_000,
      configCid: JSON.stringify({ waf: { rps: 10 }, network: { relay: "nowhere" } }) },   // names a relay the fleet doesn't have
    { id: ID("33"), owner: OWNER, appRef: "ipfs://c", active: true, balance6: 5_000_000 }, // no envelope at all
  ];
  const origin = await startRelay(t, { enclaves: `http://127.0.0.1:${box.address().port}`, ledger });

  const { status, body } = await getJson(origin, "/v1/relays");
  assert.equal(status, 200);
  assert.equal(body.relays.length, 1);
  const r = body.relays[0];
  assert.equal(r.name, "127");
  assert.equal(r.address, "198.51.100.9");
  assert.equal(r.region, "us-west");
  assert.equal(r.relayOnly, true, "a box with no resources only relays - the console badges it as one");
  assert.equal(r.services.sni, true);
  assert.equal(r.services.egress, false, "services it did not declare are false, never absent");

  // the choice, resolved: label -> the address the zone must answer with
  assert.deepEqual(body.labels["11111111"], { relay: "127", a: "198.51.100.9" });
  // a choice naming a relay the fleet no longer has is simply ABSENT: the zone
  // default carries that app, which keeps it reachable. A preference is a
  // preference; pointing a live app at a box that cannot serve it is not a
  // stricter reading of the owner's wishes, it is an outage.
  assert.equal(body.labels["22222222"], undefined);
  assert.equal(body.labels["33333333"], undefined, "no envelope, no override");
  assert.equal(Object.keys(body.labels).length, 1);
});

test("api-relay: two relays answering to one name are both dropped, and no deployment resolves to either", async (t) => {
  const a = relayBoxWith({ sni: true, address: "198.51.100.9",  region: "us-west" });
  const b = relayBoxWith({ sni: true, address: "198.51.100.10", region: "eu-north" });
  for (const s of [a, b]) { s.listen(0, "127.0.0.1"); await once(s, "listening"); }
  t.after(() => { a.close(); b.close(); });

  const ledger = [{ id: ID("11"), owner: OWNER, appRef: "ipfs://a", active: true, balance6: 5_000_000,
                    configCid: JSON.stringify({ network: { relay: "127" } }) }];
  const origin = await startRelay(t, { enclaves:
    `http://127.0.0.1:${a.address().port},http://127.0.0.1:${b.address().port}`, ledger });

  const { body } = await getJson(origin, "/v1/relays");
  // Zone 1 already NXDOMAINs an ambiguous id prefix rather than guessing, and
  // the same rule holds here: a name that could mean two boxes means neither.
  // Dropping both is also what makes the name safe to hand an owner - if a
  // colliding row could win, registering a box would be a way to hijack, or
  // simply to deny, a name someone else's app already points at.
  assert.deepEqual(body.relays, [], "an ambiguous name is no name");
  assert.deepEqual(body.labels, {}, "and the deployment that chose it falls back to the zone default");
});

test("api-relay: a relay that does not splice SNI is listed but cannot front an app subdomain", async (t) => {
  // egress + dedicated-IP TCP are real relay services; neither can answer an
  // app's name. Listing it and refusing to point a name at it is the honest
  // split - the box exists, it just isn't an answer to THIS question.
  const box = relayBoxWith({ sni: false, tcp: true, egress: true, address: "198.51.100.9",
                             v6Prefix: "2a01:4f9:c013:9b52::/64" });
  box.listen(0, "127.0.0.1"); await once(box, "listening");
  t.after(() => box.close());

  const ledger = [{ id: ID("11"), owner: OWNER, appRef: "ipfs://a", active: true, balance6: 5_000_000,
                    configCid: JSON.stringify({ network: { relay: "127" } }) }];
  const origin = await startRelay(t, { enclaves: `http://127.0.0.1:${box.address().port}`, ledger });

  const { body } = await getJson(origin, "/v1/relays");
  assert.equal(body.relays.length, 1, "still a fleet member worth seeing");
  assert.equal(body.relays[0].services.sni, false);
  assert.equal(body.relays[0].v6Prefix, "2a01:4f9:c013:9b52::/64");
  assert.deepEqual(body.labels, {}, "but nothing resolves to it, so no app is pointed at a black hole");
});

test("api-relay: a relay that stops answering leaves the roster, and its apps fall back to the default", async (t) => {
  // The asymmetry this encodes: forgetting a relay that is fine costs one DNS
  // TTL of traffic on the default relay - slower, never down. Remembering one
  // that is gone points every app that chose it at a black hole for as long as
  // the memory lasts. A latency feature must not be able to cause an outage.
  const box = relayBoxWith({ sni: true, address: "198.51.100.9", region: "us-west" });
  box.listen(0, "127.0.0.1"); await once(box, "listening");
  let closed = false;
  t.after(() => { if (!closed) box.close(); });

  const ledger = [{ id: ID("11"), owner: OWNER, appRef: "ipfs://a", active: true, balance6: 5_000_000,
                    configCid: JSON.stringify({ network: { relay: "127" } }) }];
  const origin = await startRelay(t, { enclaves: `http://127.0.0.1:${box.address().port}`,
                                       ledger, env: { AVAIL_POLL_SEC: "1" } });
  assert.equal((await getJson(origin, "/v1/relays")).body.labels["11111111"].a, "198.51.100.9");

  box.close(); closed = true;                      // the relay's box goes away
  for (let i = 0; i < 60; i++) {
    const { body } = await getJson(origin, "/v1/relays");
    if (!body.relays.length) {
      assert.deepEqual(body.labels, {}, "and nothing is still pointed at it");
      return;
    }
    await delay(100);
  }
  assert.fail("a relay that stopped answering never left the roster");
});

test("api-relay: two deployments sharing an app-zone label get no override, not one of them silently winning", async (t) => {
  // Ids sharing their first 8 hex chars share one name - there is no answer
  // that serves both. The name is already ambiguous with or without this
  // feature; what must not happen is one deployment quietly deciding where the
  // other's traffic goes.
  const box = relayBoxWith({ sni: true, address: "198.51.100.9" });
  box.listen(0, "127.0.0.1"); await once(box, "listening");
  t.after(() => box.close());

  const twinA = "0x" + "11".repeat(4) + "aa".repeat(28);
  const twinB = "0x" + "11".repeat(4) + "bb".repeat(28);
  const ledger = [
    { id: twinA, owner: OWNER, appRef: "ipfs://a", active: true, balance6: 5_000_000,
      configCid: JSON.stringify({ network: { relay: "127" } }) },
    { id: twinB, owner: OWNER, appRef: "ipfs://b", active: true, balance6: 5_000_000 },   // no choice at all
    { id: ID("77"), owner: OWNER, appRef: "ipfs://c", active: true, balance6: 5_000_000,
      configCid: JSON.stringify({ network: { relay: "127" } }) },
  ];
  const origin = await startRelay(t, { enclaves: `http://127.0.0.1:${box.address().port}`, ledger });

  const { body } = await getJson(origin, "/v1/relays");
  assert.equal(body.labels["11111111"], undefined, "the contested label gets no answer from either twin");
  assert.equal(body.labels["77777777"].a, "198.51.100.9", "an uncontested label is unaffected");
});
