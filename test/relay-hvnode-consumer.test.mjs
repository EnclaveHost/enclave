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
const stubRpc = () => http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
  const q = JSON.parse(b || "{}"); const one = (m) => ({ jsonrpc: "2.0", id: m.id, result: "0x" });
  res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q))); }); });
async function startRelay(t, env) {
  const rpc = stubRpc(); await listenOnFreePort(rpc);
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
async function attachNode(origin, w, name, { legacy = false } = {}) {
  const ws = new WebSocket(origin.replace(/^http/, "ws") + "/v1/fleet-tunnel", { headers: { "x-metal-name": name, "x-metal-attest": "1" } });
  const frames = [];
  ws.on("message", (d) => {
    let f; try { f = JSON.parse(d); } catch { return; } frames.push(f);
    if (f.t === "req") ws.send(JSON.stringify({ t: "res", id: f.id, status: f.path.startsWith("/availability") ? 200 : 404, headers: { "content-type": "application/json" },
                                                body: Buffer.from(JSON.stringify(f.path.startsWith("/availability") ? AVAILABILITY : {})).toString("base64") }));
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
