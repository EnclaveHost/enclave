// (B) OWNER-ONLY serving on the NucBox's hv-node row (enclave-87, 2026-09-26), end to end on the REAL relay (api-relay.js).
// The row serves a deployment D only when, AT DECISION TIME: D's LEDGER OWNER is served now (the row's operator: the name's
// on-chain owner, who signed the v2 attach and is in RELAY_HVNODE_OPERATORS; or an owner whose hosting delegation to it has
// not expired), THIS row holds D's live lease, and D's envelope requires hyperv-partition-per-app (E4); and only on the raw
// splice of the app's own TLS (wss /t/<box>/x/<id>/https). Everything else stays refused. RELAY_HVNODE_OPERATORS grants
// nothing but that (not dialing, not operator attach, not the relay roster), and TRUSTED_OPERATORS ("*" included) never
// implies it.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, sign as edSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, stringToBytes, toFunctionSelector, encodeFunctionResult } from "viem";
import { bootDaemon, listenOnFreePort } from "./helpers/daemon.mjs";
import { haveOpenssl, tmpdir, makeVbsWorld, buildLog, buildQuote } from "./fixtures/vbs-synthetic.mjs";
import { activateCredential } from "../relay/vbs-credential.mjs";
import { HVNODE_FORMAT, hvNodeBinding } from "../relay/hvnode-verify.mjs";
import { delegationText, attachMessageV2 } from "../relay/host-delegation.mjs";
import { selfRoutedUrl } from "../relay/tunnel.js";
import { enclaveClassOf } from "../site/js/core/pricing.js";

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
// the public anvil development keys: #0 a delegating owner, #1 the box's operator, #2 a stranger
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OPERATOR = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const STRANGER = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const REG = "0x" + "34".repeat(20), LEDGER = "0x" + "56".repeat(20), NAME = "nucbox-k11";
const ENDPOINT = `https://api.enclave.host/t/${NAME}`, EP_ID = keccak256(stringToBytes(ENDPOINT)).toLowerCase();
const OTHER_EP = keccak256(stringToBytes("https://api.enclave.host/t/elsewhere")).toLowerCase();
const dep = (n) => "0x" + String(n).repeat(64).slice(0, 64);
// the ledger (all leased to the box unless said): the operator's own, a delegating owner's, a stranger's, the operator's own
// leased ELSEWHERE; and E4's: the delegating owner's SNP-required app, his app requiring nothing, the operator's SNP-required
const D_OWN = dep("a1"), D_DELEG = dep("b2"), D_STRANGER = dep("c3"), D_ELSEWHERE = dep("d4"), D_SNP = dep("e5"), D_NOREQ = dep("f6"), D_OP_SNP = dep("a7");
const HV_ENV = JSON.stringify({ isolation: { require: "hyperv-partition-per-app" } }), SNP_ENV = JSON.stringify({ isolation: { require: "snp-guest-per-app" } });
const DEP_TUPLE = [["id", "bytes32"], ["owner", "address"], ["appRef", "string"], ["ports", "string"], ["configCid", "string"], ["gpuMilli", "uint16"],
  ["cpuMilli", "uint16"], ["appPort", "uint32"], ["isPublic", "bool"], ["active", "bool"], ["createdAt", "uint64"], ["rate", "uint256"], ["balance6", "uint256"],
  ["spent6", "uint256"], ["runner", "bytes32"], ["runnerOperator", "address"], ["leaseUntil", "uint64"]].map(([name, type]) => ({ name, type }));
const PAGE = [{ type: "function", name: "getPage", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "tuple[]", components: DEP_TUPLE }] }];
const U256 = (fn) => [{ type: "function", name: fn, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
const REG_ENTRY = [["endpoint", "string"], ["repo", "string"], ["measurement", "bytes32"], ["operator", "address"], ["registeredAt", "uint64"], ["lastSeen", "uint64"], ["active", "bool"]].map(([name, type]) => ({ name, type }));
const REG_GET = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: REG_ENTRY }] }];
const lease = BigInt(Math.floor(Date.now() / 1000) + 3600);
const row = (id, owner, runner, configCid = HV_ENV) => ({ id, owner: owner.address, appRef: "catalog://0x" + "5a".repeat(32) + "/1", ports: "", configCid, gpuMilli: 0, cpuMilli: 100, appPort: 0,
  isPublic: true, active: true, createdAt: 1n, rate: 1n, balance6: 10n ** 6n, spent6: 0n, runner, runnerOperator: OPERATOR.address, leaseUntil: lease });
const BASE_ROWS = [row(D_OWN, OPERATOR, EP_ID), row(D_DELEG, OWNER, EP_ID), row(D_STRANGER, STRANGER, EP_ID), row(D_ELSEWHERE, OPERATOR, OTHER_EP),
                   row(D_SNP, OWNER, EP_ID, SNP_ENV), row(D_NOREQ, OWNER, EP_ID, ""), row(D_OP_SNP, OPERATOR, EP_ID, SNP_ENV)];
let ROWS = BASE_ROWS;   // a test may swap the ledger (a transfer) and restores it

function chainStub() {
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
async function startRelay(t, env) {
  const rpc = chainStub(); await listenOnFreePort(rpc);
  const { child, port } = await bootDaemon({
    start: (port) => spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], {
      env: { ...process.env, ENCLAVES: "http://127.0.0.1:1", API_RELAY_PORT: String(port), API_RELAY_BIND: "127.0.0.1", BASE_RPC: `http://127.0.0.1:${rpc.address().port}`,
             RPC_FALLBACKS: "0", REGISTRY_ADDRESS: REG, DEPLOYMENTS_ADDRESS: LEDGER, FEATURED_VIEWS_FILE: path.join(tmpdir("feat-"), "v.json"),
             AVAIL_POLL_SEC: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"] }),
    claimed: (log, port) => log.includes(`[api-relay] :${port}`),
    ready: async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).ok,
  });
  t.after(() => { child.kill("SIGKILL"); rpc.close(); });
  return `http://127.0.0.1:${port}`;
}
const waitFor = async (fn, ms = 20000) => { const until = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) return null; await new Promise((r) => setTimeout(r, 150)); } };
const STATEMENT = Buffer.from(JSON.stringify({ stated: true, backend: "custom-type1", tier: "t0-hv", hostExcluded: false, derivations: [] }));
// the node's own word: a GPU, capacity, a price, and a RELAY declaration (none of which the relay may act on for an hv-node)
const AVAILABILITY = { gpu: true, type: "cpu", teeCpu: "amd-sev-snp", cpuShareFree: 0.75, maxShare: 0.75, nodeVcpus: 16, nodeRamGb: 64, claimEnabled: true,
                       pricing: { gpuRate6: 1, cpuRate6: 1 }, relay: { address: "203.0.113.9", services: { https: true } } };

// the node: the hv-node handshake with an operator signature (v2 by default) and optional delegations; it answers
// /availability, and records every splice the hub opens to it (the replayed request line)
async function attachHv(origin, w, { sig = "v2", signer = OPERATOR, delegations = [], keepOpen = false } = {}) {
  const ws = new WebSocket(origin.replace(/^http/, "ws") + "/v1/fleet-tunnel", { headers: { "x-metal-name": NAME, "x-metal-attest": "1" } });
  const frames = [], splices = [];
  ws.on("message", (d) => {
    let f; try { f = JSON.parse(d); } catch { return; } frames.push(f);
    if (f.t === "req") ws.send(JSON.stringify({ t: "res", id: f.id, status: f.path.startsWith("/availability") ? 200 : 404, headers: { "content-type": "application/json" },
                                                body: Buffer.from(JSON.stringify(f.path.startsWith("/availability") ? AVAILABILITY : {})).toString("base64") }));
    if (f.t === "s+") ws.send(JSON.stringify({ t: "s=", sid: f.sid, ok: true }));
    if (f.t === "sd") { const l = Buffer.from(f.d, "base64").toString("latin1").split("\r\n")[0]; if (l.startsWith("GET ")) splices.push(l);
                        if (!keepOpen) ws.send(JSON.stringify({ t: "sx", sid: f.sid })); }
  });
  await new Promise((r) => { ws.on("open", r); ws.on("error", r); });
  const chal = await waitFor(() => frames.find((f) => f.t === "challenge"));
  const nonce = Buffer.from(chal.nonce, "base64");
  ws.send(JSON.stringify({ t: "vbs-keys", ek: w.ek.cert.toString("base64"), ekChain: [w.ca.inter.toString("base64")], aikPub: w.aik.tpmtPublic.toString("base64"), aikName: w.aik.name.toString("base64") }));
  const cred = await waitFor(() => frames.find((f) => f.t === "vbs-credential" || f.t === "attest-result"));
  if (!cred || cred.t !== "vbs-credential") return { ok: false, reason: cred?.reason, ws, chal };
  const credential = activateCredential(w.ek.privateKey, w.aik.name, Buffer.from(cred.credentialBlob, "base64"), Buffer.from(cred.secret, "base64"));
  const bound = hvNodeBinding(w.transport.spki, nonce, STATEMENT);
  const L = buildLog({ idksPub: w.idks.publicKey });
  const Q = buildQuote({ aikPriv: w.aik.privateKey, aikName: w.aik.name, pcrs: L.pcrs, pcr0: w.pcr0, extraData: createHash("sha256").update(bound).digest() });
  const body = { statement: STATEMENT.toString("base64"), signature: edSign(null, bound, w.transport.privateKey).toString("base64"), log: L.log.toString("base64"),
                 quote: { attest: Q.attest.toString("base64"), sig: Q.sig.toString("base64"), aikPub: w.aik.tpmtPublic.toString("base64") }, credential: credential.toString("base64"),
                 ek: { cert: w.ek.cert.toString("base64"), chain: [w.ca.inter.toString("base64")] }, pcr0: w.pcr0.toString("hex"), platform: {} };
  const keyFp = createHash("sha256").update(w.transport.spki).digest("hex"), ekSha = createHash("sha256").update(w.ek.cert).digest("hex");
  const msg = sig === "v2" ? attachMessageV2(NAME, chal.nonce, keyFp, ekSha) : `enclave-tunnel-attach:${NAME}:${chal.nonce}`;
  ws.send(JSON.stringify({ t: "attest", operatorSig: await signer.signMessage({ message: msg }),
                           rad: { format: HVNODE_FORMAT, transportKey: w.transport.spki.toString("base64"), body: Buffer.from(JSON.stringify(body)).toString("base64"), delegations } }));
  const res = await waitFor(() => frames.find((f) => f.t === "attest-result"));
  if (res?.ok) ws.send(JSON.stringify({ t: "hello", mode: "snp", publicUrl: ENDPOINT }));
  return { ok: !!res?.ok, reason: res?.reason, ws, splices, chal };
}
const delegation = async (o = {}) => {
  const message = delegationText({ owner: OWNER.address, operator: OPERATOR.address, box: NAME, chain: 8453, registry: REG, expires: Math.floor(Date.now() / 1000) + 90 * 86400, ...o });
  return { message, signature: await (o.signer || OWNER).signMessage({ message }) };
};
// RFC 6455's sample key ("the sample nonce"), computed so no key-shaped literal sits in the source
const WS_KEY = Buffer.from("the sample nonce").toString("base64");
// a raw upgrade through the relay: the status line it answers
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
// a HELD upgrade: stays open until the relay closes it (`closed` resolves then)
function holdUpgrade(origin, p) {
  const u = new URL(origin), s = net.connect(Number(u.port), u.hostname);
  const closed = new Promise((r) => { s.on("close", () => r(true)); s.on("error", () => r(true)); });
  s.write(`GET ${p} HTTP/1.1\r\nHost: api.enclave.host\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${WS_KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  return { closed, isOpen: () => !s.destroyed, end: () => s.destroy() };
}
const rowOf = async (origin) => { const j = await (await fetch(origin + "/enclaves")).json(); return (j.enclaves || []).find((e) => e.name === NAME) || null; };

const lc = (a) => a.address.toLowerCase();
const hvWorld = (t) => { const dir = tmpdir("hv-owner-"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = makeVbsWorld(dir); const roots = path.join(dir, "ek-roots.pem"); fs.writeFileSync(roots, w.ca.bundlePem); return { w, roots }; };

test("owner-only: served now + this row's lease + isolation.require hyperv-partition-per-app -> the app's own TLS splice; every other deployment and path refused; the row stays ineligible, unplaced, unpriced and off the relay roster",
     { skip: !haveOpenssl && "openssl not installed" }, async (t) => {
  const { w, roots } = hvWorld(t);
  // the operator is in RELAY_HVNODE_OPERATORS and NOT in TRUSTED_OPERATORS (the default list stays)
  const origin = await startRelay(t, { RELAY_HVNODE_ATTACH: "1", RELAY_HVNODE_EK_ROOTS: roots, RELAY_HVNODE_OPERATORS: lc(OPERATOR), TUNNEL_OPERATOR_ATTACH: "1" });
  const exp = Math.floor(Date.now() / 1000) + 90 * 86400;
  const good = await delegation({ expires: exp }), otherBox = await delegation({ box: "other-box" }), byStranger = await delegation({ signer: STRANGER });
  const a = await attachHv(origin, w, { delegations: [good, otherBox, byStranger] });
  t.after(() => { try { a.ws.close(); } catch {} });
  assert.equal(a.ok, true, a.reason);
  assert.deepEqual(a.chal.sigVersions, [1, 2], "the challenge offers the v2 operator signature");
  const r = await waitFor(async () => { const x = await rowOf(origin); return x && x.availability && x.id === EP_ID && Array.isArray(x.servesDeployments) && x.servesDeployments.length ? x : null; });
  assert.ok(r, "the owner-only row is listed with its stamped id and the deployments it carries");
  assert.equal(r.mode, "hv-node"); assert.equal(r.eligible, false); assert.equal(r.serving, false); assert.equal(r.ownerOnly, true);
  assert.equal(r.operator, lc(OPERATOR));
  assert.deepEqual(r.served, [{ owner: lc(OPERATOR), expires: null }, { owner: lc(OWNER), expires: exp }], "operator (no expiry) + the ONE valid delegation, with its expiry");
  assert.deepEqual(r.servesDeployments, [{ id: D_OWN, until: Number(lease) }, { id: D_DELEG, until: Math.min(Number(lease), exp) }],
    "only served owners' deployments leased to THIS row AND requiring hyperv-partition-per-app (E4)");
  assert.match(r.ineligible, /serves only deployments that require hyperv-partition-per-app/);
  // (b) never eligible, never placed, never priced, never a TEE
  const all = await (await fetch(origin + "/enclaves")).json();
  assert.equal(all.aggregate.serving, 0, "no serving row"); assert.equal(all.aggregate.totalCpuShareFree, 0, "its capacity is never counted");
  assert.equal((await fetch(origin + "/route?gpuShare=0&cpuShare=0.1")).status, 503, "placement never picks it");
  assert.equal(enclaveClassOf(r).inTee, false, "a card on an hv-node host is never a TEE GPU, whatever it says (gpu:true here)");
  // (a) its relay declaration never reaches the roster (so neither the labels nor DNS)
  const relays = await (await fetch(origin + "/v1/relays")).json();
  assert.ok(!(relays.relays || []).some((x) => x.name === NAME || x.address === "203.0.113.9"), "never a relay");
  // (c) the ONE path, for a deployment served now
  for (const d of [D_OWN, D_DELEG]) assert.doesNotMatch(await upgrade(origin, `/t/${NAME}/x/${d}/https`), /503/, d.slice(0, 10));
  const seen = await waitFor(() => (a.splices.length >= 2 ? a.splices : null));
  assert.deepEqual([...seen].sort(), [`GET /x/${D_DELEG}/https HTTP/1.1`, `GET /x/${D_OWN}/https HTTP/1.1`].sort(), "the node received exactly those two splices");
  assert.doesNotMatch(await upgrade(origin, `/t/${NAME}/x/${D_OWN.slice(0, 10)}/https`), /503/, "an 8-hex prefix (what the SNI relay dials)");
  const before = a.splices.length;
  for (const [label, p] of [["a stranger's deployment on this row", `/t/${NAME}/x/${D_STRANGER}/https`],
                            ["the operator's own, leased ELSEWHERE", `/t/${NAME}/x/${D_ELSEWHERE}/https`],
                            ["E4: the delegating owner's SNP-required app (a VALID delegation)", `/t/${NAME}/x/${D_SNP}/https`],
                            ["E4: the delegating owner's app requiring nothing", `/t/${NAME}/x/${D_NOREQ}/https`],
                            ["E4: the operator's own SNP-required app", `/t/${NAME}/x/${D_OP_SNP}/https`],
                            ["a query-string variant", `/t/${NAME}/x/${D_OWN}/https?x=1`],
                            ["an encoded variant", `/t/${NAME}/x/${D_OWN}/%68ttps`],
                            ["a tls port path", `/t/${NAME}/x/${D_OWN}/tls/5432`],
                            ["the control plane", `/t/${NAME}/v1/deployments/${D_OWN}`]]) {
    assert.match(await upgrade(origin, p), /503/, label);
  }
  for (const d of [D_OWN, D_STRANGER, D_SNP]) {
    assert.equal((await fetch(`${origin}/t/${NAME}/x/${d}/`)).status, 503, `plain HTTP ${d.slice(0, 10)}`);
    assert.equal((await fetch(`${origin}/t/${NAME}/v1/deployments/${d}/restart`, { method: "POST" })).status, 503, `restart ${d.slice(0, 10)}`);
  }
  assert.equal((await fetch(`${origin}/x/${D_OWN}/`)).status, 503, "the api relay's own /x route stays eligible-only");
  assert.equal(a.splices.length, before, "no refused path reached the node");
});

test("owner-only needs a v2 signature by an operator in RELAY_HVNODE_OPERATORS; TRUSTED_OPERATORS (\"*\" included) never implies it, nor does \"*\" in it: HOST-ONLY",
     { skip: !haveOpenssl && "openssl not installed" }, async (t) => {
  for (const [label, env, opts] of [["v1 signature", { RELAY_HVNODE_OPERATORS: lc(OPERATOR) }, { sig: "v1" }],
                                    ["operator in TRUSTED_OPERATORS only", { TRUSTED_OPERATORS: lc(OPERATOR) }, {}],
                                    ["TRUSTED_OPERATORS=*", { TRUSTED_OPERATORS: "*" }, {}],
                                    ["RELAY_HVNODE_OPERATORS=*", { RELAY_HVNODE_OPERATORS: "*" }, {}],
                                    ["another operator listed", { RELAY_HVNODE_OPERATORS: lc(STRANGER) }, {}]]) {
    const { w, roots } = hvWorld(t);
    const origin = await startRelay(t, { RELAY_HVNODE_ATTACH: "1", RELAY_HVNODE_EK_ROOTS: roots, ...env });
    const a = await attachHv(origin, w, { ...opts, delegations: [await delegation()] });
    t.after(() => { try { a.ws.close(); } catch {} });
    assert.equal(a.ok, true, `${label}: ${a.reason}`);
    const r = await waitFor(async () => { const x = await rowOf(origin); return x && x.availability ? x : null; });
    assert.ok(r, label); assert.equal(r.ownerOnly, undefined, label); assert.equal(r.served, undefined, label); assert.equal(r.servesDeployments, undefined, label);
    assert.match(await upgrade(origin, `/t/${NAME}/x/${D_OWN}/https`), /503/, `${label}: the owner's own is NOT spliced`);
    assert.equal(a.splices.length, 0, label);
  }
});

test("RELAY_HVNODE_OPERATORS never implies TRUSTED_OPERATORS: its operator's OPERATOR-path attach is refused", async (t) => {
  const origin = await startRelay(t, { RELAY_HVNODE_OPERATORS: lc(OPERATOR), TUNNEL_OPERATOR_ATTACH: "1" });
  const ws = new WebSocket(origin.replace(/^http/, "ws") + "/v1/fleet-tunnel", { headers: { "x-metal-name": NAME, "x-metal-attach": "operator" } });
  const frames = []; ws.on("message", (d) => { try { frames.push(JSON.parse(d)); } catch {} });
  await new Promise((r) => { ws.on("open", r); ws.on("error", r); });
  const chal = await waitFor(() => frames.find((f) => f.t === "challenge"));
  assert.ok(chal, "the operator path challenges");
  ws.send(JSON.stringify({ t: "attach", operatorSig: await OPERATOR.signMessage({ message: `enclave-tunnel-attach:${NAME}:${chal.nonce}` }) }));
  const res = await waitFor(() => frames.find((f) => f.t === "attest-result"));
  try { ws.close(); } catch {}
  assert.equal(res && res.ok, false); assert.match(String(res && res.reason), /not a trusted operator of this relay/);
});

test("E2: a delegation that lapses while the tunnel stays attached stops serving AT DECISION TIME (no re-attach, before the minute re-check), and its held splice closes",
     { skip: !haveOpenssl && "openssl not installed" }, async (t) => {
  const { w, roots } = hvWorld(t);
  const origin = await startRelay(t, { RELAY_HVNODE_ATTACH: "1", RELAY_HVNODE_EK_ROOTS: roots, RELAY_HVNODE_OPERATORS: lc(OPERATOR) });
  const exp = Math.floor(Date.now() / 1000) + 14;
  const a = await attachHv(origin, w, { delegations: [await delegation({ expires: exp })], keepOpen: true });
  t.after(() => { try { a.ws.close(); } catch {} });
  assert.equal(a.ok, true, a.reason);
  assert.ok(await waitFor(async () => { const x = await rowOf(origin); return x && (x.servesDeployments || []).some((d) => d.id === D_DELEG) ? x : null; }), "served before expiry");
  const held = holdUpgrade(origin, `/t/${NAME}/x/${D_DELEG}/https`), heldOwn = holdUpgrade(origin, `/t/${NAME}/x/${D_OWN}/https`);
  t.after(() => { held.end(); heldOwn.end(); });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(held.isOpen(), true, "the delegated owner's splice is up");
  const wait = exp * 1000 - Date.now() + 1500;
  assert.ok(wait < 55_000, "the lapse is checked well before the hub's 60 s re-check");
  await new Promise((r) => setTimeout(r, Math.max(0, wait)));
  assert.match(await upgrade(origin, `/t/${NAME}/x/${D_DELEG}/https`), /503/, "a new splice is refused at once");
  const x = await rowOf(origin);
  assert.ok(!(x.servesDeployments || []).some((d) => d.id === D_DELEG), "the SNI daemons' list drops it");
  assert.ok((x.servesDeployments || []).some((d) => d.id === D_OWN), "the operator's own is unaffected");
  assert.equal(await Promise.race([held.closed, new Promise((r) => setTimeout(() => r(false), 5000))]), true, "the held splice was closed by the sweep");
  assert.equal(heldOwn.isOpen(), true, "the operator's own held splice stays");
});

test("a TRANSFER closes the held splice and refuses new ones (the ledger owner is no longer served)", { skip: !haveOpenssl && "openssl not installed" }, async (t) => {
  const { w, roots } = hvWorld(t);
  const origin = await startRelay(t, { RELAY_HVNODE_ATTACH: "1", RELAY_HVNODE_EK_ROOTS: roots, RELAY_HVNODE_OPERATORS: lc(OPERATOR) });
  const a = await attachHv(origin, w, { keepOpen: true });
  t.after(() => { try { a.ws.close(); } catch {} ROWS = BASE_ROWS; });
  assert.equal(a.ok, true, a.reason);
  assert.ok(await waitFor(async () => { const x = await rowOf(origin); return x && (x.servesDeployments || []).some((d) => d.id === D_OWN) ? x : null; }));
  const held = holdUpgrade(origin, `/t/${NAME}/x/${D_OWN}/https`); t.after(() => held.end());
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(held.isOpen(), true);
  ROWS = BASE_ROWS.map((d) => (d.id === D_OWN ? { ...d, owner: STRANGER.address } : d));   // D_OWN transferred to a stranger
  assert.equal(await Promise.race([held.closed, new Promise((r) => setTimeout(() => r(false), 20_000))]), true, "closed within the ledger TTL + a sweep");
  assert.match(await upgrade(origin, `/t/${NAME}/x/${D_OWN}/https`), /503/);
});

test("secrets: /v1/secrets/exists is exactly { id, exists } for a served lease holder's deployment and a stranger's alike; /v1/secrets/fetch stays 403 host_ineligible for an hv-node row",
     { skip: !haveOpenssl && "openssl not installed" }, async (t) => {
  const { w, roots } = hvWorld(t);
  const data = tmpdir("hv-secrets-"); t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const origin = await startRelay(t, { RELAY_HVNODE_ATTACH: "1", RELAY_HVNODE_EK_ROOTS: roots, RELAY_HVNODE_OPERATORS: lc(OPERATOR),
                                       SECRETS_KEY: "5e".repeat(32), AUTH_DATA_DIR: data });
  const a = await attachHv(origin, w);
  t.after(() => { try { a.ws.close(); } catch {} });
  assert.equal(a.ok, true, a.reason);
  assert.ok(await waitFor(async () => { const x = await rowOf(origin); return x && (x.servesDeployments || []).length ? x : null; }));
  // the owner stages one secret on D_OWN
  const expiry = Math.floor(Date.now() / 1000) + 120, payload = JSON.stringify({ set: { API_KEY: "s3cret" } });
  const put = await fetch(`${origin}/v1/secrets/${D_OWN}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, expiry, signature: await OPERATOR.signMessage({ message: `enclave-secrets:put:${D_OWN}:${expiry}:${createHash("sha256").update(payload).digest("hex")}` }) }) });
  assert.equal(put.status, 200, await put.text());
  for (const [d, want] of [[D_OWN, true], [D_STRANGER, false]]) {
    const r = await fetch(`${origin}/v1/secrets/exists`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: d }) });
    assert.equal(r.status, 200); const text = await r.text(), j = JSON.parse(text);
    assert.deepEqual(Object.keys(j).sort(), ["exists", "id"], "one boolean: no names, no values, no counts");
    assert.equal(j.exists, want); assert.doesNotMatch(text, /API_KEY|s3cret/);
  }
  const ts = Math.floor(Date.now() / 1000);
  const f = await fetch(`${origin}/v1/secrets/fetch`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: D_OWN, endpoint: ENDPOINT, ts, sig: "00".repeat(32), opSig: await OPERATOR.signMessage({ message: `enclave-secrets-fetch:${D_OWN}:${ENDPOINT}:${ts}` }) }) });
  const fb = await f.json();
  assert.equal(f.status, 403, JSON.stringify(fb)); assert.equal(fb.error, "host_ineligible", "the lease holder, served, and still never handed the secrets");
});

test("a registered name's attach signed by anyone but its owner is refused outright (v1 or v2)", { skip: !haveOpenssl && "openssl not installed" }, async (t) => {
  const dir = tmpdir("hv-owner-"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = makeVbsWorld(dir); const roots = path.join(dir, "ek-roots.pem"); fs.writeFileSync(roots, w.ca.bundlePem);
  const origin = await startRelay(t, { RELAY_HVNODE_ATTACH: "1", RELAY_HVNODE_EK_ROOTS: roots, TRUSTED_OPERATORS: OPERATOR.address.toLowerCase() });
  const a = await attachHv(origin, w, { signer: STRANGER });
  try { a.ws.close(); } catch {}
  assert.equal(a.ok, false); assert.match(String(a.reason), /registered on chain to/);
});

test("selfRoutedUrl form 2 names THIS relay's origin only (enclave-bf): another host's /t/<name> is never a row's publicUrl", () => {
  assert.equal(selfRoutedUrl("https://api.enclave.host/t/nucbox-k11", "nucbox-k11", "https://api.enclave.host"), "https://api.enclave.host/t/nucbox-k11");
  assert.equal(selfRoutedUrl("https://evil.example/t/nucbox-k11", "nucbox-k11", "https://api.enclave.host"), "");
  assert.equal(selfRoutedUrl("https://api.enclave.host/t/other", "nucbox-k11", "https://api.enclave.host"), "");
  assert.equal(selfRoutedUrl("https://api.enclave.host/t/nucbox-k11", "nucbox-k11", ""), "", "no origin given: form 2 refused");
});

test("the site never badges a TEE GPU on a tunnel row the relay did not verify as SEV-SNP", () => {
  assert.equal(enclaveClassOf({ tunnel: true, mode: "hv-node", availability: { gpu: true } }).kind, "cpu");
  assert.equal(enclaveClassOf({ tunnel: true, mode: "", availability: { gpu: true } }).inTee, false);
  assert.equal(enclaveClassOf({ tunnel: true, mode: "snp", availability: { gpu: true } }).kind, "tee-gpu");
  assert.equal(enclaveClassOf({ availability: { gpu: true } }).kind, "tee-gpu", "a dialed row is unchanged");
});
