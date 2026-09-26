// (B) the SNI data plane's side of OWNER-ONLY serving (relay/fleet.mjs, consumed by relay.js's splice and dns-relay.js's
// dns-01 gate): the daemon takes the api relay's /enclaves verdict AS GIVEN (servesDeployments: [{ id, until }] on an
// ownerOnly hv-node row) and checks each entry's `until` AT DECISION TIME, so a delegation that lapses (or a lease that
// ends) between two polls refuses at once, and a held session closes at the next sweep (enclave-bf E2, enclave-87).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { fleetConfig, createFleet } from "../relay/fleet.mjs";
import { keccak256, stringToBytes, toFunctionSelector, encodeFunctionResult } from "viem";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const HV = "https://api.enclave.host/t/nucbox-k11", SNP = "https://api.enclave.host/t/metal-iso0";
const idOf = (o) => keccak256(stringToBytes(o)).toLowerCase();
const dep = (c) => "0x" + c.repeat(64);
const D1 = dep("a"), D2 = dep("b"), D3 = dep("c"), D4 = "0xabcdef01" + "1".repeat(56), D5 = "0xabcdef01" + "2".repeat(56);

async function enclavesApi(rows) {
  const srv = http.createServer((req, res) => {
    if (req.url !== "/enclaves") { res.statusCode = 404; return res.end("{}"); }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ enclaves: rows() }));
  });
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

test("owner-only fleet: only the deployments an ownerOnly hv-node row is listed as carrying, each until its `until`; anything else about a row is ignored", async () => {
  const now = () => Math.floor(Date.now() / 1000);
  let served = [{ id: D1, until: now() + 3600 }, { id: D2, until: now() + 2 }, { id: D4, until: now() + 3600 }, { id: D5, until: now() + 3600 }];
  const rows = () => [
    { endpoint: HV, id: idOf(HV), mode: "hv-node", eligible: false, ownerOnly: true, servesDeployments: served },
    // a row that is NOT hv-node, or not ownerOnly, or eligible, never contributes a served list, whatever it carries
    { endpoint: "https://x.test", id: idOf("https://x.test"), mode: "", eligible: false, ownerOnly: true, servesDeployments: [{ id: D3, until: now() + 3600 }] },
    { endpoint: "https://y.test", id: idOf("https://y.test"), mode: "hv-node", eligible: false, servesDeployments: [{ id: D3, until: now() + 3600 }] },
    { endpoint: SNP, id: idOf(SNP), mode: "snp", eligible: true },
  ];
  const api = await enclavesApi(rows);
  const fleet = createFleet(fleetConfig({ ENCLAVES: `${HV},${SNP}`, ELIGIBILITY_API: api.url, ELIGIBILITY_POLL_SEC: "1", ELIGIBILITY_MAX_AGE_SEC: "5" }));
  await fleet.start(); await fleet.startEligibility();
  try {
    assert.equal(await fleet.servesDeployment(HV, D1), true, "a listed deployment");
    assert.equal(fleet.servesDeploymentId(idOf(HV), D1), true, "the dns-01 gate's form (runner id, deployment id)");
    assert.equal(await fleet.servesDeployment(HV, D3), false, "not listed for this row");
    assert.equal(await fleet.servesDeployment("https://x.test", D3), false, "an ownerOnly row that is not hv-node: nothing");
    assert.equal(await fleet.servesDeployment("https://y.test", D3), false, "an hv-node row that is not ownerOnly: nothing");
    assert.equal(fleet.servesDeploymentId(idOf("https://y.test"), D3), false);
    assert.equal(await fleet.servesDeployment(HV, D1.slice(0, 10)), true, "an id prefix naming exactly one listed deployment");
    assert.equal(await fleet.servesDeployment(HV, "0xabcdef01"), false, "a prefix naming two is no one");
    assert.equal(await fleet.eligibleOrigin(HV), false, "served is never eligible");
    assert.equal(fleet.eligibleId(idOf(HV)), false);
    assert.equal(await fleet.servesDeployment(SNP, D3), true, "an ELIGIBLE host: any deployment, as before");
    // decision time: D2's `until` passes with NO new verdict in between (the api stays unreachable for the check)
    const closed = [];
    fleet.holdWhileServes(HV, D2, () => closed.push("d2"));
    fleet.holdWhileServes(HV, D1, () => closed.push("d1"));
    assert.equal(await fleet.servesDeployment(HV, D2), true);
    await delay(2600);
    assert.equal(await fleet.servesDeployment(HV, D2), false, "past its until: refused at decision time");
    assert.equal(fleet.servesDeploymentId(idOf(HV), D2), false, "and at the dns-01 gate");
    assert.deepEqual(closed, ["d2"], "the held session closed at the sweep; D1's stays");
    // a transfer (the api relay stops listing D1): its held session closes at the next poll
    served = served.filter((x) => x.id !== D1);
    await delay(1600);
    assert.equal(await fleet.servesDeployment(HV, D1), false);
    assert.deepEqual(closed, ["d2", "d1"]);
    fleet.holdWhileServes(HV, D1, () => closed.push("d1-again"));
    assert.deepEqual(closed, ["d2", "d1", "d1-again"], "holding toward a deployment no longer served closes at once");
  } finally { fleet.stopEligibility(); api.close(); }
});

test("owner-only fleet: a malformed served list serves nothing (no until, a bad id, a non-array)", async () => {
  const rows = () => [{ endpoint: HV, id: idOf(HV), mode: "hv-node", eligible: false, ownerOnly: true,
                        servesDeployments: [D1, { id: D2 }, { id: "0xnothex", until: 9e9 }, { id: D3.toUpperCase().replace("0X", "0x"), until: 9e9 }] }];
  const api = await enclavesApi(rows);
  const fleet = createFleet(fleetConfig({ ENCLAVES: HV, ELIGIBILITY_API: api.url, ELIGIBILITY_POLL_SEC: "1" }));
  await fleet.start(); await fleet.startEligibility();
  try {
    for (const d of [D1, D2, D3]) assert.equal(await fleet.servesDeployment(HV, d), false, d.slice(0, 10));
  } finally { fleet.stopEligibility(); api.close(); }
});

// ---- e2e: relay.js (the SNI relay) splices an app-zone name to an owner-only host ONLY for a deployment it is listed as
// carrying; every other deployment leased to the same host is refused there, and never reaches it.
const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
function clientHello(sni) {
  const name = Buffer.from(sni, "ascii"), sniList = Buffer.concat([Buffer.from([0x00]), u16(name.length), name]);
  const sniExtBody = Buffer.concat([u16(sniList.length), sniList]), sniExt = Buffer.concat([u16(0x0000), u16(sniExtBody.length), sniExtBody]);
  const body = Buffer.concat([Buffer.from([0x01]), Buffer.from([0, 0, 0]), Buffer.from([0x03, 0x03]), Buffer.alloc(32), Buffer.from([0x00]),
                              u16(2), Buffer.from([0x00, 0x2f]), Buffer.from([0x01, 0x00]), u16(sniExt.length), sniExt]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(body.length), body]);
}
function sniExchange(port, sni, probe) {
  return new Promise((resolve) => {
    const c = net.connect(port, "127.0.0.1");
    c.on("connect", () => { c.write(clientHello(sni)); setTimeout(() => c.write(probe), 250); });
    c.on("data", (d) => { clearTimeout(t); c.destroy(); resolve(d.toString()); });
    c.on("error", () => { clearTimeout(t); resolve("(error)"); }); c.on("close", () => { clearTimeout(t); resolve("(closed)"); });
    const t = setTimeout(() => { c.destroy(); resolve("(no echo)"); }, 5000);
  });
}
const DEP_TUPLE = [["id", "bytes32"], ["owner", "address"], ["appRef", "string"], ["ports", "string"], ["configCid", "string"], ["gpuMilli", "uint16"],
  ["cpuMilli", "uint16"], ["appPort", "uint32"], ["isPublic", "bool"], ["active", "bool"], ["createdAt", "uint64"], ["rate", "uint256"], ["balance6", "uint256"],
  ["spent6", "uint256"], ["runner", "bytes32"], ["runnerOperator", "address"], ["leaseUntil", "uint64"]].map(([name, type]) => ({ name, type }));
const PAGE = [{ type: "function", name: "getPage", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "tuple[]", components: DEP_TUPLE }] }];
const U256 = (fn) => [{ type: "function", name: fn, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
function ledgerStub(address, rows) {
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const q = JSON.parse(b || "{}");
    const one = (m) => {
      let result = "0x" + "0".repeat(64);
      if (m.method === "eth_chainId") result = "0x2105";
      else if (m.method === "eth_call" && String(m.params[0].to || "").toLowerCase() === address) {
        const data = String(m.params[0].data || "");
        if (data.startsWith(toFunctionSelector("deploymentsSchema()"))) result = encodeFunctionResult({ abi: U256("deploymentsSchema"), functionName: "deploymentsSchema", result: 2n });
        else if (data.startsWith(toFunctionSelector("count()"))) result = encodeFunctionResult({ abi: U256("count"), functionName: "count", result: BigInt(rows.length) });
        else if (data.startsWith(toFunctionSelector("getPage(uint256,uint256)"))) result = encodeFunctionResult({ abi: PAGE, functionName: "getPage", result: rows });
      }
      return { jsonrpc: "2.0", id: m.id, result };
    };
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
  }); });
  srv.listen(0, "127.0.0.1"); return once(srv, "listening").then(() => ({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }));
}

test("owner-only SNI e2e: relay.js splices <label>.<app zone> to an owner-only host only for a deployment the api relay lists it as carrying", async (t) => {
  const reached = [];
  const enc = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  enc.on("upgrade", (req, sock, head) => {
    reached.push(req.url);
    wss.handleUpgrade(req, sock, head, (ws) => { let first = true; ws.on("message", (d) => { if (first) { first = false; return; } ws.send(Buffer.concat([Buffer.from("HV:"), d])); }); });
  });
  enc.listen(0, "127.0.0.1"); await once(enc, "listening");
  const O = `http://127.0.0.1:${enc.address().port}`, RUN = idOf(O);
  const P1 = "0xa1a1a1a1" + "1".repeat(56), P2 = "0xb2b2b2b2" + "2".repeat(56);    // both leased to O; only P1 listed as served
  const lease = BigInt(Math.floor(Date.now() / 1000) + 3600), zero = "0x" + "00".repeat(20);
  const row = (id) => ({ id, owner: zero, appRef: "", ports: "", configCid: "", gpuMilli: 0, cpuMilli: 1, appPort: 0, isPublic: true, active: true, createdAt: 1n,
                         rate: 1n, balance6: 1n, spent6: 0n, runner: RUN, runnerOperator: zero, leaseUntil: lease });
  const LEDGER = "0x" + "56".repeat(20);
  const chain = await ledgerStub(LEDGER, [row(P1), row(P2)]);
  const api = await enclavesApi(() => [{ endpoint: O, id: RUN, mode: "hv-node", eligible: false, ownerOnly: true,
                                         servesDeployments: [{ id: P1, until: Math.floor(Date.now() / 1000) + 3600 }] }]);
  const pub = await new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const env = { ...process.env, APP_DOMAIN: "app.test", RELAY_PORTS: `${pub}:443`, RELAY_BIND: "127.0.0.1", NET_POLL_SEC: "1", ENCLAVES: O,
                ELIGIBILITY_API: api.url, ELIGIBILITY_POLL_SEC: "1", DEPLOYMENTS_ADDRESS: LEDGER, BASE_RPC: chain.url, RPC_FALLBACKS: "0" };
  delete env.REGISTRY_ADDRESS;
  const p = spawn(process.execPath, [path.join(RELAY_DIR, "relay.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = []; p.stdout.on("data", (d) => logs.push(String(d))); p.stderr.on("data", (d) => logs.push(String(d)));
  t.after(() => { p.kill(); enc.close(); chain.close(); api.close(); });
  for (let i = 0; i < 40 && !logs.join("").includes("listening on"); i++) await delay(250);
  await delay(1500);                                                   // one eligibility poll
  assert.equal(await sniExchange(pub, "a1a1a1a1.app.test", "ping"), "HV:ping", `the listed deployment is spliced (logs: ${logs.join("").slice(-800)})`);
  assert.deepEqual(reached, ["/x/0xa1a1a1a1/https"], "on its own https path");
  assert.notEqual(await sniExchange(pub, "b2b2b2b2.app.test", "ping"), "HV:ping", "a deployment leased to the same host but NOT listed is refused");
  assert.deepEqual(reached, ["/x/0xa1a1a1a1/https"], "and never reaches the host");
  assert.match(logs.join(""), /REFUSED: not an eligible host \(U7\) and not an owner-only host of this deployment/);
});
