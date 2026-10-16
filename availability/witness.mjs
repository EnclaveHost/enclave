// The capacity WITNESS (docs/design/paid-capacity-verification.md, deployment dependency 3): issues the signed capacity
// receipts that qualify a host's supply (observation.mjs verifies them) and that custody v2 requires of a non-Enclave
// custodian candidate (docs/security/secret-custody-v2.md §5: receipts naming the candidate's chip).
//
// THIS IS THE BOOTSTRAP WITNESS: one Enclave-operated group, and every receipt says trustMode "operator-bootstrap"
// (evidence.mjs refuses to count it as independent). What it checks, per host, every round:
//   - the host's SEV-SNP quote (relay/snp-verify.mjs verifyQuote: AMD chain, TCB floor, VMPL 0, debug off) carrying the
//     binding its adapter states, its measurement on the operator's allowlist; the chip id comes from that quote. For a
//     metal box that is the attestation document its control VM serves (a boot-time quote bound to its TLS key), so
//     LIVENESS comes from the attested /availability read in the same round, not from the quote; the receipt says which
//     (payload.evidence). An Enclave Shield host instead brings its own verifier: a fresh TPM session over our nonce
//     (availability/shield.mjs; the host's boot state only, the host is not excluded), its EK certificate on the allowlist;
//   - the registry entry (active; operator and payout wallet are copied from it, never from the host);
//   - capacity (units) and spare from the host's attested surfaces (/availability), bounded by configured ceilings;
//   - optionally, the most recent PASSING paid audit for that hardware (the coordinator's store): a host with a failed
//     audit after its last pass gets no receipt.
// Qualification is continuous: the receipt's issuedSec is the first round of the current unbroken run of passes, so a
// host that fails a round starts again (observation.mjs needs a certificate that covers the whole window).
import { createHash } from "node:crypto";
import { keccak256, toBytes } from "viem";
import { receiptData } from "./evidence.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const lc = (s) => String(s || "").toLowerCase();

// hosts: [{ endpoint (registry endpoint), attest: async () -> { report, auxblob, binding (32 bytes), evidence (label) },
//           availability: async () -> { nodeGflops, cpuGflopsFree },
//           verify?: async (attested, { binding, auxblob, allowedMeasurements, minTcb }) -> { ok, measurement, chipId (hex) } | { ok: false, reason } }]
// verify (optional) replaces the witness's verifyQuote for that host and receives attest()'s whole answer.
export function createWitness({ signer, chainId, contract, classId = "cpu", readRegistry, verifyQuote, allowedMeasurements, minTcb,
                                lastAudit = async () => null, state, receiptTtlSec = 6 * 3600, maxUnits = 4096n, now = () => BigInt(Math.floor(Date.now() / 1000)),
                                log = console.log }) {
  if (!signer || typeof signer.signTypedData !== "function") throw new Error("witness: a signing account is required");
  if (!Array.isArray(allowedMeasurements) || !allowedMeasurements.length) throw new Error("witness: an allowlist of host measurements is required");
  async function examine(host) {
    const t = now();
    const hostId = lc(keccak256(toBytes(host.endpoint)));
    const reg = await readRegistry(hostId);
    if (!reg || !reg.active) return { hostId, ok: false, reason: "registry entry not active" };
    const q = await host.attest();
    // a host adapter may bring its own verifier (an Enclave Shield host's TPM session: availability/shield.mjs); the default
    // is the SEV-SNP quote verifier this witness was built with. Either returns the allowlisted measurement and the
    // hardware identity basis (chipId: the SNP chip id, or the Shield TPM's EK certificate sha256).
    const opts = { binding: q.binding, auxblob: q.auxblob, allowedMeasurements, minTcb };
    const v = await (typeof host.verify === "function" ? host.verify(q, opts) : verifyQuote(q.report, opts));
    if (!v.ok) return { hostId, ok: false, reason: `attestation: ${v.reason}` };
    if (!/^[0-9a-f]+$/i.test(String(v.chipId || "")) || typeof v.measurement !== "string") return { hostId, ok: false, reason: "attestation: no hardware identity" };
    const hardwareId = "0x" + sha(Buffer.from(v.chipId, "hex"));
    const a = await host.availability();
    const units = BigInt(Math.floor(Number(a.nodeGflops || 0))), spareUnits = BigInt(Math.max(0, Math.floor(Number(a.cpuGflopsFree || 0))));
    if (units <= 0n || units > maxUnits || spareUnits > units) return { hostId, ok: false, reason: `capacity out of bounds (${units} units, ${spareUnits} spare)` };
    const audit = await lastAudit(hardwareId);
    if (audit && audit.passed === false) return { hostId, ok: false, reason: "its most recent paid audit failed" };
    // continuous qualification per hardware id
    const prev = state.get(hardwareId);
    const since = prev && prev.hostId === hostId && t - BigInt(prev.lastSec) <= BigInt(receiptTtlSec) ? BigInt(prev.sinceSec) : t;
    state.set(hardwareId, { hostId, sinceSec: String(since), lastSec: String(t) });
    const minimumRate6 = units > 0n ? BigInt(reg.cpuPricePerSec6 || 0n) / units : 0n;
    const payload = { kind: "capacity", trustMode: "operator-bootstrap", classId, hostId, operator: lc(reg.operator), payoutWallet: lc(reg.payoutWallet),
                      hardwareId, measurement: v.measurement, evidence: String(q.evidence || "quote"), units: String(units), spareUnits: String(spareUnits), spareAtSec: String(t),
                      minimumRate6: String(minimumRate6), issuedSec: String(since), expiresSec: String(t + BigInt(receiptTtlSec)),
                      ...(audit && audit.passed ? { lastAuditSec: String(audit.atSec), lastAuditJob: audit.job } : {}) };
    const signature = await signer.signTypedData(receiptData(payload, { chainId, contract }));
    return { hostId, ok: true, envelope: { payload, signatures: [signature] } };
  }
  return {
    async round(hosts) {
      const receipts = [], refused = [];
      for (const h of hosts) {
        try { const r = await examine(h); if (r.ok) receipts.push(r.envelope); else { refused.push({ hostId: r.hostId, reason: r.reason }); } }
        catch (e) { refused.push({ endpoint: h.endpoint, reason: String(e.message).slice(0, 200) }); }
      }
      for (const r of refused) log(`[witness] no receipt for ${r.hostId || r.endpoint}: ${r.reason}`);
      return { receipts, refused };
    },
  };
}
