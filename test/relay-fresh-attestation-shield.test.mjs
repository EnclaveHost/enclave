// A FRESH Enclave Shield host attestation over a CLIENT's nonce, end to end through the REAL relay process
// (POST /v1/enclaves/<box>/attestation, then .../credential): the relay re-sends the attach challenge on the live tunnel with
// the client's nonce, hands back the node's TPM keys, forwards the credential THE CLIENT minted for them, and returns the node's
// windows-hv-node/v1 document verbatim. The client then judges it with the relay's own verifier and the credential only it
// knew, so the relay cannot stand in for the TPM. The live attach is untouched (no second attest-result), checks of one box are
// spaced, a node's refusal reaches only the check in flight, and GET points a Shield host at the two-step flow.
//   run: node --test test/relay-fresh-attestation-shield.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes, sign as edSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { bootDaemon, listenOnFreePort } from "./helpers/daemon.mjs";
import { haveOpenssl, tmpdir, makeVbsWorld, buildLog, buildQuote } from "./fixtures/vbs-synthetic.mjs";
import { activateCredential, makeCredential, ekPublicFrom } from "../relay/vbs-credential.mjs";
import { HVNODE_FORMAT, hvNodeBinding, verifyHvNodeEvidence } from "../relay/hvnode-verify.mjs";

const RELAY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const STATEMENT = Buffer.from(JSON.stringify({ stated: true, backend: "custom-type1", tier: "t0-hv", hostExcluded: false, derivations: [] }));
const waitFor = async (fn, ms = 15000) => { const until = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) return null; await new Promise((r) => setTimeout(r, 50)); } };

async function startRelay(t, env) {
  // a chain that knows nothing: the box's name is unregistered, so no operator signature is due
  const rpc = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const q = JSON.parse(b || "{}"), one = (m) => ({ jsonrpc: "2.0", id: m.id, result: m.method === "eth_chainId" ? "0x2105" : "0x" });
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q))); }); });
  await listenOnFreePort(rpc);
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

// A synthetic node that behaves as windows/node/agent.mjs does: EVERY challenge (the attach's and any later one) is answered
// with its TPM keys, and the credential that follows with evidence over THAT challenge's nonce. `refuse` makes it answer the
// credential with the agent's failure frame instead.
async function attachNode(origin, w, name) {
  const ws = new WebSocket(origin.replace(/^http/, "ws") + "/v1/fleet-tunnel", { headers: { "x-metal-name": name, "x-metal-attest": "1" } });
  const node = { ws, frames: [], refuse: null, pending: null };
  ws.on("message", (d) => {
    let f; try { f = JSON.parse(d); } catch { return; } node.frames.push(f);
    if (f.t === "req") { const ok = f.path.startsWith("/availability");   // listed only while it answers the relay's polls
      return ws.send(JSON.stringify({ t: "res", id: f.id, status: ok ? 200 : 404, headers: { "content-type": "application/json" },
                                      body: Buffer.from(JSON.stringify(ok ? { gpu: false, type: "cpu", nodeVcpus: 16, nodeRamGb: 64 } : {})).toString("base64") })); }
    if (f.t === "challenge") {
      node.pending = Buffer.from(f.nonce, "base64");
      return ws.send(JSON.stringify({ t: "vbs-keys", ek: w.ek.cert.toString("base64"), ekChain: [w.ca.inter.toString("base64")], aikPub: w.aik.tpmtPublic.toString("base64"), aikName: w.aik.name.toString("base64") }));
    }
    if (f.t === "vbs-credential") {
      if (node.refuse) return ws.send(JSON.stringify({ t: "attest", rad: { format: HVNODE_FORMAT, body: "", refused: node.refuse } }));
      const credential = activateCredential(w.ek.privateKey, w.aik.name, Buffer.from(f.credentialBlob, "base64"), Buffer.from(f.secret, "base64"));
      const bound = hvNodeBinding(w.transport.spki, node.pending, STATEMENT);
      const L = buildLog({ idksPub: w.idks.publicKey });
      const Q = buildQuote({ aikPriv: w.aik.privateKey, aikName: w.aik.name, pcrs: L.pcrs, pcr0: w.pcr0, extraData: createHash("sha256").update(bound).digest() });
      const body = { statement: STATEMENT.toString("base64"), signature: edSign(null, bound, w.transport.privateKey).toString("base64"), log: L.log.toString("base64"),
                     quote: { attest: Q.attest.toString("base64"), sig: Q.sig.toString("base64"), aikPub: w.aik.tpmtPublic.toString("base64") }, credential: credential.toString("base64"),
                     ek: { cert: w.ek.cert.toString("base64"), chain: [w.ca.inter.toString("base64")] }, pcr0: w.pcr0.toString("hex"), platform: {} };
      ws.send(JSON.stringify({ t: "attest", rad: { format: HVNODE_FORMAT, transportKey: w.transport.spki.toString("base64"), body: Buffer.from(JSON.stringify(body)).toString("base64"), delegations: [] } }));
    }
  });
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  const res = await waitFor(() => node.frames.find((f) => f.t === "attest-result"));
  assert.equal(res?.ok, true, res?.reason);
  ws.send(JSON.stringify({ t: "hello", mode: "hv-node", transportKeyFp: "" }));
  return node;
}
const post = async (url, body) => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };

test("relay: a client verifies a live Enclave Shield host itself - the relay forwards its nonce and its own credential and returns the TPM evidence verbatim; the attach is untouched, checks are spaced, a refusal reaches only the check",
     { skip: !haveOpenssl && "openssl not installed" }, async (t) => {
  const dir = tmpdir("shield-fresh-"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = makeVbsWorld(dir);
  const roots = path.join(dir, "ek-roots.pem"); fs.writeFileSync(roots, w.ca.bundlePem);
  const origin = await startRelay(t, { RELAY_HVNODE_ATTACH: "1", RELAY_HVNODE_EK_ROOTS: roots, RELAY_FRESH_GAP_MS: "800" });
  const node = await attachNode(origin, w, "shield-box");
  t.after(() => { try { node.ws.close(); } catch {} });
  await waitFor(async () => ((await (await fetch(origin + "/enclaves")).json()).enclaves || []).some((e) => e.name === "shield-box"));
  const at = `${origin}/v1/enclaves/shield-box/attestation`;

  // GET is for one-step tiers: a Shield host is pointed at the two-step flow
  const g = await fetch(`${at}?nonce=${"ab".repeat(32)}`);
  assert.equal(g.status, 405); assert.match((await g.json()).message, /POST \{nonce\}/);
  assert.equal((await post(`${origin}/v1/enclaves/nobody/attestation`, { nonce: "34".repeat(32) })).status, 404, "no such box");
  assert.equal((await post(at, { nonce: "xyz" })).status, 422, "a nonce that is not 64 hex");

  // step 1: the CLIENT's nonce goes to the node as a challenge; its TPM keys come back verbatim
  const nonce = randomBytes(32);
  const s1 = await post(at, { nonce: nonce.toString("hex") });
  assert.equal(s1.status, 200, JSON.stringify(s1.json));
  assert.equal(Buffer.from(node.frames.filter((f) => f.t === "challenge").at(-1).nonce, "base64").equals(nonce), true, "the node is challenged with the client's nonce");
  assert.equal(s1.json.mode, "hv-node"); assert.match(s1.json.session, /^[0-9a-f]{48}$/);
  assert.equal(s1.json.keys.ek, w.ek.cert.toString("base64")); assert.equal(s1.json.keys.aikName, w.aik.name.toString("base64"));
  // a second check while this one is open: busy
  const busy = await post(at, { nonce: "cd".repeat(32) });
  assert.equal(busy.status, 503); assert.equal(busy.json.error, "busy");

  // step 2: the client mints ITS credential for those keys; the node's evidence over the client's nonce comes back
  const credential = randomBytes(32), ekCert = Buffer.from(s1.json.keys.ek, "base64"), aikName = Buffer.from(s1.json.keys.aikName, "base64");
  const { credentialBlob, secret } = makeCredential(ekPublicFrom(ekCert), aikName, credential);
  const s2 = await post(`${at}/credential`, { session: s1.json.session, credentialBlob: credentialBlob.toString("base64"), secret: secret.toString("base64") });
  assert.equal(s2.status, 200, JSON.stringify(s2.json));
  assert.deepEqual(Object.keys(s2.json.document).sort(), ["body", "format", "transportKey"], "the document only: no delegations or other attach fields");
  const v = verifyHvNodeEvidence({ evidence: JSON.parse(Buffer.from(s2.json.document.body, "base64").toString("utf8")), nonce,
                                   transportKeySpki: Buffer.from(s2.json.document.transportKey, "base64"), expectedCredential: credential, mintedFor: { ekCert, aikName } },
                                 { ekRoots: w.ca.bundlePem });
  assert.equal(v.ok, true, JSON.stringify(v.reasons)); assert.equal(v.admissible, true);
  // ...and a credential the client did NOT mint fails the same evidence: the relay cannot have answered for the TPM
  const forged = verifyHvNodeEvidence({ evidence: JSON.parse(Buffer.from(s2.json.document.body, "base64").toString("utf8")), nonce,
                                        transportKeySpki: Buffer.from(s2.json.document.transportKey, "base64"), expectedCredential: randomBytes(32), mintedFor: { ekCert, aikName } },
                                      { ekRoots: w.ca.bundlePem });
  assert.equal(forged.ok, false);
  assert.equal(node.frames.filter((f) => f.t === "attest-result").length, 1, "the live attach is untouched: no attest-result for a client check");
  // the session is spent
  const again = await post(`${at}/credential`, { session: s1.json.session, credentialBlob: credentialBlob.toString("base64"), secret: secret.toString("base64") });
  assert.equal(again.status, 404);

  // checks of one box are spaced
  const soon = await post(at, { nonce: "ef".repeat(32) });
  assert.equal(soon.status, 503); assert.ok(soon.json.retryAfter >= 1);
  await new Promise((r) => setTimeout(r, 900));

  // a node that refuses (its failure frame): the check fails with the node's reason; the tunnel stays attached
  node.refuse = "tpm: quote failed";
  const r1 = await post(at, { nonce: "12".repeat(32) });
  assert.equal(r1.status, 200);
  const c2 = makeCredential(ekPublicFrom(ekCert), aikName, randomBytes(32));
  const r2 = await post(`${at}/credential`, { session: r1.json.session, credentialBlob: c2.credentialBlob.toString("base64"), secret: c2.secret.toString("base64") });
  assert.equal(r2.status, 502); assert.match(r2.json.message, /refused: tpm: quote failed/);
  assert.equal(node.ws.readyState, WebSocket.OPEN, "a refused check never closes the tunnel");
  assert.ok(((await (await fetch(origin + "/enclaves")).json()).enclaves || []).some((e) => e.name === "shield-box"), "still listed");

  // malformed input
  assert.equal((await post(`${at}/credential`, { session: "nope" })).status, 422);
  // ...and past the per-IP budget (6, then one per 5 s) a client is told to slow down, whatever box it asks for
  assert.equal((await post(`${origin}/v1/enclaves/nobody/attestation`, { nonce: "34".repeat(32) })).status, 429);
});
