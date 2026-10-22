// Owner-committed custody rules that admit an Android protected VM (AVF pVM, pKVM) as a release recipient. A DISTINCT rule
// format, written by the owner into the vault policy (EnclaveSecretVault policy.rules) in place of the SNP rules
// (custody/rules.mjs), on the Enclave Shield precedent (custody/v2/shield-rules.mjs). The formats never stand in for each
// other:
//   - custody/rules.mjs (unchanged) refuses this object (its exact keys are v, appId, images, minTcb, vmpl) and still refuses
//     the platform "avf-pvm" by name inside SNP rules, so default and SEV-SNP rules never admit AVF evidence;
//   - this parser refuses SNP and Shield rules (no or another format, no acknowledgement);
//   - the custodian uses this parser ONLY for an evidence document of the AVF custody format, and only when its operator
//     installed the AVF adapter (custody/v2/avf-evidence.mjs; custodian.mjs `avf`).
//
//   {
//     "format": "enclave-custody-avf-rules/1",
//     "acceptTier": "android-avf-pvm/pkvm/google-rkp/revocation-checked",   the owner's explicit acknowledgement, exactly
//     "appId": "<64 hex>",                       challenge[32:64]: the component the measured payload loaded
//     "images": [ { "codeHash": "<64 hex>",      the SIGNED APK's fs-verity Merkle root (the AVF codeHash)
//                   "authorityHash": "<128 hex>", SHA-512 of the APK's signing certificate (the AVF authorityHash)
//                   "runtimeId": "<64 hex>" } ], the admitted (APK, runtime) PAIRS
//     "instances": [ "<64 hex>" ],               optional: only these VM instances (InstanceID = SHA-256 of the instance
//                                                key's SPKI, INSTANCE-BINDING.md); absent = any instance of an admitted APK
//     "ownerRead": true                          optional: the policy owner may read the values back; missing = false
//   }
// What the acknowledgement means: the phone's Android host is EXCLUDED (pKVM keeps it out of the VM's memory); the device
// vendor's firmware, pKVM and Google's remote key provisioning are TRUSTED; the custodian checks Google's attestation status
// list (revocation) itself on every release and refuses when it cannot. An owner who commits these rules accepts that.
export const AVF_RULES_FORMAT = "enclave-custody-avf-rules/1";
export const AVF_TIER_ACK = "android-avf-pvm/pkvm/google-rkp/revocation-checked";
const HEX64 = /^[0-9a-f]{64}$/, HEX128 = /^[0-9a-f]{128}$/;
const MAX_IMAGES = 64, MAX_INSTANCES = 64;

function exactKeys(o, keys, optional, what) {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${what} must be an object`);
  for (const k of Object.keys(o)) if (!keys.includes(k) && !optional.includes(k)) throw new Error(`${what}: unknown key "${k}"`);
  for (const k of keys) if (!(k in o)) throw new Error(`${what}: "${k}" is required`);
}

export function validateAvfRules(r) {
  exactKeys(r, ["format", "acceptTier", "appId", "images"], ["instances", "ownerRead"], "AVF rules");
  if (r.format !== AVF_RULES_FORMAT) throw new Error(`AVF rules: format must be ${AVF_RULES_FORMAT}`);
  if (r.acceptTier !== AVF_TIER_ACK) throw new Error(`AVF rules: acceptTier must be exactly "${AVF_TIER_ACK}" (the owner's acknowledgement of this tier)`);
  if (typeof r.appId !== "string" || !HEX64.test(r.appId)) throw new Error("AVF rules: appId must be 64 lowercase hex");
  if (r.ownerRead !== undefined && typeof r.ownerRead !== "boolean") throw new Error("AVF rules: ownerRead must be true or false");
  if (!Array.isArray(r.images) || !r.images.length || r.images.length > MAX_IMAGES) throw new Error(`AVF rules: images: 1..${MAX_IMAGES}`);
  const seen = new Set();
  for (const [i, im] of r.images.entries()) {
    exactKeys(im, ["codeHash", "authorityHash", "runtimeId"], [], `AVF rules images[${i}]`);
    if (typeof im.codeHash !== "string" || !HEX64.test(im.codeHash)) throw new Error(`AVF rules images[${i}].codeHash must be 64 lowercase hex`);
    if (typeof im.authorityHash !== "string" || !HEX128.test(im.authorityHash)) throw new Error(`AVF rules images[${i}].authorityHash must be 128 lowercase hex`);
    if (typeof im.runtimeId !== "string" || !HEX64.test(im.runtimeId)) throw new Error(`AVF rules images[${i}].runtimeId must be 64 lowercase hex`);
    const k = `${im.codeHash}/${im.authorityHash}/${im.runtimeId}`;
    if (seen.has(k)) throw new Error(`AVF rules images[${i}] repeats an image`);
    seen.add(k);
  }
  if (r.instances !== undefined) {
    if (!Array.isArray(r.instances) || !r.instances.length || r.instances.length > MAX_INSTANCES) throw new Error(`AVF rules: instances, when present: 1..${MAX_INSTANCES}`);
    const s = new Set();
    for (const [i, x] of r.instances.entries()) {
      if (typeof x !== "string" || !HEX64.test(x)) throw new Error(`AVF rules instances[${i}] must be 64 lowercase hex`);
      if (s.has(x)) throw new Error(`AVF rules instances[${i}] repeats an instance`);
      s.add(x);
    }
  }
  return r;
}

/** the bytes on chain -> AVF rules; throws for anything else, SNP and Shield rules included */
export function parseAvfRules(bytes) {
  const s = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let o;
  try { o = JSON.parse(s); } catch { throw new Error("rules are not JSON"); }
  return validateAvfRules(o);
}

const sortKeys = (x) => Array.isArray(x) ? x.map(sortKeys)
  : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])])) : x;
export const canonicalAvfRules = (rules) => new TextEncoder().encode(JSON.stringify(sortKeys(validateAvfRules(rules))));

/** the admitted (codeHash, authorityHash) pairs for a guest stating `runtimeIdHex` */
export const avfAdmittedImages = (rules, runtimeIdHex) => rules.images.filter((im) => im.runtimeId === runtimeIdHex)
  .map((im) => ({ codeHash: im.codeHash, authorityHash: im.authorityHash }));
