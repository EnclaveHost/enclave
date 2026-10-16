#!/usr/bin/env node
// The PRODUCTION capacity-audit service (docs/design/paid-capacity-verification.md, "Deployment dependencies"), one process:
//   - the bootstrap WITNESS (availability/witness.mjs): a capacity receipt per attested host, every witnessEverySec, written
//     to <stateDirectory>/receipts.json (the coordinator's supply input; custody v2 candidates present them too);
//   - the COORDINATOR (availability/coordinator.mjs runRound) every intervalSec, composed from the real adapters:
//     fee-chain-adapter (EnclaveVerificationFees, the payer policy's executor), relay secret staging (ERC-1271), the
//     host acceptors, the CPU workload over attested HTTP, and the finalized-ledger observation;
//   - the HOST ACCEPTORS this machine's hosts run (availability/host-acceptor.mjs), called in-process.
//
//   node scripts/availability/service.mjs /absolute/config.json
// Keys come from the environment named in the config (AUDIT_EXECUTOR_KEY, AUDIT_WITNESS_KEY), and a host's operator key
// from its own key file; nothing secret is in the config. TRUST: operator-bootstrap. The witness and the expected guest
// measurements (the relay's predictor) are Enclave-operated; every receipt says so, and evidence.mjs never counts it as
// independent.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPublicClient, createWalletClient, http, stringToHex, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { openStore } from "../../availability/store.mjs";
import { runRound } from "../../availability/coordinator.mjs";
import { createFeeChainAdapter } from "../../availability/fee-chain-adapter.mjs";
import { stageDeploymentSecrets } from "../../availability/secrets.mjs";
import { createCpuWorkload } from "../../availability/workload.mjs";
import { verifiedAppRequest } from "../../availability/verified-http.mjs";
import { createObservationLoader } from "../../availability/observation.mjs";
import { createWitness } from "../../availability/witness.mjs";
import { createHostAcceptor } from "../../availability/host-acceptor.mjs";
import { verifyQuote, parseSnpReport } from "../../relay/snp-verify.mjs";
import { DEFAULT_SNP_POLICY } from "../../verifier/snp.mjs";
import { runtimeId as runtimeIdOf } from "../../isolation/contract/runtime.mjs";
import { cachedCollateral, httpCollateral } from "../../verifier/index.mjs";

const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const B = (v) => BigInt(v);
const lc = (s) => String(s || "").toLowerCase();
const read = createPublicClient({ chain: base, transport: http(cfg.rpcRead, { timeout: 30_000, retryCount: 2 }) });       // archive + logs
const send = createPublicClient({ chain: base, transport: http(cfg.rpcSend, { timeout: 30_000, retryCount: 2 }) });
const keyEnv = (name) => { const k = process.env[name]; if (!k) throw new Error(`${name} is not set`); return privateKeyToAccount(k.startsWith("0x") ? k : "0x" + k); };
const executor = keyEnv(cfg.executorKeyEnv), witnessKey = keyEnv(cfg.witnessKeyEnv);
const executorWallet = createWalletClient({ chain: base, account: executor, transport: http(cfg.rpcSend) });
const REG_ABI = JSON.parse(fs.readFileSync(new URL("../../contracts/EnclaveRegistry.abi.json", import.meta.url)));
const REG_V4 = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
  { name: "endpoint", type: "string" }, { name: "repo", type: "string" }, { name: "measurement", type: "bytes32" }, { name: "operator", type: "address" },
  { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" }, { name: "active", type: "bool" },
  { name: "cpuPricePerSec6", type: "uint64" }, { name: "gpuPricePerSec6", type: "uint64" }, { name: "proofKey", type: "address" }, { name: "payoutWallet", type: "address" }] }] }];
void REG_ABI;
const readRegistry = async (hostId, blockNumber) => {
  const e = await send.readContract({ address: cfg.registry, abi: REG_V4, functionName: "get", args: [hostId], ...(blockNumber ? { blockNumber } : {}) });
  return { active: e.active, operator: lc(e.operator), payoutWallet: lc(e.payoutWallet), cpuPricePerSec6: e.cpuPricePerSec6 };
};
const getJson = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); };

// ---- the witness ----
const witnessState = (() => {
  const f = path.join(cfg.stateDirectory, "witness-state.json");
  let m = {}; try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  return { get: (k) => m[k] || null, set: (k, v) => { m[k] = v; fs.writeFileSync(f + ".tmp", JSON.stringify(m)); fs.renameSync(f + ".tmp", f); } };
})();
const VERIFIER_SIDE = /\/v1\/expected-guest\?id=|^no prediction for the job's guest|^no installed release states runtime|^no admitted predicted image/;
const witness = createWitness({
  signer: witnessKey, chainId: 8453, contract: cfg.fees, classId: cfg.classId, readRegistry, minTcb: cfg.minTcb,
  allowedMeasurements: cfg.hostMeasurements, state: witnessState, receiptTtlSec: cfg.receiptTtlSec,
  verifyQuote: async (report, { binding, auxblob, allowedMeasurements, minTcb }) => {
    let p; try { p = parseSnpReport(report); } catch (e) { return { ok: false, reason: e.message }; }
    const v = await verifyQuote(report, { challenge: Buffer.from("witness"), transportKeySpki: Buffer.from("witness"), expectedBinding: Buffer.from(binding),
                                          allowedMeasurements, auxblob, requireVcek: true, minTcb, expectedVmpl: 0 });
    return v.ok ? { ok: true, measurement: p.measurement.toString("hex"), chipId: p.chipId.toString("hex") } : { ok: false, reason: v.reasons.slice(-1)[0] };
  },
  // A failure counts against the host only when the host held the paid lease and the verifier had its own expectations:
  // a job that never reached the challenge (offer, funding, claim) or that failed on the verifier's side (its relay's
  // prediction, its installed releases) is INCONCLUSIVE. Otherwise one verifier-side fault would refuse the host's
  // receipts, so no further audit could be offered and it could never pass again (job 2, 2026-10-15: relay 503).
  // An operator may also mark a failed record `inconclusive: "<why>"` when the fault was the verifier's own (job 4,
  // 2026-10-16: the binding used one release's runtime for every predicted image); the annotation stays on the record.
  lastAudit: async (hardwareId) => {
    const done = (await store.list()).filter((j) => j.offer && lc(j.offer.hardwareId) === lc(hardwareId) && ["complete", "failed"].includes(j.state))
      .filter((j) => j.state === "complete" || (j.lease && !j.inconclusive && !VERIFIER_SIDE.test(String(j.failure || ""))))
      .sort((a, b) => Number(B(b.offer.atSec) - B(a.offer.atSec)));
    return done.length ? { passed: done[0].state === "complete" && !done[0].failure, atSec: String(done[0].offer.atSec), job: done[0].id } : null;
  },
  log,
});
// a metal box: its control VM's attestation document (a boot-time quote, report_data = sha256(transport SPKI)) + live /availability
const metalHost = (h) => ({
  endpoint: h.endpoint,
  attest: async () => {
    const d = (await getJson(`${h.endpoint}/v1/attestation`)).enclave.attestationDocument;
    if (d.format !== "sev-snp-guest-metal-v1") throw new Error(`unexpected attestation format ${d.format}`);
    const spki = Buffer.from(d.transportKey, "base64");
    return { report: Buffer.from(d.body, "base64"), auxblob: d.certs ? Buffer.from(d.certs, "base64") : null,
             binding: createHash("sha256").update(spki).digest(), evidence: "metal attestation document (boot-time quote bound to its TLS key) + live /availability" };
  },
  availability: () => getJson(`${h.endpoint}/availability`),
});
const receiptsFile = path.join(cfg.stateDirectory, "receipts.json");
async function witnessRound() {
  const r = await witness.round(cfg.hosts.map(metalHost));
  fs.writeFileSync(receiptsFile + ".tmp", JSON.stringify(r.receipts, null, 1)); fs.renameSync(receiptsFile + ".tmp", receiptsFile);
  log(`[witness] ${r.receipts.length} receipt(s), ${r.refused.length} refused`);
}

// ---- the host acceptors this machine runs ----
const acceptors = new Map();
for (const h of cfg.hosts) {
  if (!h.operatorKeyFile) continue;
  const k = JSON.parse(fs.readFileSync(h.operatorKeyFile, "utf8")).registryKey;
  const op = privateKeyToAccount(k.startsWith("0x") ? k : "0x" + k);
  const enclaveId = lc(keccak256(toBytes(h.endpoint)));
  const e = await readRegistry(enclaveId);
  if (e.operator !== lc(op.address)) throw new Error(`${h.endpoint}: the key file is not its registry operator`);
  acceptors.set(enclaveId, createHostAcceptor({ publicClient: send, operatorWallet: createWalletClient({ chain: base, account: op, transport: http(cfg.rpcSend) }),
    ledger: cfg.ledger, fees: cfg.fees, enclaveId, appRefs: [cfg.profile.appRef], minRatePerShareMilli6: B(h.minRatePerShareMilli6 || 0), log }));
}

// ---- the coordinator ----
const store = await openStore(cfg.stateDirectory);
const chain = createFeeChainAdapter({ publicClient: send, executorWallet, ledger: cfg.ledger, fees: cfg.fees, registry: cfg.registry, chainId: 8453, source: cfg.source,
  profile: cfg.profile, store, stageSecrets: stageDeploymentSecrets({ apiBase: cfg.relay, account: executor, contractWallet: true }),
  acceptHostOffer: async (o) => { const a = acceptors.get(lc(o.hostId)); if (!a) throw new Error(`no acceptor for host ${o.hostId}`); return a(o); },
  claimHint: async (id, hostId) => { await fetch(`${cfg.relay}/v1/claim-hint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {}); void hostId; } });
const collateral = cachedCollateral({ dir: path.join(cfg.stateDirectory, "amd"), upstream: httpCollateral({ timeoutMs: 8000 }) });
const runtimeCache = new Map();
const releaseRuntime = (rid) => {   // hits are cached; a miss is rescanned (a release may be installed later)
  if (!runtimeCache.has(lc(rid))) { const j = scanRuntime(rid); if (!j) return null; runtimeCache.set(lc(rid), j); }
  return runtimeCache.get(lc(rid));
};
const scanRuntime = (rid) => {   // the runtime identity JSON of an installed release whose runtime id the prediction names
  for (const d of fs.readdirSync(cfg.releasesDir).filter((x) => /^release-[0-9a-f]{8}$/.test(x))) {
    try { const j = JSON.parse(fs.readFileSync(path.join(cfg.releasesDir, d, "template/rt/runtime.json"), "utf8")); if (runtimeIdOf(j).toString("hex") === lc(rid)) return j; } catch {}
  }
  return null;
};
// READINESS, inside the paid lease and BEFORE the timed challenge starts (the first production jobs, 2026-10-15,
// challenged a guest that had just been claimed: the relay's prediction for a new lease is cold, and the guest needs to
// boot and obtain its certificate). Wait until the relay predicts the job's guest and the guest answers its attestation
// endpoint over TLS. Nothing here is evidence: the attested exchange and every check in verifiedAppRequest are unchanged.
const predictions = new Map();
async function untilReady(job) {
  const leaseEndMs = Number(job.lease.leaseUntil) * 1000 - cfg.workload.timeoutMs - 15_000;
  const origin = `https://${job.deployment.id.slice(2, 10)}.app.enclave.host/`;
  let p = null;
  for (;;) {
    if (!p) { const r = await fetch(`${cfg.relay}/v1/expected-guest?id=${job.deployment.id}`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
              if (r && r.ok) { const j = await r.json().catch(() => null); if (j && (j.images || []).length) p = j; } }
    if (p) { const r = await fetch(origin + ".well-known/enclave-attestation?nonce=" + "00".repeat(32), { signal: AbortSignal.timeout(15_000) }).catch(() => null);
             if (r && r.status === 200) { predictions.set(job.deployment.id, p); return; } }
    if (Date.now() > leaseEndMs) throw new Error(p ? "the guest did not answer over TLS within its lease" : "no prediction for the job's guest within its lease");
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
const cpuWorkload = createCpuWorkload({ referenceBinary: cfg.referenceBinary, rounds: cfg.workload.rounds, memoryMiB: cfg.workload.memoryMiB, passes: cfg.workload.passes, timeoutMs: cfg.workload.timeoutMs,
  requestVerified: verifiedAppRequest({ collateral, loadExpectations: async (job) => {
    const p = predictions.get(job.deployment.id) || await getJson(`${cfg.relay}/v1/expected-guest?id=${job.deployment.id}`);
    // the relay's prediction (Enclave-operated: operator-bootstrap trust), only the images of releases it ADMITS
    const admitted = (p.images || []).filter((i) => i.releaseAdmitted !== false);
    if (!admitted.length) throw new Error("no admitted predicted image for the job");
    // one expectation per image: its measurement with the runtime identity that image binds
    const images = admitted.map((i) => ({ measurements: [lc(i.measurement)], runtimeIdentity: releaseRuntime(i.runtimeId) })).filter((i) => i.runtimeIdentity);
    if (!images.length) throw new Error(`no installed release states runtime ${admitted.map((i) => i.runtimeId).join(", ")}`);
    return { deploymentId: job.deployment.id, hostId: job.offer.hostId, appId: lc(p.appId), origin: `https://${job.deployment.id.slice(2, 10)}.app.enclave.host/`, kind: "snp",
             images, policy: { snp: { ...DEFAULT_SNP_POLICY, product: "Turin", minTcb: cfg.minTcb } } };
  } }) });
const workload = { async runAndVerify(job) { await untilReady(job); try { return await cpuWorkload.runAndVerify(job); } finally { predictions.delete(job.deployment.id); } } };
const loadObservation = createObservationLoader({
  chain: { client: read, ledger: cfg.ledger, proof: cfg.proof, availability: cfg.fees, windowSec: B(cfg.observation.windowSec), classId: cfg.classId, resource: "cpu",
           knownVerificationAppRefs: [cfg.profile.appRef] },
  loadReceipts: async () => { try { return JSON.parse(fs.readFileSync(receiptsFile, "utf8")); } catch { return []; } },
  resolveHost: async (hostId) => readRegistry(hostId),
  trust: { chainId: 8453, contract: cfg.fees, signers: { [lc(witnessKey.address)]: "enclave-bootstrap" }, quorum: 1, trustMode: "operator-bootstrap" },
  limits: { maxReceipts: 200, maxSpareAgeSec: B(cfg.observation.maxSpareAgeSec), maxUnitsPerHost: B(cfg.observation.maxUnitsPerHost),
            anchorRate6: B(cfg.policy.anchorRate6), maxQueuedUnits: B(cfg.observation.maxQueuedUnits), maxDemandPerOwnerUnits: B(cfg.observation.maxDemandPerOwnerUnits) } });
const policy = Object.fromEntries(Object.entries(cfg.policy).map(([k, v]) => [k, typeof v === "string" && /^\d+$/.test(v) ? B(v) : v]));
const scheduling = { durationSec: B(cfg.scheduling.durationSec), allocationUnits: B(cfg.scheduling.allocationUnits), maxConcurrent: cfg.scheduling.maxConcurrent, cooldownSec: B(cfg.scheduling.cooldownSec) };
log(`[audit] executor ${executor.address}, witness ${witnessKey.address}, source ${cfg.source}, ${cfg.hosts.length} host(s), ${acceptors.size} acceptor(s)`);

let stopped = false, lastWitness = 0;
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { stopped = true; });
while (!stopped) {
  if (Date.now() - lastWitness >= cfg.witnessEverySec * 1000) { try { await witnessRound(); } catch (e) { log(`[witness] round failed: ${e.message}`); } lastWitness = Date.now(); }
  try {
    const r = await runRound({ store, chain, workload, loadObservation, policy, scheduling, nowSec: B(Math.floor(Date.now() / 1000)) });
    log(`[audit] ${JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  } catch (e) { log(`[audit] round failed: ${e.message}`); }
  for (let i = 0; i < cfg.intervalSec && !stopped; i++) await new Promise((r) => setTimeout(r, 1000));
}
await store.close();
void stringToHex;
