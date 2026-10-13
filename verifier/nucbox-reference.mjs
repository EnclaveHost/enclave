// verifier/nucbox-reference.mjs: the reference values a NucBox paravisor VM report will be judged against (checks V3 and V4
// of docs/security/nucbox-custom-vm-verifier.md), from enclave-53's package file, PINNED by commit and hash
// (verifier/pins/nucbox-vbs-reference.json, verifier/pins/SOURCES.json), never retyped. No report format exists yet, so no
// verdict uses this: it derives, fail closed, the one thing a verifier may ever do with these values, the set of EXACT
// vbsBootDigests that may be accepted.
//
// The rule (enclave-53, measured on three images, 2026-09-25): refuse by exact digest only. `debugBuild` follows the
// manifest's enable_debug and is false for --confidential-debug images too, so it is NEVER read here; `confidentialDebug`
// is read from the image bytes by the package and means the image trusts the host's command line. An entry is eligible
// only when the file says so AND it is a candidate that neither carries confidential debug nor trusts the host's command
// line; a file that marks anything else eligible, marks two images eligible, marks a superseded image eligible, repeats a
// digest or has another type is refused outright (throws): an inconsistent reference is a defect to fix at its source, not
// to interpret. A clean candidate may be listed eligible:false with a reason (a new candidate before its own canary).
export const REFERENCE_TYPE = "enclave-nucbox-vbs-reference/1";
const DIGEST = /^[0-9A-Fa-f]{64}$/;

export function eligibleDigestsOf(ref) {
  if (!ref || typeof ref !== "object" || ref.type !== REFERENCE_TYPE) throw new Error(`reference: type must be ${REFERENCE_TYPE}`);
  if (!Array.isArray(ref.images) || !ref.images.length) throw new Error("reference: images[] missing");
  const eligible = new Map(), refused = new Map(), seen = new Set();
  const take = (e, where) => {
    const d = String(e && e.vbsBootDigest || "");
    if (!DIGEST.test(d)) throw new Error(`reference: ${where} ${e && e.id}: vbsBootDigest is not 32 bytes of hex`);
    const key = d.toUpperCase();
    if (seen.has(key)) throw new Error(`reference: digest ${key.slice(0, 16)}... appears twice`);
    seen.add(key); return key;
  };
  for (const img of ref.images) {
    const key = take(img, "image");
    if (typeof img.eligible !== "boolean" || typeof img.confidentialDebug !== "boolean" || typeof img.trustsHostCommandLine !== "boolean") throw new Error(`reference: image ${img.id}: eligible, confidentialDebug and trustsHostCommandLine must be booleans`);
    const clean = img.class === "candidate" && img.confidentialDebug === false && img.trustsHostCommandLine === false;
    if (img.eligible && !clean) throw new Error(`reference: image ${img.id} is marked eligible but is ${img.class}${img.confidentialDebug ? ", confidential-debug" : ""}${img.trustsHostCommandLine ? ", trusting the host's command line" : ""}: refusing the file`);
    if (img.eligible) eligible.set(key, { id: img.id, imageSha256: String(img.imageSha256 || "").toLowerCase(), vbsIsvsvn: img.vbsIsvsvn ?? null, booted: img.booted ?? null });
    else refused.set(key, { id: img.id, class: img.class, reason: img.reason || "not eligible" });
  }
  // ONE eligible digest at a time (agreed with enclave-63, 2026-09-25): a new candidate is listed eligible:false ("not booted
  // yet") until its own canary boots and serves, and the version that flips it supersedes the previous one in the same
  // change. Two eligible entries mean a rollover left half done: refused, so the mistake is loud rather than an allowlist.
  if (eligible.size > 1) throw new Error(`reference: ${eligible.size} images are marked eligible (${[...eligible.values()].map((e) => e.id).join(", ")}): exactly one at a time`);
  for (const old of Array.isArray(ref.superseded) ? ref.superseded : []) {
    const key = take(old, "superseded");
    if (old.eligible !== false) throw new Error(`reference: superseded ${old.id} must say eligible:false`);
    refused.set(key, { id: old.id, class: "superseded", reason: old.reason || "superseded" });
  }
  return { eligible, refused };
}
