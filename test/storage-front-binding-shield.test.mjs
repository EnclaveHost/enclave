// The PRODUCTION Shield caller (the sia-s3 path): relay/shield-secrets.mjs createShieldSecretRelease's deliver(), with
// leaseGeneration = the real reader (relay/lease-generation.mjs, as relay/api-relay.js wires it) over three providers in
// front of the LIVE rev-16d ledger bytecode on anvil. The row is the chain's; the app identity is derived from the real
// catalog derivation (relay/shield-app-verifier.mjs); only the Shield node's tunnel and its TPM verdict are stand-ins.
// The sealed payload the guest would open:
//   - the measured config refers to ENCLAVE_WRITER_AUTHORITY, its claim final: facts.writerAuthority (the lease's
//     finalized Claimed log) and facts.runner (THIS lease holder), beside the owner's secrets;
//   - the claim not final yet: delivered all the same, facts.runner only (the guest reads the fact itself, bound to it);
//   - a config that does not refer to it: no facts and no chain read for it.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import { startLease16dRig, KEYS } from "./helpers/lease16d-rig.mjs";
import { createLeaseGenerationReader } from "../relay/lease-generation.mjs";

process.env.SECRETS_RELEASE_SIGNING_KEY = "5a".repeat(32);   // a synthetic release signing seed
const { createShieldSecretRelease, secretRequestMessage } = await import("../relay/shield-secrets.mjs");
const R = await import("../relay/secrets-release.mjs");
const skip = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return false; } catch { return "needs anvil"; } })();
const vectors = JSON.parse(fs.readFileSync(new URL("../isolation/contract/catalog/derive_vectors.json", import.meta.url)));
const component = Buffer.from(vectors.component_hex, "hex"), base = vectors.ok[0].mapping.record;
const policy = { hosts: "*", cpu: { runtimeId: "ab".repeat(32), secretsV1: true, configBundleV5: true, configSocketServer: true } };
const STORAGE = { indexer: "https://sia.example", appKey: "$SIA_APP_KEY", writerFence: "required", writerAuthority: "$ENCLAVE_WRITER_AUTHORITY", instanceIsolation: "$ENCLAVE_INSTANCE_ISOLATION" };
let rig, OP, reader, leaseCalls = 0, override = null;
// providers that accept a request and never answer: counts requests, and which pending sockets were closed
async function hangingProviders(n) {
  const seen = [], closed = [], urls = [], servers = [];
  for (let i = 0; i < n; i++) {
    const s = http.createServer((req) => { seen.push(i); req.socket.on("close", () => closed.push(i)); });
    await new Promise((ok) => s.listen(0, "127.0.0.1", ok)); servers.push(s); urls.push(`http://127.0.0.1:${s.address().port}`);
  }
  return { urls, seen, closed, stop: () => Promise.all(servers.map((s) => { s.closeAllConnections?.(); return new Promise((ok) => s.close(ok)); })) };
}

const installed = [];   // what the node's tunnel was asked to install, per delivery

before(async () => {
  if (skip) return;
  rig = await startLease16dRig();
  OP = privateKeyToAccount(KEYS.operator);
  reader = createLeaseGenerationReader({ rpcs: rig.peers.map((p) => p.url), ledger: async () => rig.ledger, fromBlock: 0 });
});
after(async () => { if (rig) await rig.stop(); });

function deliverer() {
  const seal = generateKeyPairSync("x25519");
  const hub = {
    shieldSessionId: () => "sid-1",
    fetchJson: async (_origin, p) => { const id = new URL("http://x" + p).searchParams.get("deployment");
      return { purpose: "enclave-shield-secrets/1", id, sealKey: R.rawPublicOf(seal.privateKey).toString("base64"), handshakeSpki: Buffer.from("spki").toString("base64"), doc: {} }; },
    verifyShieldApp: async () => ({ ok: true }),   // the node's TPM verdict: its own suites cover it
    request: async (_origin, req) => { installed.push(JSON.parse(req.body.toString())); return { status: 200, body: Buffer.from('{"ok":true}') }; },
  };
  const confirmRow = async (id) => { const d = await rig.row(id);
    return { id: String(d.id).toLowerCase(), owner: String(d.owner).toLowerCase(), runner: String(d.runner).toLowerCase(), leaseUntil: Number(d.leaseUntil),
             appRef: `catalog://${base.catalog.app}/0`, configCid: d.configCid, active: d.active, isPublic: d.isPublic, cpuMilli: Number(d.cpuMilli), gpuMilli: Number(d.gpuMilli) }; };
  const deliver = createShieldSecretRelease({ hub, policy, confirmRow,
    readCatalog: async () => ({ app: { active: true }, version: { cid: base.cid, memMb: 128, ports: "", approval: 1, yanked: false } }),
    readConfig: async () => ({ config: "", configCid: "" }),
    fetchVerified: async () => ({ ok: true, bytes: component }),
    hostForEndpoint: (epId) => (epId === rig.hosts.a.id ? { mode: "hv-node", name: "shield-a" } : null),
    leaseGeneration: (id, opts) => { leaseCalls++; return (override || reader).writerAuthority(id, opts); },
    sleep: async () => {} });
  return { deliver, seal };
}
const ctx = () => ({ operatorOfEndpoint: async (ep) => (ep === rig.hosts.a.endpoint ? OP.address : null), endpointIdOf: async (ep) => (ep === rig.hosts.a.endpoint ? rig.hosts.a.id : "0x" + "ee".repeat(32)) });
async function deliverOnce(id) {
  const { deliver, seal } = deliverer(), ep = rig.hosts.a.endpoint, ts = Math.floor(Date.now() / 1000);
  const opSig = await OP.signMessage({ message: secretRequestMessage(id, ep, ts) });
  const out = await deliver({ id, endpoint: ep, ts, opSig }, ctx(), () => ({ env: { SIA_APP_KEY: "synthetic-app-key" }, rev: 1 }));
  const sent = installed.at(-1);
  const plain = JSON.parse(R.openRelease({ id, ticket: Buffer.from(sent.nonce, "hex"), sealPrivateKey: seal.privateKey, sealed: Buffer.from(sent.sealed, "base64") }).toString());
  return { out, plain };
}
const envelope = (config) => JSON.stringify({ isolation: { require: "hyperv-partition-per-app" }, config });

test("Shield: the sealed delivery carries the lease's finalized writer authority and THIS lease holder", { skip, timeout: 120000 }, async () => {
  rig.honest(30);
  const id = await rig.create({ config: envelope(STORAGE) });
  const c = await rig.claim(id, rig.hosts.a); await rig.mine(40);
  const { out, plain } = await deliverOnce(id);
  assert.equal(out.ok, true);
  assert.deepEqual(plain.secrets, { SIA_APP_KEY: "synthetic-app-key" });
  assert.deepEqual(plain.facts, { runner: rig.hosts.a.id, writerAuthority: { source: "lease16", chainId: 8453, ledger: rig.ledger.toLowerCase(), deployment: id, claimBlock: c.block, claimLogIndex: c.logIndex } });
});

test("Shield: a claim not final yet is delivered all the same, with the lease holder only", { skip, timeout: 120000 }, async () => {
  rig.honest(600);
  const id = await rig.create({ config: envelope(STORAGE) });
  await rig.claim(id, rig.hosts.a); await rig.mine(5);
  const { out, plain } = await deliverOnce(id);
  assert.equal(out.ok, true);
  assert.deepEqual(plain.facts, { runner: rig.hosts.a.id });
});

test("Shield: a config that does not refer to the name gets no facts and no chain read for it", { skip, timeout: 120000 }, async () => {
  rig.honest(30);
  const id = await rig.create({ config: envelope({ indexer: "https://sia.example", appKey: "$SIA_APP_KEY" }) });
  await rig.claim(id, rig.hosts.a); await rig.mine(40);
  const before = leaseCalls;
  const { out, plain } = await deliverOnce(id);
  assert.equal(out.ok, true);
  assert.equal(plain.facts, undefined); assert.equal(leaseCalls, before);
});

test("Shield: the delivery's writer-authority deadline CANCELS the read; the delivery goes out, nothing is sent after", { skip, timeout: 120000 }, async () => {
  rig.honest(30);
  const id = await rig.create({ config: envelope(STORAGE) });
  await rig.claim(id, rig.hosts.a); await rig.mine(40);
  const H = await hangingProviders(2);
  process.env.SECRETS_RELEASE_WRITER_AUTHORITY_MS = "500";
  override = createLeaseGenerationReader({ rpcs: H.urls, ledger: async () => rig.ledger, fromBlock: 0, timeoutMs: 60000 });
  try {
    const t0 = Date.now();
    const { out, plain } = await deliverOnce(id);
    assert.equal(out.ok, true);
    assert.deepEqual(plain.facts, { runner: rig.hosts.a.id });
    assert.ok(Date.now() - t0 < 10000);
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(H.seen.length, 2); assert.equal(H.closed.length, 2, "the deadline closed both pending requests");
    const n = H.seen.length; await new Promise((ok) => setTimeout(ok, 1500));
    assert.equal(H.seen.length, n, "no request after the deadline");
  } finally { override = null; delete process.env.SECRETS_RELEASE_WRITER_AUTHORITY_MS; await H.stop(); }
});
