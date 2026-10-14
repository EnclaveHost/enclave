// verifier/consumer.mjs: the production consumers' entry into this verifier (the CLI's `enclave attest`, the relay's
// release-document judgement). It composes what already exists and adds nothing to the verdict rules:
//   - an attached metal box reached through the relay (verifyMetalBox, verifier/metal-box.mjs): a FRESH document over the
//     caller's own nonce, the AMD chain and TCB floor, and the measurement against a caller pin or, labelled as such, the
//     relay operator's allowlist;
//   - a per-app guest's release document for the relay (verifyGuestDomainEvidence), and the collateral that judgement will
//     need, fetched before a ticket is consumed (prewarmSnpCollateral);
//   - the verdict from verifier/snp.mjs through the same envelope registry as the harness: a format this verifier does not
//     judge (TDX, GPU, VBS, Hyper-V, anything unknown) is "unsupported", never green.
// Everything network-bound is bounded (timeouts, byte caps); nothing is cached here (verifier/collateral-cache.mjs is the
// caller's choice of collateral adapter); nothing is written.
import { createHash, randomBytes } from "node:crypto";
import { parseEnvelope, EnvelopeError, FORMATS, TECH } from "./envelope.mjs";
import { verifySnp, parseReportStrict } from "./snp.mjs";
import { httpCollateral, fileCollateral, memoryCollateral, layeredCollateral } from "./collateral.mjs";
import { cachedCollateral } from "./collateral-cache.mjs";
export { httpCollateral, fileCollateral, memoryCollateral, layeredCollateral, cachedCollateral };
import { kdsVcekUrl } from "../relay/snp-verify.mjs";
import { verifyMetalBoxWith, TCB_FLOORS, FRESH_ATTESTATION_PATH, OPERATOR_STATED } from "./metal-box.mjs";
export { TCB_FLOORS, FRESH_ATTESTATION_PATH, OPERATOR_STATED };

// The attested-release relay's judgement of a per-app guest's release document (relay/secrets-release.mjs, ctx
// verifyGuestEvidence): the SNP domain path only, exactly verifier/index.mjs verifyEvidence's SNP branch, so the relay (which
// ships relay/** only) runs the same verdict as the harness. Anything but sev-snp-guest-domain-v1 is "unsupported", never
// green; a malformed envelope is "rejected".
export async function verifyGuestDomainEvidence(doc, { policy = {}, context = {}, collateral = null } = {}) {
  let env;
  try { env = parseEnvelope(doc); }
  catch (e) {
    if (!(e instanceof EnvelopeError)) throw e;
    return { status: e.code === "unsupported" ? "unsupported" : "rejected", admissionSafe: false, omissions: [], technology: FORMATS[doc?.format]?.technology ?? null,
             reasons: [`${e.code.toUpperCase()}: ${e.message}`], checks: {}, claims: null };
  }
  if (env.spec.technology !== TECH.SNP || env.format !== "sev-snp-guest-domain-v1")
    return { status: "unsupported", admissionSafe: false, omissions: [], technology: env.spec.technology, reasons: [`UNSUPPORTED: a release document is sev-snp-guest-domain-v1, not ${env.format}`], checks: {}, claims: null };
  return { technology: env.spec.technology, ...(await verifySnp(env, policy.snp || {}, context, collateral)) };
}

// Before a relay CONSUMES a release ticket (relay/secrets-release.mjs): the AMD collateral this report will need (its VCEK,
// the product's ASK/ARK chain, the CRL), fetched through the SAME adapter verifyGuestDomainEvidence will use, so a KDS or
// CRL outage is answered 503 with the ticket kept rather than a 403 that burns it (enclave-d1). It judges NOTHING: the
// unverified report is parsed only to name the product, chip and TCB (exactly as verifySnp keys the VCEK), and anything it
// cannot parse is left to the verifier ({ ok: true, skipped }). A CRL the adapter marks stale counts as missing: the
// verifier's default policy allows no staleness.
export async function prewarmSnpCollateral(doc, collateral) {
  if (!collateral) return { ok: true, skipped: "no collateral adapter" };
  let p;
  try { p = parseReportStrict(parseEnvelope(doc).body); } catch { return { ok: true, skipped: "unparseable (the verifier refuses it)" }; }
  const product = p.productHint;
  if (!product) return { ok: true, skipped: "the report names no product line (the verifier refuses it)" };
  const missing = [];
  try {
    const v = await collateral.vcek(product, hex(p.chipId), hex(p.reportedTcb), kdsVcekUrl(product, p).replace(/^https:\/\/[^/]+\//, ""));
    if (!v || !v.der) missing.push("vcek");
  } catch (e) { missing.push(`vcek (${e.message})`); }
  try { const c = await collateral.chain(product); if (!c || !c.pem) missing.push("chain"); } catch (e) { missing.push(`chain (${e.message})`); }
  if (typeof collateral.crl === "function") {
    try { const c = await collateral.crl(product); if (!c || !c.der) missing.push("crl"); else if (c.stale === true) missing.push("crl (stale)"); }
    catch (e) { missing.push(`crl (${e.message})`); }
  }
  return missing.length ? { ok: false, product, missing } : { ok: true, product };
}

const hex = (b) => Buffer.from(b).toString("hex");
const unsupported = (technology, why) => ({ status: "unsupported", admissionSafe: false, omissions: [], technology, reasons: [`UNSUPPORTED: ${why}`], checks: {}, claims: null });

// An attached METAL box through the relay (the CLI's `enclave attest`; verifier/metal-box.mjs has the rules) ------
// apiBase: the relay that holds the box's tunnel; expected: { measurements: [hex96], source } to pin what must run (else the
// relay operator's allowlist, and the verdict stays "limited"); collateral: AMD KDS directly unless the caller passes one.
export async function verifyMetalBox({ apiBase = "https://api.enclave.host", name, expected = null, minTcb = undefined, collateral = null, timeoutMs = 20000, fetchImpl = globalThis.fetch, now = undefined } = {}) {
  const verify = async (doc, { policy, context, collateral: c }) => {
    let env;
    try { env = parseEnvelope(doc); }
    catch (e) { if (!(e instanceof EnvelopeError)) throw e; return { status: e.code === "unsupported" ? "unsupported" : "rejected", admissionSafe: false, omissions: [], reasons: [`${e.code.toUpperCase()}: ${e.message}`], checks: {}, claims: null }; }
    if (env.spec.technology !== TECH.SNP) return unsupported(env.spec.technology, `${env.format} is not SEV-SNP evidence`);
    return { technology: TECH.SNP, ...(await verifySnp(env, policy.snp || {}, context, c)) };
  };
  return verifyMetalBoxWith({ fetchImpl, verify, collateral: collateral ?? httpCollateral({ timeoutMs }),
                              randomBytes: (n) => new Uint8Array(randomBytes(n)), sha256: async (b) => new Uint8Array(createHash("sha256").update(b).digest()),
                              toBytes: (u) => Buffer.from(u), now: now ? () => new Date(now) : undefined },
                            { apiBase, name, expected, minTcb, timeoutMs });
}
