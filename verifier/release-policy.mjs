// verifier/release-policy.mjs: the reviewed release policy, compiled in. verifier/release-policy.json is the ONE source of
// the release floor and the revocation list: the release workflow signs it into every release index (verifier/release-
// index.mjs build, at the tag), and every consumer built from this tree carries the same file as its BUILT-IN policy
// (verifier/provenance.mjs DEFAULT_RELEASE_POLICY, the Node bundle, the browser bundle: each bundle's MANIFEST lists the
// file with its sha256, so the built-in floor of a shipped bundle is reproducible from the tree it was built from).
//
// The rules a consumer applies, stated once here and used by the Node consumer (verifier/consumer.mjs) and the browser
// (verifier/web/provenance.mjs) alike:
//   * the floor applied is the HIGHEST of: the built-in floor (this file), the consumer's remembered floor (its index
//     memory), and a verified index's floor; nothing fetched can lower it. An index whose floor is below the built-in one is
//     refused outright (verifier/release-index-core.mjs checkIndex), a remembered floor above an index's is a floor
//     regression (verifier/index-memory.mjs), and a mirror's own fields are never read.
//   * a CALLER may pass an explicit floor (the offline CLI's --min-release, the tests); it replaces the built-in one and the
//     result says so (`floorSource: "caller"`, `builtinFloor` beside it), so a lower floor is never silent.
//   * revocations only accumulate: the built-in list, the caller's and a verified index's are UNITED; none can undo another.
// Raising the floor is a reviewed commit to the JSON file, rebuilt into the bundles in the same commit (the reproduce
// checks refuse a stale bundle). Until a release built from that commit publishes an index carrying the new floor,
// consumers built from it refuse the older index as below their floor and take their RECORDED fallback (the unsigned
// pointer under the raised floor in Node, the labelled primary measurement in the browser shadow): a raise is safe to
// ship before its release, and the window closes with the next release. No Node module: this runs in the browser build.
import POLICY_FILE from "./release-policy.json" with { type: "json" };

export const POLICY_SCHEMA = "enclave-release-policy/v1";
export const POLICY_FILE_PATH = "verifier/release-policy.json";
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(-cpu|-gpu8)?$/;
export const parseTag = (tag) => { const m = TAG_RE.exec(String(tag || "")); return m ? { version: [+m[1], +m[2], +m[3]], flavor: m[4] ? m[4].slice(1) : "gpu" } : null; };
export const versionString = (v) => `v${v.join(".")}`;
export const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export function normalizePolicy(p) {
  if (!p || p.schema !== POLICY_SCHEMA) throw new Error(`release policy schema must be ${POLICY_SCHEMA}`);
  const min = parseTag(p.minimumRelease);
  if (!min || min.flavor !== "gpu") throw new Error(`release policy minimumRelease must be a bare vX.Y.Z tag, not ${JSON.stringify(p.minimumRelease)}`);
  const revoked = Array.isArray(p.revoked) ? p.revoked.map(String) : null;
  if (!revoked || revoked.some((t) => !parseTag(t))) throw new Error("release policy revoked must be a list of release tags");
  return { minimumRelease: min.version, revoked };
}

// the built-in policy: the file, parsed at load (a malformed file fails the import, so no bundle ships without a floor)
const parsed = normalizePolicy(POLICY_FILE);
export const RELEASE_POLICY = Object.freeze({ minimumRelease: Object.freeze([...parsed.minimumRelease]), revoked: Object.freeze([...parsed.revoked]), source: POLICY_FILE_PATH });

// the floor to apply and which authority set it: the highest of built-in (or the caller's explicit one), remembered and
// the verified index's; at a tie the more specific authority is named (signed index, then remembered, then caller/built-in)
export function floorOf({ caller = null, remembered = null, index = null } = {}) {
  const valid = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n >= 0);
  let floor = valid(caller) ? [...caller] : [...RELEASE_POLICY.minimumRelease], source = valid(caller) ? "caller" : "built-in";
  if (valid(remembered) && compareVersions(remembered, floor) >= 0) { floor = [...remembered]; source = "remembered"; }
  if (valid(index) && compareVersions(index, floor) >= 0) { floor = [...index]; source = "signed index"; }
  return { floor, source, builtin: [...RELEASE_POLICY.minimumRelease], callerBelowBuiltin: valid(caller) && compareVersions(caller, RELEASE_POLICY.minimumRelease) < 0 };
}
// the union of revocation lists: the built-in one first, then any others (the caller's, a verified index's)
export const revokedOf = (...lists) => [...new Set([...RELEASE_POLICY.revoked, ...lists.flatMap((l) => (Array.isArray(l) ? l.map(String) : []))])];
// the fields every consumer result carries about its floor
export const floorRecord = (f) => ({ floorApplied: versionString(f.floor), floorSource: f.source, builtinFloor: versionString(f.builtin), ...(f.callerBelowBuiltin ? { callerBelowBuiltin: true } : {}) });
