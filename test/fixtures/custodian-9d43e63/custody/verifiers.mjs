// The platform verifiers a custodian consults, keyed by evidence format. The production table has exactly ONE entry: an AMD
// SEV-SNP guest-domain document, judged by the repository's own verifier (verifier/consumer.mjs -> verifier/snp.mjs): the
// VCEK -> ASK -> ARK chain against AMD's PINNED roots, the ARK-signed CRL (required, never stale), the TCB floor applied to
// the reported AND committed TCB, guest policy DEBUG and MIGRATE_MA off, the VMPL, the admitted measurement, report_data
// [0:32] = the custody binding, report_data[32:64] = the rules' AppID, and HOST_DATA = the deployment id.
//
// Any other format (TDX, AVF/pVM, VBS/Shield, anything unknown) is not in the table, so the custodian refuses it as
// "unsupported_evidence". Nothing here downgrades.
//
// TEST HOOK, and the only one: snpVerifier({ roots }) replaces AMD's pinned roots with a SYNTHETIC chain's (test/helpers/
// snp-synth.mjs). productionVerifiers() never passes it, the custodian daemon (custody/custodian-daemon.mjs) has no option
// that reaches it, and a verifier built with it says so in every verdict ("synthetic roots").
import { verifyGuestDomainEvidence } from "../verifier/consumer.mjs";

export const SNP_GUEST_FORMAT = "sev-snp-guest-domain-v1";
export const SNP_GUEST_ABI = "enclave-domain-abi/2";

// the report fields the custodian re-reads itself after the verifier has checked the signature (belt and braces)
export function reportFields(report) {
  const r = Buffer.from(report);
  if (r.length < 0x2a0) throw new Error("report too short");
  return { policy: r.readBigUInt64LE(0x08), vmpl: r.readUInt32LE(0x30), signingKey: (r.readUInt32LE(0x48) >> 2) & 0x7,
           reportData: r.subarray(0x50, 0x90), measurement: r.subarray(0x90, 0xc0), hostData: r.subarray(0xc0, 0xe0), chipId: r.subarray(0x1a0, 0x1e0) };
}

export function snpVerifier({ collateral, roots = undefined, now = () => new Date() }) {
  if (!collateral) throw new Error("snpVerifier: an AMD collateral adapter is required");
  const synthetic = roots !== undefined;
  return async function verifySnpGuest({ doc, allowedMeasurements, minTcb, vmpl, binding, appId, hostData }) {
    if (!doc || doc.format !== SNP_GUEST_FORMAT || doc.abi !== SNP_GUEST_ABI || typeof doc.report !== "string" || typeof doc.transportKey !== "string")
      return { ok: false, reason: `evidence must be a ${SNP_GUEST_FORMAT} document stating abi ${SNP_GUEST_ABI}, its report and transport key` };
    if (doc.nonce !== undefined) return { ok: false, reason: "a custody release document must not state a nonce (the challenges are bound in report_data)" };
    const v = await verifyGuestDomainEvidence(doc, {
      policy: { snp: { allowedMeasurements, minTcb, expectedVmpl: vmpl, ...(synthetic ? { roots } : {}) } },
      context: { transportKeySpki: Buffer.from(doc.transportKey, "base64"), expectedBinding: Buffer.from(binding), expectedAppId: Buffer.from(appId),
                 expectedHostData: Buffer.from(hostData), now: now().toISOString() },
      collateral });
    if (!v || v.status !== "verified") return { ok: false, reason: (v && v.reasons && v.reasons.at(-1)) || "the SNP verifier gave no verdict" };
    let f;
    try { f = reportFields(Buffer.from(doc.report, "base64")); } catch (e) { return { ok: false, reason: e.message }; }
    const why = f.signingKey !== 0 ? "the report is not VCEK-signed"
      : (f.policy >> 19n) & 1n ? "the guest policy allows DEBUG"
      : f.vmpl !== vmpl ? `the report states VMPL ${f.vmpl}, not ${vmpl}`
      : !allowedMeasurements.includes(f.measurement.toString("hex")) ? "the measurement is not admitted"
      : !f.reportData.subarray(0, 32).equals(Buffer.from(binding)) ? "report_data[0:32] is not this release's binding"
      : !f.reportData.subarray(32, 64).equals(Buffer.from(appId)) ? "report_data[32:64] is not the admitted app"
      : !f.hostData.equals(Buffer.from(hostData)) ? "HOST_DATA is not this deployment"
      : !f.chipId.some((x) => x !== 0) ? "the report's CHIP_ID is masked"
      : null;
    if (why) return { ok: false, reason: why };
    return { ok: true, synthetic, measurement: f.measurement.toString("hex"), chipId: f.chipId.toString("hex"), product: v.claims && v.claims.product };
  };
}

export const productionVerifiers = ({ collateral }) => Object.freeze({ [SNP_GUEST_FORMAT]: snpVerifier({ collateral }) });
