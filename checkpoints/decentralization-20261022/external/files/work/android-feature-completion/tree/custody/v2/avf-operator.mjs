// A custodian OPERATOR's opt-in to Android pVM release recipients (custody/v2/avf-evidence.mjs), as MEASURED configuration:
// scripts/build-custodian-v2.mjs --avf-recipients <file> validates it here and bakes it into the bundle's MEASURED constant
// (custody/v2/build-config.mjs), and the daemon validates it again here before it installs the adapter (custody/v2/daemon.mjs).
// Absent by default, and then the custodian refuses AVF evidence exactly as before ("unsupported_evidence").
//
// It is never read from the host. It carries no roots: Google's attestation roots are pinned in relay/avf-verify.mjs, and
// the revocation list is fetched by this custodian itself from Google's fixed URL (custody/v2/avf-status.mjs).
//
//   {
//     "format":     "enclave-custody-avf-operator/1",
//     "acceptTier": "android-avf-pvm/pkvm/google-rkp/revocation-checked",   the OPERATOR's explicit acknowledgement (each
//                                                                           owner still commits its own, in its AVF rules)
//     "limits": { "statusMaxAgeSec", "statusTimeoutSec" }
//   }
import { createAvfCustody } from "./avf-evidence.mjs";
import { createAvfStatusList, GOOGLE_ATTESTATION_STATUS_URL } from "./avf-status.mjs";
import { AVF_TIER_ACK } from "./avf-rules.mjs";

export const AVF_OPERATOR_FORMAT = "enclave-custody-avf-operator/1";
export const AVF_OPERATOR_TIER_ACK = AVF_TIER_ACK;
// [min, max, default]
export const AVF_LIMITS = Object.freeze({
  statusMaxAgeSec: Object.freeze([3600, 86400, 86400]),
  statusTimeoutSec: Object.freeze([5, 60, 15]),
});
export const defaultAvfLimits = () => Object.fromEntries(Object.entries(AVF_LIMITS).map(([k, v]) => [k, v[2]]));

function exactKeys(o, keys, what) {
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${what} must be an object`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`${what}: unknown key "${k}"`);
  for (const k of keys) if (!(k in o)) throw new Error(`${what}: "${k}" is required`);
}

/** -> the same object, normalized and frozen (throws on anything else). Shared by the build and the daemon. */
export function validateAvfOperator(cfg) {
  exactKeys(cfg, ["format", "acceptTier", "limits"], "AVF recipients");
  if (cfg.format !== AVF_OPERATOR_FORMAT) throw new Error(`AVF recipients: format must be ${AVF_OPERATOR_FORMAT}`);
  if (cfg.acceptTier !== AVF_OPERATOR_TIER_ACK)
    throw new Error(`AVF recipients: acceptTier must be exactly "${AVF_OPERATOR_TIER_ACK}" (the operator's acknowledgement of this tier)`);
  exactKeys(cfg.limits, Object.keys(AVF_LIMITS), "AVF recipients limits");
  for (const [k, [min, max]] of Object.entries(AVF_LIMITS)) {
    const v = cfg.limits[k];
    if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error(`AVF recipients limits.${k} must be an integer in ${min}..${max}`);
  }
  return Object.freeze({ format: cfg.format, acceptTier: cfg.acceptTier,
                         limits: Object.freeze(Object.fromEntries(Object.keys(AVF_LIMITS).map((k) => [k, cfg.limits[k]]))) });
}

/**
 * The daemon's adapter: null when the measured config has no AVF recipients (the default). The status list is Google's,
 * at its fixed URL, fetched with the daemon's own fetch (TLS in this guest).
 */
export function avfCustodyFor(measuredAvf, { fetchImpl = globalThis.fetch, now = Date.now, log = () => {} } = {}) {
  if (measuredAvf === undefined || measuredAvf === null) return null;
  const cfg = validateAvfOperator(measuredAvf);
  const statusList = createAvfStatusList({ url: GOOGLE_ATTESTATION_STATUS_URL, fetchImpl, now, log,
    maxAgeMs: cfg.limits.statusMaxAgeSec * 1000, timeoutMs: cfg.limits.statusTimeoutSec * 1000 });
  const adapter = createAvfCustody({ statusList, now });
  return Object.freeze({ ...adapter, statusList, limits: cfg.limits });
}
