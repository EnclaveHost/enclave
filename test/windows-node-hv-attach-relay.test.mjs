// The node's OWN attach code against the REAL relay in this tree (enclave-87: B serves owner-only only on a v2 operator
// signature, and a node must still attach to a relay that offers no v2). The operator signature and the delegations come
// from hvnode-attach.mjs and Host.attachDelegations over real delegation files, exactly as agent.mjs builds them; the relay
// is relay/api-relay.js, spawned; the TPM is test/fixtures/vbs-synthetic.mjs. Only the evidence body is the fixture's -
// what this file holds to the relay is the part the node computes: which signature, over what, carrying which owners.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, sign as edSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, stringToBytes, toFunctionSelector, encodeFunctionResult } from "viem";
import { fakeBaseRpc } from "./helpers/fake-base-rpc.mjs";
import { bootDaemon, listenOnFreePort } from "./helpers/daemon.mjs";
import { haveOpenssl, tmpdir, makeVbsWorld, buildLog, buildQuote } from "./fixtures/vbs-synthetic.mjs";
import { activateCredential } from "../relay/vbs-credential.mjs";
import { HVNODE_FORMAT, hvNodeBinding } from "../relay/hvnode-verify.mjs";

const OPERATOR_KEY = "0x" + "5e".repeat(32);
process.env.NODE_OPERATOR_KEY = OPERATOR_KEY;
const rpc = await fakeBaseRpc();                        // the node's chain: never Base itself
const chain = await import("../windows/node/chain.mjs");
const REG = "0x" + "34".repeat(20), LEDGER = "0x" + "56".repeat(20);
chain.addresses.registry = REG;
chain.loadOperator();
const { Host } = await import("../windows/node/host.mjs");
const { finishHvAttach, relayTakesV2 } = await import("../windows/node/hvnode-attach.mjs");
const { delegationText } = await import("../windows/node/host-delegation.mjs");
after(() => rpc.close());

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const OPERATOR = privateKeyToAccount(OPERATOR_KEY), OWNER = privateKeyToAccount("0x" + "a7".repeat(32));
const lc = (a) => a.address.toLowerCase();
const NAME = "nucbox-k11", ENDPOINT = `https://api.enclave.host/t/${NAME}`, EP_ID = keccak256(stringToBytes(ENDPOINT)).toLowerCase();
const dep = (n) => "0x" + String(n).repeat(64).slice(0, 64);
const D_OWN = dep("a1"), D_DELEG = dep("b2");
const HV_ENV = JSON.stringify({ isolation: { require: "hyperv-partition-per-app" } });
const lease = BigInt(Math.floor(Date.now() / 1000) + 3600);
const row = (id, owner) => ({ id, owner: owner.address, appRef: "catalog://0x" + "5a".repeat(32) + "/1", ports: "", configCid: HV_ENV, gpuMilli: 0, cpuMilli: 100,
  appPort: 0, isPublic: true, active: true, createdAt: 1n, rate: 1n, balance6: 10n ** 6n, spent6: 0n, runner: EP_ID, runnerOperator: OPERATOR.address, leaseUntil: lease });
const ROWS = [row(D_OWN, OPERATOR), row(D_DELEG, OWNER)];
const DEP_TUPLE = [["id", "bytes32"], ["owner", "address"], ["appRef", "string"], ["ports", "string"], ["configCid", "string"], ["gpuMilli", "uint16"],
  ["cpuMilli", "uint16"], ["appPort", "uint32"], ["isPublic", "bool"], ["active", "bool"], ["createdAt", "uint64"], ["rate", "uint256"], ["balance6", "uint256"],
  ["spent6", "uint256"], ["runner", "bytes32"], ["runnerOperator", "address"], ["leaseUntil", "uint64"]].map(([name, type]) => ({ name, type }));
const PAGE = [{ type: "function", name: "getPage", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "tuple[]", components: DEP_TUPLE }] }];
const U256 = (fn) => [{ type: "function", name: fn, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
const REG_ENTRY = [["endpoint", "string"], ["repo", "string"], ["measurement", "bytes32"], ["operator", "address"], ["registeredAt", "uint64"], ["lastSeen", "uint64"], ["active", "bool"]].map(([name, type]) => ({ name, type }));
const REG_GET = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: REG_ENTRY }] }];

// the RELAY's chain: the box's name is registered to OPERATOR; the ledger leases both deployments to it
function relayChain() {
  return http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const q = JSON.parse(b || "{}");
    const one = (m) => {
      let result = "0x" + "0".repeat(64);
      if (m.method === "eth_chainId") result = "0x2105";
      else if (m.method === "eth_call") {
        const to = String(m.params[0].to || "").toLowerCase(), data = String(m.params[0].data || "");
        if (to === REG && data.startsWith(toFunctionSelector("get(bytes32)"))) {
          const id = ("0x" + data.slice(10, 74)).toLowerCase();
          result = encodeFunctionResult({ abi: REG_GET, functionName: "get", result: id === EP_ID
            ? { endpoint: ENDPOINT, repo: "EnclaveHost/enclave", measurement: "0x" + "00".repeat(32), operator: OPERATOR.address, registeredAt: 1n, lastSeen: 1n, active: true }
            : { endpoint: "", repo: "", measurement: "0x" + "00".repeat(32), operator: "0x" + "00".repeat(20), registeredAt: 0n, lastSeen: 0n, active: false } });
        } else if (to === LEDGER && data.startsWith(toFunctionSelector("deploymentsSchema()"))) result = encodeFunctionResult({ abi: U256("deploymentsSchema"), functionName: "deploymentsSchema", result: 2n });
        else if (to === LEDGER && data.startsWith(toFunctionSelector("count()"))) result = encodeFunctionResult({ abi: U256("count"), functionName: "count", result: BigInt(ROWS.length) });
        else if (to === LEDGER && data.startsWith(toFunctionSelector("getPage(uint256,uint256)"))) result = encodeFunctionResult({ abi: PAGE, functionName: "getPage", result: ROWS });
      }
      return { jsonrpc: "2.0", id: m.id, result };
    };
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
  }); });
}
async function startRelay(t, roots) {
  const chainSrv = relayChain(); await listenOnFreePort(chainSrv);
  const env = { ...process.env };
  delete env.BASE_RPCS; delete env.NODE_OPERATOR_KEY;    // the node's fake chain and key are not the relay's
  const { child, port } = await bootDaemon({
    start: (port) => spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], {
      env: { ...env, ENCLAVES: "http://127.0.0.1:1", API_RELAY_PORT: String(port), API_RELAY_BIND: "127.0.0.1", BASE_RPC: `http://127.0.0.1:${chainSrv.address().port}`,
             RPC_FALLBACKS: "0", REGISTRY_ADDRESS: REG, DEPLOYMENTS_ADDRESS: LEDGER, FEATURED_VIEWS_FILE: path.join(tmpdir("feat-"), "v.json"), AVAIL_POLL_SEC: "1",
             RELAY_HVNODE_ATTACH: "1", RELAY_HVNODE_EK_ROOTS: roots, RELAY_HVNODE_OPERATORS: lc(OPERATOR) },
      stdio: ["ignore", "pipe", "pipe"] }),
    claimed: (log, port) => log.includes(`[api-relay] :${port}`),
    ready: async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).ok,
  });
  t.after(() => { child.kill("SIGKILL"); chainSrv.close(); });
  return `http://127.0.0.1:${port}`;
}
const waitFor = async (fn, ms = 20000) => { const until = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) return null; await new Promise((r) => setTimeout(r, 150)); } };
const STATEMENT = Buffer.from(JSON.stringify({ stated: true, backend: "custom-type1", tier: "T0-hv", hostExcluded: false, derivations: [] }));
const AVAILABILITY = { gpu: false, type: "cpu", cpuShareFree: 0.75, maxShare: 0.75, nodeVcpus: 16, nodeRamGb: 64, claimEnabled: true, pricing: { cpuRate6: 1 } };

// a node Host serving OWNER through a real delegation file (what refreshOwners verifies and attachDelegations sends)
async function nodeHost(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ee-attach-relay-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = new Host({ dir, endpoint: ENDPOINT, name: NAME, appsEnabled: true, cpuPricePerSec6: 12, log: () => {}, engineRetired: true, isolationManager: "http://127.0.0.1:1" });
  const expires = Math.floor(Date.now() / 1000) + 90 * 86400;
  const message = delegationText({ owner: OWNER.address, operator: lc(OPERATOR), box: NAME, chain: 8453, registry: REG, expires });
  fs.mkdirSync(path.join(dir, "delegations"));
  fs.writeFileSync(path.join(dir, "delegations", "owner.json"), JSON.stringify({ message, signature: await OWNER.signMessage({ message }) }));
  await h.refreshOwners();
  assert.equal(h.attachDelegations().length, 1, "the node's own delegation file did not verify");
  return { h, expires };
}

// the hv-node handshake as agent.mjs runs it: the challenge decides v2 (relayTakesV2), the EK certificate is the one the
// vbs-keys frame sent, and finishHvAttach puts the operator signature and the delegations on the attest frame.
// `seeChallenge` lets a test present the node with an older relay's challenge.
async function attachNode(origin, w, host, { seeChallenge = (c) => c } = {}) {
  const ws = new WebSocket(origin.replace(/^http/, "ws") + "/v1/fleet-tunnel", { headers: { "x-metal-name": NAME, "x-metal-attest": "1" } });
  const frames = [];
  ws.on("message", (d) => {
    let f; try { f = JSON.parse(d); } catch { return; } frames.push(f);
    if (f.t === "req") ws.send(JSON.stringify({ t: "res", id: f.id, status: f.path.startsWith("/availability") ? 200 : 404, headers: { "content-type": "application/json" },
                                                body: Buffer.from(JSON.stringify(f.path.startsWith("/availability") ? AVAILABILITY : {})).toString("base64") }));
    if (f.t === "s+") ws.send(JSON.stringify({ t: "s=", sid: f.sid, ok: true }));
    if (f.t === "sd") ws.send(JSON.stringify({ t: "sx", sid: f.sid }));
  });
  await new Promise((r) => { ws.on("open", r); ws.on("error", r); });
  const chal = await waitFor(() => frames.find((f) => f.t === "challenge"));
  const seen = seeChallenge(chal);
  const kf = { t: "vbs-keys", ek: w.ek.cert.toString("base64"), ekChain: [w.ca.inter.toString("base64")], aikPub: w.aik.tpmtPublic.toString("base64"), aikName: w.aik.name.toString("base64") };
  const pending = { nonce: seen.nonce, v2: relayTakesV2(seen), ekCertDer: Buffer.from(kf.ek, "base64") };
  ws.send(JSON.stringify(kf));
  const cred = await waitFor(() => frames.find((f) => f.t === "vbs-credential" || f.t === "attest-result"));
  if (!cred || cred.t !== "vbs-credential") return { ok: false, reason: cred?.reason, ws, chal };
  const nonce = Buffer.from(pending.nonce, "base64");
  const credential = activateCredential(w.ek.privateKey, w.aik.name, Buffer.from(cred.credentialBlob, "base64"), Buffer.from(cred.secret, "base64"));
  const bound = hvNodeBinding(w.transport.spki, nonce, STATEMENT);
  const L = buildLog({ idksPub: w.idks.publicKey });
  const Q = buildQuote({ aikPriv: w.aik.privateKey, aikName: w.aik.name, pcrs: L.pcrs, pcr0: w.pcr0, extraData: createHash("sha256").update(bound).digest() });
  const body = { statement: STATEMENT.toString("base64"), signature: edSign(null, bound, w.transport.privateKey).toString("base64"), log: L.log.toString("base64"),
                 quote: { attest: Q.attest.toString("base64"), sig: Q.sig.toString("base64"), aikPub: w.aik.tpmtPublic.toString("base64") }, credential: credential.toString("base64"),
                 ek: { cert: w.ek.cert.toString("base64"), chain: [w.ca.inter.toString("base64")] }, pcr0: w.pcr0.toString("hex"), platform: {} };
  const frame = { t: "attest", rad: { format: HVNODE_FORMAT, transportKey: w.transport.spki.toString("base64"), body: Buffer.from(JSON.stringify(body)).toString("base64") } };
  const x = await finishHvAttach(frame, { name: NAME, nonceB64: pending.nonce, spki: w.transport.spki, ekCertDer: pending.ekCertDer, v2: pending.v2,
                                          sign: (message) => OPERATOR.signMessage({ message }), delegations: host.attachDelegations() });
  ws.send(JSON.stringify(frame));
  const res = await waitFor(() => frames.find((f) => f.t === "attest-result"));
  if (res?.ok) ws.send(JSON.stringify({ t: "hello", name: NAME, mode: "hv-node", publicUrl: ENDPOINT, transportKeyFp: createHash("sha256").update(w.transport.spki).digest("hex") }));
  return { ok: !!res?.ok, reason: res?.reason, ws, chal, x, frame };
}
const WS_KEY = Buffer.from("the sample nonce").toString("base64");
function upgrade(origin, p) {
  return new Promise((resolve) => {
    const u = new URL(origin), s = net.connect(Number(u.port), u.hostname);
    let got = "";
    s.on("data", (c) => { got += c.toString("latin1"); if (got.includes("\r\n")) { s.destroy(); resolve(got.split("\r\n")[0]); } });
    s.on("close", () => resolve(got.split("\r\n")[0] || "(closed)")); s.on("error", () => resolve("(error)"));
    s.write(`GET ${p} HTTP/1.1\r\nHost: api.enclave.host\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${WS_KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    setTimeout(() => { s.destroy(); resolve(got.split("\r\n")[0] || "(timeout)"); }, 8000);
  });
}
const rowOf = async (origin) => { const j = await (await fetch(origin + "/enclaves")).json(); return (j.enclaves || []).find((e) => e.name === NAME) || null; };
const hvWorld = (t) => { const dir = tmpdir("hv-attach-relay-"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = makeVbsWorld(dir); const roots = path.join(dir, "ek-roots.pem"); fs.writeFileSync(roots, w.ca.bundlePem); return { w, roots }; };

test("a relay that offers NO v2 (today's challenge: no sigVersions): the node signs v1, sends no delegations, and the relay attaches it HOST-ONLY",
     { skip: !haveOpenssl && "openssl not installed" }, async (t) => {
  const { w, roots } = hvWorld(t);
  const { h } = await nodeHost(t);
  const origin = await startRelay(t, roots);
  const a = await attachNode(origin, w, h, { seeChallenge: (c) => ({ t: c.t, nonce: c.nonce }) });
  t.after(() => { try { a.ws.close(); } catch {} });
  assert.equal(a.ok, true, `the relay refused the node's v1 attach: ${a.reason}`);
  assert.equal(a.x.version, 1);
  assert.equal("delegations" in a.frame.rad, false, "a v1 attach carried delegations");
  const r = await waitFor(async () => { const x = await rowOf(origin); return x && x.availability ? x : null; });
  assert.ok(r, "the host-only row is listed");
  assert.equal(r.ownerOnly, undefined); assert.equal(r.served, undefined);
  assert.match(await upgrade(origin, `/t/${NAME}/x/${D_OWN}/https`), /503/, "a host-only row spliced the operator's own deployment");
});

test("the challenge as THIS tree's relay sends it: a relay offering v2 (B) gets the node's v2 signature and its delegation, and serves the operator + the delegated owner; one offering none gets v1, host-only",
     { skip: !haveOpenssl && "openssl not installed" }, async (t) => {
  const { w, roots } = hvWorld(t);
  const { h, expires } = await nodeHost(t);
  const origin = await startRelay(t, roots);
  const a = await attachNode(origin, w, h);
  t.after(() => { try { a.ws.close(); } catch {} });
  assert.equal(a.ok, true, `the relay refused the node's attach: ${a.reason}`);
  if (!relayTakesV2(a.chal)) {
    t.diagnostic("this tree's relay offers no v2 (B is not in it): the v1 path ran");
    assert.equal(a.x.version, 1);
    assert.equal("delegations" in a.frame.rad, false);
    const r = await waitFor(async () => { const x = await rowOf(origin); return x && x.availability ? x : null; });
    assert.ok(r); assert.equal(r.ownerOnly, undefined);
    return;
  }
  t.diagnostic(`this tree's relay offers sigVersions ${JSON.stringify(a.chal.sigVersions)}: the v2 path ran`);
  assert.equal(a.x.version, 2);
  assert.equal(a.frame.rad.delegations.length, 1, "the node's delegation was not carried");
  const r = await waitFor(async () => { const x = await rowOf(origin); return x && x.availability && Array.isArray(x.servesDeployments) && x.servesDeployments.length ? x : null; });
  assert.ok(r, "the owner-only row never listed the deployments it carries");
  assert.equal(r.ownerOnly, true);
  assert.equal(r.operator, lc(OPERATOR));
  assert.deepEqual(r.served, [{ owner: lc(OPERATOR), expires: null }, { owner: lc(OWNER), expires }].sort((p, q) => (p.owner < q.owner ? -1 : 1)),
    "the relay's served owners are not the operator + the owner of the delegation the node sent");
  assert.deepEqual(r.servesDeployments.map((d) => d.id).sort(), [D_OWN, D_DELEG].sort());
  assert.doesNotMatch(await upgrade(origin, `/t/${NAME}/x/${D_DELEG}/https`), /503/, "the delegated owner's deployment was not spliced");
});
