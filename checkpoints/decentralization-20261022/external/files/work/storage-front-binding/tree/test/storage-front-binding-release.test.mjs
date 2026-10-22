// The PRODUCTION caller: relay/secrets.js -> relay/secrets-release.mjs handleRelease, with ctx.leaseGeneration = the real
// reader (relay/lease-generation.mjs, wired exactly as relay/api-relay.js does) over three providers in front of the LIVE
// rev-16d ledger bytecode on anvil, and a guest with synthetic SEV-SNP evidence (test/helpers/snp-synth.mjs, as
// test/secrets-release.test.mjs):
//   - a config that refers to ENCLAVE_WRITER_AUTHORITY, its lease's claim FINAL: the sealed release carries
//     facts.writerAuthority = the lease's finalized Claimed log, and facts.runner = THIS lease holder;
//   - the claim NOT final yet (Base: ~20 min): the release still goes out (200, the ticket consumed as always), with
//     facts.runner only: a guest that died on a 503 would be counted an app death and its lease released by the host;
//   - a config that does not refer to it: no fact, no chain read for it.
// The negative control (the base secrets-release.mjs, no wiring) is run by the result's harness with this same file.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import { synthChain, synthReport } from "./helpers/snp-synth.mjs";
import { verifyEvidence, memoryCollateral } from "../verifier/index.mjs";
import { startLease16dRig, KEYS } from "./helpers/lease16d-rig.mjs";
import { createLeaseGenerationReader } from "../relay/lease-generation.mjs";

const skip = (() => { try { execFileSync("anvil", ["--version"], { stdio: "ignore" }); return false; } catch { return "needs anvil"; } })();
const sha = (...p) => createHash("sha256").update(Buffer.concat(p)).digest();
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "front-binding-release-"));
const S = synthChain();
const RID = sha(Buffer.from("synthetic runtime identity")), RUNTIME = { synthetic: "runtime" };
Object.assign(process.env, { SECRETS_KEY: "ab".repeat(32), AUTH_DATA_DIR: DIR, SECRETS_ATTESTED_RELEASE: "1", SECRETS_RELEASE_DEPLOYMENTS: "*",
  SECRETS_RELEASE_BURST: "1000", SECRETS_RELEASE_MIN_TCB: JSON.stringify({ Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }), SECRETS_RELEASE_VMPL: "0",
  SECRETS_RELEASE_SIGNING_KEY: "5a".repeat(32) });
const { initSecrets, handleSecrets, applyPut } = await import("../relay/secrets.js");
const R = await import("../relay/secrets-release.mjs");
await initSecrets();
const APP = sha(Buffer.from("the storage app"));
const REF = "catalog://0x" + "5a".repeat(32) + "/3";
const synthCol = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } });
const predicted = { ok: true, appId: APP.toString("hex"), images: [{ release: "e1".repeat(32), runtimeId: RID.toString("hex"), measurement: "77".repeat(48) }] };
const STORAGE = { indexer: "https://sia.example", appKey: "$SIA_APP_KEY", writerFence: "required", writerAuthority: "$ENCLAVE_WRITER_AUTHORITY", instanceIsolation: "$ENCLAVE_INSTANCE_ISOLATION" };
let rig, OP, EP, EP_ID, reader, leaseCalls = 0;

before(async () => {
  if (skip) return;
  rig = await startLease16dRig();
  OP = privateKeyToAccount(KEYS.operator); EP = rig.hosts.a.endpoint; EP_ID = rig.hosts.a.id;
  // exactly as relay/api-relay.js wires it: the reader over the relay's independent RPCs and its confirmed ledger
  reader = createLeaseGenerationReader({ rpcs: rig.peers.map((p) => p.url), ledger: async () => rig.ledger, fromBlock: 0 });
});
after(async () => { if (rig) await rig.stop(); fs.rmSync(DIR, { recursive: true, force: true }); });

// the relay's context, its chain facts read from the rig (confirmRow: the record by id, as the agreeing read returns it)
const rowOfChain = async (id) => { const d = await rig.row(id);
  return { id: String(d.id).toLowerCase(), owner: String(d.owner).toLowerCase(), runner: String(d.runner).toLowerCase(), leaseUntil: BigInt(d.leaseUntil),
           appRef: REF, configCid: d.configCid, active: d.active, isPublic: d.isPublic, cpuMilli: Number(d.cpuMilli), gpuMilli: Number(d.gpuMilli) }; };
const ids = [];
const ctx = {
  json: (res, code, body) => { res.code = code; res.body = body; },
  readBody: async (req) => Buffer.from(JSON.stringify(req.body)),
  clientIp: () => "203.0.113.9",
  ledgerRows: async () => Promise.all(ids.map(rowOfChain)), ledgerExpire: () => {},
  endpointIdOf: async (ep) => (ep === EP ? EP_ID : "0x" + "ee".repeat(32)),
  operatorOfEndpoint: async (ep) => (ep === EP ? OP.address : null),
  hostEligibility: () => ({ eligible: true, reason: null }),
  leaseHolderChipIds: async (ep) => (ep === EP ? [S.chip.toString("hex")] : []),
  runtimeIdOf: async (r) => (JSON.stringify(r) === JSON.stringify(RUNTIME) ? RID : sha(Buffer.from(JSON.stringify(r)))),
  confirmRow: rowOfChain,
  prewarmCollateral: async () => ({ ok: true }),
  expectedGuestFor: async () => predicted,
  versionConfigFor: async () => null,
  verifyGuestEvidence: (doc, o) => verifyEvidence(doc, {
    policy: { snp: { roots: new Map([["Genoa", S.arkFp]]), allowedMeasurements: o.allowedMeasurements, minTcb: o.minTcb, expectedVmpl: o.expectedVmpl } },
    context: { transportKeySpki: Buffer.from(doc.transportKey, "base64"), expectedBinding: o.expectedBinding, expectedAppId: o.expectedAppId, expectedHostData: o.expectedHostData, now: new Date().toISOString() },
    collateral: synthCol }),
  leaseGeneration: (id, opts) => { leaseCalls++; return reader.writerAuthority(id, opts); },
};
const call = async (p, body) => { const res = {}; await handleSecrets({ method: "POST", body }, res, new URL("http://x" + p), ctx); return res; };
let seq = 0;
async function ticketFor(id) {
  const ts = Math.floor(Date.now() / 1000) - 100 + (seq++ % 200);
  return call("/v1/secrets/release-ticket", { id, endpoint: EP, ts, opSig: await OP.signMessage({ message: `enclave-secrets-release-ticket:${id}:${EP}:${ts}` }) });
}
function guest(id, ticket) {
  const transport = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" });
  const seal = generateKeyPairSync("x25519"), sealKey = R.rawPublicOf(seal.privateKey);
  const rd0 = R.releaseBinding({ id, transportSpki: transport, ticket: Buffer.from(ticket, "base64"), runtimeId: RID, sealKey });
  const report = synthReport(S, { reportData: Buffer.concat([rd0, APP]), hostData: R.idBytes(id) });
  return { evidence: { format: "sev-snp-guest-domain-v1", abi: "enclave-domain-abi/2", runtime: RUNTIME, transportKey: transport.toString("base64"), report: report.toString("base64") },
           sealKey, sealPrivate: seal.privateKey };
}
async function releaseOnce(id) {
  const t = await ticketFor(id);
  assert.equal(t.code, 200, JSON.stringify(t.body));
  const g = guest(id, t.body.ticket);
  const r = await call("/v1/secrets/release", { id, ticket: t.body.ticket, sealKey: g.sealKey.toString("base64"), evidence: g.evidence });
  return { r, plain: r.code === 200 ? JSON.parse(R.openRelease({ id, ticket: Buffer.from(t.body.ticket, "base64"), sealPrivateKey: g.sealPrivate, sealed: Buffer.from(r.body.sealed, "base64") }).toString()) : null };
}

test("the production release carries the lease's finalized writer authority, for THIS lease holder", { skip, timeout: 120000 }, async () => {
  rig.honest(30);
  const id = await rig.create({ config: JSON.stringify({ isolation: { require: "snp-guest-per-app" }, config: STORAGE }) });
  ids.push(id); applyPut(id, JSON.stringify({ set: { SIA_APP_KEY: "synthetic-app-key" } }));
  const c = await rig.claim(id, rig.hosts.a); await rig.mine(40);
  const { r, plain } = await releaseOnce(id);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(plain.config, STORAGE, "the config, placeholders unresolved (the guest resolves them)");
  assert.deepEqual(plain.facts, { runner: EP_ID, writerAuthority: { source: "lease16", chainId: 8453, ledger: rig.ledger.toLowerCase(), deployment: id, claimBlock: c.block, claimLogIndex: c.logIndex } });
  assert.deepEqual(plain.secrets, { SIA_APP_KEY: "synthetic-app-key" }, "the owner's secrets, untouched (no reserved name)");
});

test("a claim not final yet: the release still goes out, WITHOUT the fact (never a 503 that would kill the guest)", { skip, timeout: 120000 }, async () => {
  rig.honest(600);                                          // Base: the finalized block ~600 blocks (~20 min) behind
  const id = await rig.create({ config: JSON.stringify({ isolation: { require: "snp-guest-per-app" }, config: STORAGE }) });
  ids.push(id);
  await rig.claim(id, rig.hosts.a); await rig.mine(5);
  const { r, plain } = await releaseOnce(id);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(plain.facts, { runner: EP_ID }, "no fact, only the lease holder it is for: the guest establishes the fact itself, bound to it, while it waits");
});

test("a config that does not refer to the name: no fact and no lease-generation read", { skip, timeout: 120000 }, async () => {
  rig.honest(30);
  const id = await rig.create({ config: JSON.stringify({ isolation: { require: "snp-guest-per-app" }, config: { indexer: "https://sia.example" } }) });
  ids.push(id);
  await rig.claim(id, rig.hosts.a); await rig.mine(40);
  const before = leaseCalls;
  const { r, plain } = await releaseOnce(id);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(plain.facts, undefined); assert.equal(leaseCalls, before);
});
