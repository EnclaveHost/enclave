// The release rules an owner writes into the vault (EnclaveSecretVault policy.rules) and every custodian enforces. Canonical
// JSON, parsed STRICTLY: an unknown key, platform or field is a refusal, never ignored, so a rule the custodians cannot
// enforce can never be written past them silently.
//
//   {
//     "v": 1,
//     "appId": "<64 hex>",                  report_data[32:64]: the AppID the measured front states for the code it loaded
//     "images": [                          the admitted (measurement, runtime) PAIRS; each a whole guest image
//       { "platform": "sev-snp", "measurement": "<96 hex>", "runtimeId": "<64 hex>" }
//     ],
//     "minTcb": { "Genoa": { "bootloader": 10, "tee": 0, "snp": 23, "microcode": 84 } },   REQUIRED: no default floor
//     "vmpl": 0,                            the VMPL the release report must come from
//     "ownerRead": true                     OPTIONAL, custody v2 only: the policy owner may read the values back
//   }                                       (custody/v2/custodian.mjs ownerRead). Missing means false: rules written
//                                           before this key existed never allow it, and encode to the same bytes.
//
// ONLY "sev-snp" is admitted: it is the one platform whose evidence this repository verifies end to end (VCEK -> ASK ->
// pinned ARK, ARK-signed CRL, TCB floor, DEBUG off). TDX has no verifier here; the Android pVM path pins Google's root but
// checks no revocation list; the Windows Shield path is not a TEE against its operator. They are refused by name.
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const TCB_FIELDS = {
  Milan: ["bootloader", "tee", "snp", "microcode"],
  Genoa: ["bootloader", "tee", "snp", "microcode"],
  Turin: ["fmc", "bootloader", "tee", "snp", "microcode"],
};
export const SUPPORTED_PLATFORMS = Object.freeze(["sev-snp"]);
const REFUSED_PLATFORMS = {
  "tdx": "Intel TDX: no TDX quote verifier exists in this repository",
  "avf-pvm": "Android pVM: the AVF verifier checks no attestation revocation list, and the pVM release client is not in this repository",
  "shield": "Enclave Shield (Hyper-V partitions) is not a TEE against its operator",
};
const MAX_IMAGES = 64;

const sortKeys = (x) => Array.isArray(x) ? x.map(sortKeys)
  : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])])) : x;
export const canonicalRules = (rules) => new TextEncoder().encode(JSON.stringify(sortKeys(validateRules(rules))));

function exactKeys(o, keys, what, optional = []) {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${what} must be an object`);
  for (const k of Object.keys(o)) if (!keys.includes(k) && !optional.includes(k)) throw new Error(`${what}: unknown key "${k}"`);
  for (const k of keys) if (!(k in o)) throw new Error(`${what}: "${k}" is required`);
}

export function validateRules(r) {
  exactKeys(r, ["v", "appId", "images", "minTcb", "vmpl"], "rules", ["ownerRead"]);
  if (r.ownerRead !== undefined && typeof r.ownerRead !== "boolean") throw new Error("rules.ownerRead must be true or false");
  if (r.v !== 1) throw new Error("rules: only version 1 exists");
  if (typeof r.appId !== "string" || !HEX(64).test(r.appId)) throw new Error("rules.appId must be 64 lowercase hex");
  if (!Number.isInteger(r.vmpl) || r.vmpl < 0 || r.vmpl > 3) throw new Error("rules.vmpl must be 0..3");
  if (!Array.isArray(r.images) || r.images.length === 0 || r.images.length > MAX_IMAGES) throw new Error(`rules.images: 1..${MAX_IMAGES} images`);
  const seen = new Set();
  for (const [i, im] of r.images.entries()) {
    if (im && REFUSED_PLATFORMS[im.platform]) throw new Error(`rules.images[${i}]: ${REFUSED_PLATFORMS[im.platform]}`);
    exactKeys(im, ["platform", "measurement", "runtimeId"], `rules.images[${i}]`);
    if (!SUPPORTED_PLATFORMS.includes(im.platform)) throw new Error(`rules.images[${i}]: unknown platform "${im.platform}"`);
    if (typeof im.measurement !== "string" || !HEX(96).test(im.measurement)) throw new Error(`rules.images[${i}].measurement must be 96 lowercase hex`);
    if (typeof im.runtimeId !== "string" || !HEX(64).test(im.runtimeId)) throw new Error(`rules.images[${i}].runtimeId must be 64 lowercase hex`);
    const k = `${im.platform}/${im.measurement}/${im.runtimeId}`;
    if (seen.has(k)) throw new Error(`rules.images[${i}] repeats an image`);
    seen.add(k);
  }
  if (!r.minTcb || typeof r.minTcb !== "object" || Array.isArray(r.minTcb) || !Object.keys(r.minTcb).length) throw new Error("rules.minTcb must name at least one product line");
  for (const [line, f] of Object.entries(r.minTcb)) {
    const fields = TCB_FIELDS[line];
    if (!fields) throw new Error(`rules.minTcb: unknown product line "${line}"`);
    exactKeys(f, fields, `rules.minTcb.${line}`);
    for (const k of fields) if (!Number.isInteger(f[k]) || f[k] < 0 || f[k] > 255) throw new Error(`rules.minTcb.${line}.${k} must be 0..255`);
  }
  return r;
}

// the bytes on chain -> rules; the custodian refuses a release when this throws
export function parseRules(bytes) {
  const s = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let o;
  try { o = JSON.parse(s); } catch { throw new Error("rules are not JSON"); }
  return validateRules(o);
}

// the measurements a guest stating `runtimeIdHex` may run in, for the SNP platform
export const admittedMeasurements = (rules, runtimeIdHex) =>
  rules.images.filter((im) => im.platform === "sev-snp" && im.runtimeId === runtimeIdHex).map((im) => im.measurement);

// the platform's SNP TCB floors (verifier/metal-box.mjs TCB_FLOORS; test/custody-cli.test.mjs pins them equal)
export const DEFAULT_MIN_TCB = Object.freeze({
  Genoa: Object.freeze({ bootloader: 10, tee: 0, snp: 23, microcode: 84 }),
  Turin: Object.freeze({ fmc: 1, bootloader: 3, tee: 2, snp: 5, microcode: 117 }),
});

// rules from the relay's PUBLIC prediction (GET /v1/expected-guest): the AppID and the admitted (measurement, runtime) pairs
// for the deployment's current catalog version. The prediction is reproducible from the chain and the pinned domain
// releases; an owner who signs it into the policy is admitting it, and the CLI and the site both say so.
export function rulesFromPrediction(pred, minTcb = DEFAULT_MIN_TCB) {
  if (!pred || !/^[0-9a-f]{64}$/.test(String(pred.appId)) || !Array.isArray(pred.images)) throw new Error("the relay gave no usable prediction");
  const images = pred.images.filter((i) => i.releaseAdmitted).map((i) => ({ platform: "sev-snp", measurement: i.measurement, runtimeId: i.runtimeId }));
  if (!images.length) throw new Error("the relay's prediction admits no image for this deployment");
  return validateRules({ v: 1, appId: pred.appId, images, minTcb: JSON.parse(JSON.stringify(minTcb)), vmpl: 0 });
}
// the owner-read opt-in (SNP or Shield rules alike): only an explicit true
export const ownerReadAllowed = (rules) => !!rules && rules.ownerRead === true;
