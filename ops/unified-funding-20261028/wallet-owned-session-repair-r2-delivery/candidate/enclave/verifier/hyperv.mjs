// verifier/hyperv.mjs: a NucBox Shield partition's document, format "hyperv-partition-domain/v1" (the custom type-1 path: one
// Hyper-V partition per app, our measured OpenHCL paravisor and guest). Delegated, as AVF is: every check is the relay's own
// (relay/shield-app-policy.mjs -> relay/vbs-app-verify.mjs -> relay/hvnode-verify.mjs + relay/vbs-vm-report.mjs), called here and
// never restated, so this verifier and the relay cannot judge the same bytes differently.
//
// Two documents carry this format:
//   launcher-only    `report` is a statement the launcher in the root partition signed (tier T0-hv). Nothing in it has a
//                    hardware root -> "unsupported" (windows/vbslike/verify/judge-hv.mjs judges that signature, and only that).
//   with vbsVmReport the guest monitor also attached the paravisor's VBS VM report (isolation/m3, 2026-09-29) -> judged here.
//
// "verified" proves, and only proves: a host whose AMD firmware TPM measured a production boot (EK chain to a pinned root, the
// caller's credential round, a quote over the caller's nonce, log replay, Secure Boot on, test signing off, an EK certificate and
// PCR0 the policy pins as a pair) signed, with that boot's VSM IDKS key, a VBS report for a partition launched from a pinned image
// (paired with the runtime it runs), debug off, whose guest bound the TLS key this connection presented, this verifier's nonce,
// the runtime identity and the expected app (Bind2 || AppID in the report's 64 bytes of guest input).
//
// It never proves host exclusion. The Windows hypervisor, secure kernel and boot chain, and anyone with physical access, stay
// trusted, and partition memory is not encrypted: every verdict says hostExcluded:false and teeCpu:null, and the consumer gate
// (verifier/admission.mjs) has no rule that releases on this technology.
//
// The host half is interactive. The report's signing key is trusted only through a host boot session: a nonce and a TPM
// credential (relay/vbs-credential.mjs makeCredential) for the node's EK and quoting key, both chosen by whoever ran it. This
// module cannot tell who ran the session it is handed, so a caller passes only one it ran itself; a session recorded by someone
// else proves only what that party saw. A capture-mode session (no possession) is refused. Today only the relay's hv-node attach
// runs such a session: no node endpoint offers one to anyone else yet.
//
//   policy:  the Shield app policy, { schema: "enclave-shield-app-policy/1", ekRoots, platforms: [{ ekCertSha256, pcr0 }],
//            images: [{ measurement, runtimeId }], minimumGuestSvn? } (relay/shield-app-policy.mjs). No defaults: empty refuses.
//   context: { transportKeySpki (the peer key of the caller's own TLS connection), nonce (32 bytes, sent with the request),
//              expectedAppId (32 bytes), expectedRuntimeId (32 bytes), hostSession: { evidence, nonce, transportKeySpki,
//              expectedCredential, mintedFor: { ekCert, aikName } } }
// Certificate validity in the host session is judged at the wall clock: the relay's module takes no clock input.
import { verifyShieldAppPolicy } from "../relay/shield-app-policy.mjs";
import { TECH } from "./envelope.mjs";

export const HYPERV_TRUST = "the Windows hypervisor, secure kernel and boot chain of a measured Secure Boot host (AMD firmware TPM): the host is NOT excluded, and partition memory is not encrypted";
const CHECK = "shield app policy";
const hex = (b) => Buffer.from(b).toString("hex");
const bytes = (b, n) => Buffer.isBuffer(b) && b.length === n;

export function verifyHyperV(env, policy = {}, context = {}) {
  const out = (status, reasons, checks = {}, claims = null) => ({ status, admissionSafe: status === "verified", omissions: [], reasons, checks, claims });
  const reject = (why, checks = {}) => out("rejected", [`REJECT: ${why}`], checks);
  let report;
  try { report = JSON.parse(env.body.toString("utf8")); } catch { return reject("the partition report is not JSON"); }
  if (!report || typeof report !== "object" || Array.isArray(report)) return reject("the partition report is not a JSON object");
  if (!("vbsVmReport" in report))
    return out("unsupported", ["UNSUPPORTED: launcher-signed only: this document carries no guest VBS report, just a statement the launcher in the root partition signed (judged by windows/vbslike/verify/judge-hv.mjs against the launcher key); nothing in it has a hardware root"]);

  const { transportKeySpki: spki, nonce, expectedAppId, expectedRuntimeId, hostSession } = context;
  if (!Buffer.isBuffer(spki) || spki.length < 32 || spki.length > 4096) return reject("no transport key SPKI from the verifier's own handshake: the binding cannot be checked (never skipped)");
  if (!bytes(nonce, 32)) return reject("needs the verifier's 32-byte nonce");
  if (!bytes(expectedAppId, 32)) return reject("needs the expected app id (32 bytes)");
  if (!bytes(expectedRuntimeId, 32)) return reject("needs the expected runtime id (32 bytes): the runtime half of an image pair the caller admits");
  if (!hostSession || typeof hostSession !== "object") return reject("needs a host boot session the caller ran itself (its own nonce and TPM credential): without one the VBS report's signing key is unauthenticated");
  if (hostSession.capture) return reject("a recorded (capture-mode) host session proves no possession and never authenticates the report's signing key");

  const v = verifyShieldAppPolicy({ doc: env.doc, handshakeSpki: spki, nonce, expectedAppSha256: hex(expectedAppId), expectedRuntimeId: hex(expectedRuntimeId), hostSession }, policy);
  if (!v.ok) return reject(v.reason, { [CHECK]: false });
  return out("verified", [
    "host boot: the caller's TPM session verifies (EK chain to a pinned root, credential round, quote over the session nonce, log replay, Secure Boot on, test signing off), and its EK certificate and PCR0 are a pair the policy pins",
    `VBS report: signed by that boot's IDKS key (from the authenticated log), debug off, launch measurement ${v.measurement.slice(0, 16)}... paired with runtime ${v.runtimeId.slice(0, 16)}... in the policy`,
    "binding: the report's guest input is Bind2(this connection's TLS key, this verifier's nonce, the runtime identity) || the expected app",
    `scope: ${v.scope}; NOT host-excluded (trusted: ${HYPERV_TRUST})`,
  ], { [CHECK]: true }, {
    technology: TECH.HYPERV, family: "domain", format: env.format, abi: env.doc.abi, measurement: v.measurement, appId: v.appSha256, runtimeId: v.runtimeId,
    transportSpkiSha256: v.spkiSha256, freshness: "verifier nonce", hostExcluded: false, teeCpu: null, trust: HYPERV_TRUST, boot: v.boot,
  });
}
