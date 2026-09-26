// The consumer side of the NucBox node's attach, end to end through the REAL relay process (relay/api-relay.js):
// enclave-d1 asked (2026-09-25) that an admissible windows-hv-node/v1 verdict mean HOST ATTACH ONLY, never app capacity
// and never an isolation badge. Here a synthetic node (test/fixtures/vbs-synthetic.mjs: our own CA, EK, AK, IDKS) attaches
// over /v1/fleet-tunnel to a relay started with RELAY_HVNODE_ATTACH, and answers the relay's availability polls CLAIMING
// capacity and the retired VBS-enclave TEE. /enclaves must list it as mode hv-node, not serving, not eligible, with the
// host-attested-boot-state reason, with its capacity out of the aggregate, and the site's own rules must give it no TEE
// and no eligibility. A relay WITHOUT the switch refuses the node; the retired VBS-enclave format is refused by name.
//   run: node --test test/relay-hvnode-consumer.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, sign as edSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { bootDaemon, listenOnFreePort } from "./helpers/daemon.mjs";
import { haveOpenssl, tmpdir, makeVbsWorld, buildLog, buildQuote, evidenceFor as vbsEvidenceFor } from "./fixtures/vbs-synthetic.mjs";
import { activateCredential } from "../relay/vbs-credential.mjs";
import { HVNODE_FORMAT, hvNodeBinding } from "../relay/hvnode-verify.mjs";
import { VBS_FORMAT } from "../relay/vbs-verify.mjs";
import { teeCpuOf, computeEligibleOf } from "../site/js/core/pricing.js";

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
// a chain RPC that knows nothing: no registry, no deployments (the tunnel name is unregistered, so no operatorSig is due)
// (zeroWord: every call answers a zero word, so the ledger reads as EMPTY (count 0) and /v1/relays can answer)
const stubRpc = ({ zeroWord = false } = {}) => http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
  const q = JSON.parse(b || "{}"); const one = (m) => ({ jsonrpc: "2.0", id: m.id, result: m.method === "eth_chainId" ? "0x2105" : zeroWord ? "0x" + "0".repeat(64) : "0x" });
  res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q))); }); });
async function startRelay(t, env, { zeroWord = false } = {}) {
  const rpc = stubRpc({ zeroWord }); await listenOnFreePort(rpc);
  const { child, port } = await bootDaemon({
    start: (port) => spawn(process.execPath, [path.join(RELAY_DIR, "api-relay.js")], {
      env: { ...process.env, ENCLAVES: "http://127.0.0.1:1", API_RELAY_PORT: String(port), API_RELAY_BIND: "127.0.0.1", BASE_RPC: `http://127.0.0.1:${rpc.address().port}`, RPC_FALLBACKS: "0",
             DEPLOYMENTS_ADDRESS: "0x" + "12".repeat(20), FEATURED_VIEWS_FILE: path.join(tmpdir("feat-"), "v.json"), ...env },
      stdio: ["ignore", "pipe", "pipe"] }),
    claimed: (log, port) => log.includes(`[api-relay] :${port}`),
    ready: async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).ok,
  });
  t.after(() => { child.kill("SIGKILL"); rpc.close(); });
  return `http://127.0.0.1:${port}`;
}
const waitFor = async (fn, ms = 15000) => { const until = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) return null; await new Promise((r) => setTimeout(r, 100)); } };
const STATEMENT = Buffer.from(JSON.stringify({ stated: true, backend: "custom-type1", tier: "t0-hv", hostExcluded: false, derivations: [] }));
// the node's own availability: it CLAIMS capacity and the retired TEE; none of it may count
const AVAILABILITY = { gpu: false, type: "cpu", cpuShareFree: 0.75, maxShare: 0.75, nodeVcpus: 16, nodeRamGb: 64, claimEnabled: true, teeCpu: "windows-vbs-enclave", tier: "vbs" };

// a synthetic node: dial, challenge, vbs-keys, activate the credential (the TPM's job), attest; then answer req frames
async function attachNode(origin, w, name, { legacy = false, avail = AVAILABILITY } = {}) {
  const ws = new WebSocket(origin.replace(/^http/, "ws") + "/v1/fleet-tunnel", { headers: { "x-metal-name": name, "x-metal-attest": "1" } });
  const frames = [];
  ws.on("message", (d) => {
    let f; try { f = JSON.parse(d); } catch { return; } frames.push(f);
    if (f.t === "req") ws.send(JSON.stringify({ t: "res", id: f.id, status: f.path.startsWith("/availability") ? 200 : 404, headers: { "content-type": "application/json" },
                                                body: Buffer.from(JSON.stringify(f.path.startsWith("/availability") ? avail : {})).toString("base64") }));
  });
  const open = await new Promise((resolve) => { ws.on("open", () => resolve(true)); ws.on("unexpected-response", () => resolve(false)); ws.on("error", () => resolve(false)); });
  if (!open) return { ok: false, reason: "not opened" };
  const chal = await waitFor(() => frames.find((f) => f.t === "challenge"));
  const nonce = Buffer.from(chal.nonce, "base64");
  ws.send(JSON.stringify({ t: "vbs-keys", ek: w.ek.cert.toString("base64"), ekChain: [w.ca.inter.toString("base64")], aikPub: w.aik.tpmtPublic.toString("base64"), aikName: w.aik.name.toString("base64") }));
  const cred = await waitFor(() => frames.find((f) => f.t === "vbs-credential" || f.t === "attest-result"));
  if (!cred || cred.t !== "vbs-credential") return { ok: false, reason: cred?.reason || "(no credential)", ws, stage: "keys" };
  const credential = activateCredential(w.ek.privateKey, w.aik.name, Buffer.from(cred.credentialBlob, "base64"), Buffer.from(cred.secret, "base64"));
  let rad;
  if (legacy) {
    const ev = vbsEvidenceFor(w, { nonce, credential });
    rad = { format: VBS_FORMAT, body: Buffer.from(JSON.stringify(ev.body)).toString("base64"), transportKey: w.transport.spki.toString("base64"), padKey: w.padKey };
  } else {
    const bound = hvNodeBinding(w.transport.spki, nonce, STATEMENT);
    const L = buildLog({ idksPub: w.idks.publicKey });
    const Q = buildQuote({ aikPriv: w.aik.privateKey, aikName: w.aik.name, pcrs: L.pcrs, pcr0: w.pcr0, extraData: createHash("sha256").update(bound).digest() });
    const body = { statement: STATEMENT.toString("base64"), signature: edSign(null, bound, w.transport.privateKey).toString("base64"), log: L.log.toString("base64"),
                   quote: { attest: Q.attest.toString("base64"), sig: Q.sig.toString("base64"), aikPub: w.aik.tpmtPublic.toString("base64") }, credential: credential.toString("base64"),
                   ek: { cert: w.ek.cert.toString("base64"), chain: [w.ca.inter.toString("base64")] }, pcr0: w.pcr0.toString("hex"), platform: {} };
    rad = { format: HVNODE_FORMAT, transportKey: w.transport.spki.toString("base64"), body: Buffer.from(JSON.stringify(body)).toString("base64") };
  }
  ws.send(JSON.stringify({ t: "attest", rad }));
  const res = await waitFor(() => frames.find((f) => f.t === "attest-result"));
  if (res?.ok) ws.send(JSON.stringify({ t: "hello", mode: "snp", transportKeyFp: "" }));   // a node that tries to promote itself in its hello
  return { ok: !!res?.ok, reason: res?.reason, tier: res?.tier, hostExcluded: res?.hostExcluded, measurement: res?.measurement, ws, stage: "attest" };
}

test("relay end to end: an admissible hv-node attach is HOST ATTACH ONLY: listed as mode hv-node, never serving or eligible, its claimed capacity and TEE uncounted, no TEE or eligibility on the site's rules; without the switch the node is refused; the retired format is refused by name",
     { skip: !haveOpenssl && "openssl not installed" }, async (t) => {
  const dir = tmpdir("hvnode-relay-"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = makeVbsWorld(dir);
  const roots = path.join(dir, "ek-roots.pem"); fs.writeFileSync(roots, w.ca.bundlePem);
  const origin = await startRelay(t, { RELAY_HVNODE_ATTACH: "1", RELAY_HVNODE_EK_ROOTS: roots });
  const a = await attachNode(origin, w, "nucbox-k11");
  t.after(() => { try { a.ws.close(); } catch {} });
  assert.equal(a.ok, true, a.reason); assert.equal(a.tier, "hv-node"); assert.equal(a.hostExcluded, false); assert.equal(a.measurement, null);
  const row = await waitFor(async () => { const j = await (await fetch(origin + "/enclaves")).json(); const r = (j.enclaves || []).find((e) => e.name === "nucbox-k11"); return r && r.availability && r.availability.nodeVcpus ? { r, j } : null; });
  assert.ok(row, "the node is listed with its availability");
  const { r, j } = row;
  assert.equal(r.mode, "hv-node", "the hub's verdict, not the hello's 'snp'"); assert.equal(r.tier, "hv-node");
  assert.equal(r.serving, false); assert.equal(r.eligible, false);
  assert.match(String(r.ineligible), /host-attested boot state \(TPM quote: Secure Boot on, test signing off\); no isolation evidence, the host is not excluded/);
  assert.equal(r.hvNode.hostExcluded, false); assert.equal(r.hvNode.tee, null); assert.deepEqual(r.hvNode.omissions, ["platform-firmware-unpinned"]);
  assert.equal(r.measurement, undefined); assert.equal(r.attestedKeys, undefined);
  assert.equal(j.aggregate.totalCpuShareFree ?? 0, 0, "its claimed CPU share is not buyable capacity");
  // the site's own rules on the relay's row
  const tee = teeCpuOf(r); assert.equal(tee.real, false, "never a verified TEE"); assert.notEqual(tee.source, "relay");
  assert.equal(computeEligibleOf(r), false, "never a deploy target");
  // the retired VBS-enclave format, on the same relay: refused by name
  const legacy = await attachNode(origin, w, "win-legacy", { legacy: true });
  assert.equal(legacy.ok, false); assert.match(String(legacy.reason), /VBS-enclave backend \(ee-engine\) is retired/);
  try { legacy.ws?.close(); } catch {}
  // a relay without the switch (attaching SEV-SNP boxes only): the upgrade is accepted, the credential round refused
  const off = await startRelay(t, { METAL_ALLOWED_MEASUREMENTS: "ab".repeat(48) });
  const b = await attachNode(off, w, "nucbox-off");
  assert.equal(b.ok, false); assert.equal(b.stage, "keys"); assert.match(String(b.reason), /hv-node attach is not enabled/);
  try { b.ws?.close(); } catch {}
});

// a box attached on an ALLOWLISTED TOKEN (the trusted-identity shape a relay attaches with, as us-west does on its operator
// key): it answers /availability with `avail`
async function tokenTunnel(origin, name, token, avail) {
  const ws = new WebSocket(origin.replace(/^http/, "ws") + "/v1/fleet-tunnel", { headers: { "x-metal-name": name, "x-metal-token": token } });
  ws.on("message", (d) => { let f; try { f = JSON.parse(d); } catch { return; }
    if (f.t === "req") ws.send(JSON.stringify({ t: "res", id: f.id, status: f.path.startsWith("/availability") ? 200 : 404, headers: { "content-type": "application/json" },
                                                body: Buffer.from(JSON.stringify(f.path.startsWith("/availability") ? avail : {})).toString("base64") })); });
  const open = await new Promise((resolve) => { ws.on("open", () => resolve(true)); ws.on("unexpected-response", () => resolve(false)); ws.on("error", () => resolve(false)); });
  return { ok: open, ws };
}

test("an hv-node row never feeds the relay roster (enclave-bf's NO-GO on the hv-node flip): its self-declared relay is not in /v1/relays, it cannot take a relay's name, and its volumes stay out of the public aggregate; a relay on a trusted-identity attach (token/operator, us-west's shape) is still listed",
     { skip: !haveOpenssl && "openssl not installed" }, async (t) => {
  const dir = tmpdir("hvnode-roster-"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = makeVbsWorld(dir);
  const roots = path.join(dir, "ek-roots.pem"); fs.writeFileSync(roots, w.ca.bundlePem);
  const origin = await startRelay(t, { RELAY_HVNODE_ATTACH: "1", RELAY_HVNODE_EK_ROOTS: roots, METAL_TUNNEL_TOKENS: "us-west:tok-roster-test", RELAY_DEFAULT_LABEL: "us-west" }, { zeroWord: true });
  // a relay's availability: no compute (so the row reads as a relay), a declared relay role and public address
  const relayAvail = (address, extra = {}) => ({ gpu: false, nodeVcpus: 0, nodeRamGb: 0, claimEnabled: false,
                                                 relay: { address, sni: true, tcp: true, udp: true, egress: true, region: "test" }, ...extra });
  const real = await tokenTunnel(origin, "us-west", "tok-roster-test", relayAvail("198.51.100.10"));
  t.after(() => { try { real.ws.close(); } catch {} });
  assert.equal(real.ok, true, "the token relay attaches");
  // the hv-node row CLAIMS to be a relay (and a volume), under a new name
  const hv = await attachNode(origin, w, "nucbox-relay", { avail: relayAvail("203.0.113.66", { volumes: [{ name: "not-a-real-model", bytes: 1234, gguf: true }] }) });
  t.after(() => { try { hv.ws.close(); } catch {} });
  assert.equal(hv.ok, true, hv.reason);
  // ...and under the relay's own name, which it must not be able to take at all
  const squat = await attachNode(origin, w, "us-west", { avail: relayAvail("203.0.113.67") });
  assert.equal(squat.ok, false, "an hv-node attach cannot take a relay's name");
  try { squat.ws?.close(); } catch {}
  const listed = await waitFor(async () => {
    const j = await (await fetch(origin + "/enclaves")).json();
    const rows = j.enclaves || [];
    const a = rows.find((e) => e.name === "us-west"), b = rows.find((e) => e.name === "nucbox-relay");
    return a && b && a.availability && b.availability ? { j, a, b } : null;
  });
  assert.ok(listed, "both rows are live");
  assert.equal(listed.a.attach, "token"); assert.equal(listed.b.attach, "attestation"); assert.equal(listed.b.mode, "hv-node");
  const r = await fetch(origin + "/v1/relays"); assert.equal(r.status, 200);
  const rel = await r.json();
  const names = (rel.relays || []).map((x) => x.name);
  assert.deepEqual(names, ["us-west"], "the trusted relay is listed, and ONLY it");
  assert.equal(rel.relays[0].address, "198.51.100.10", "the real relay keeps its address");
  assert.ok(!JSON.stringify(rel).includes("203.0.113.66") && !JSON.stringify(rel).includes("203.0.113.67"), "no address the hv-node declared reaches the roster");
  // the public fleet aggregate (/availability: what placement and the deploy console read)
  const agg = await (await fetch(origin + "/availability")).json();
  assert.ok(Array.isArray(agg.volumes), "the aggregate carries a volumes list");
  assert.ok(!agg.volumes.some((v) => v.name === "not-a-real-model"), "an ineligible row's volumes are not in the public aggregate");
});
