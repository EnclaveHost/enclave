/* ============================================================
   funding-cutover-r1 addon: the smallest strict revision of
   ../production-site-addon-r2/lib.mjs. That qualified lib is
   re-exported UNCHANGED (and hash-pinned by build.mjs as input
   "addon:lib.mjs"); only these names are replaced:
     VERSION, CONFIG_SCHEMA, FUNDING_KEYS (five, explicit null),
     validateConfig, configReplacements, validatePins
   and added: QUALIFIED, checkNullExports, PAGE_CHAIN, APPROVAL_NOTE.
   The artifact MANIFEST / pins keep the r2 FORMAT (schemas below) so
   production-composite-release-r1 consumes them unchanged.
   No filesystem writes here; every refusal is a thrown Error.
   ============================================================ */
import * as R2 from "../production-site-addon-r2/lib.mjs";
export * from "../production-site-addon-r2/lib.mjs";

export const VERSION = "funding-cutover-r1";
export const MANIFEST_SCHEMA = "enclave-funding-addon-manifest-r2";   // unchanged format (composite ADDON_SCHEMA)
export const PINS_SCHEMA = R2.PINS_SCHEMA;                              // unchanged format (composite PINS_SCHEMA) + required `version`
export const CONFIG_SCHEMA = "enclave-funding-addon-config-cutover-r1";
export const PAGE_CHAIN = 8453;                                         // candidate site/js/pages/funding.js: const CHAIN = 8453

/** Inputs that must be these exact bytes in BOTH modes: the reused r2 addon modules, the tested candidate
 *  page/state/flows/vendor/core manifest (migration-cutover-site-review-r1 BUILD-PINS + funding.manifest.json)
 *  and the qualified legacy sessions SDK. */
export const QUALIFIED = Object.freeze({
  "addon:src/entry.js": "0e8ccaebe5dca36cb7ab8f806075ad3d202d8081e0ab207c84b6c9848a471e7e",
  "addon:src/hard-nav.js": "6598b6050caa0ebbf7cef8a66921de95c7ea85e494b6e468ae7d5157da1342f9",
  "site/js/pages/funding.js": "635cdcc1737f827badd2c7b5fcd878df7af0080a2a487f19f2fc6644fbab3fc1",
  "site/js/funding/state.js": "010d864fc4947c2a46961a6011ff8cba2fce29d6097fa8f64e65d2c8ab5e2825",
  "site/js/funding/flows.js": "88d2e23a8990858546c306d3249483822d9ea14f77846d8007c721fbd6b70ab2",
  "site/vendor/funding.js": "f23ba2d79661ade43ed484e186d0347b95756dbe70a9735c4b3152da653dd957",
  "sdk/funding/MANIFEST.json": "838344f7fa68969e67cbda7a467d24812c51c60a145175294f11c71af3c02e72",
  "site/vendor/sessions.js": "9dda76f6c22ef102e9dce27b7e61731c83a7e41905a611587578e305bc758997",
});

export const APPROVAL_NOTE = "FUNDING_MIGRATION_APPROVAL.rootReviewed is the reviewed-artifact flag the page requires; it is NOT human grant approval. "
  + "Human approval is only referenced by humanApproval.evidenceSha256, which this builder records and does not verify.";

// ---------------------------------------------------------------------------------------------------------------
// Reviewed configuration input (shapes are those of candidate site/js/funding/state.js and sdk/funding/migration.mjs)
// ---------------------------------------------------------------------------------------------------------------
export const FUNDING_KEYS = [...R2.FUNDING_KEYS, "FUNDING_MIGRATION_CUTOVER", "FUNDING_CUTOVER_ACTIVATION"];
export const FUNDING_SCHEMA = Object.freeze({
  FUNDING_RUNTIME: "enclave-funding-browser-runtime-r1",
  FUNDING_MIGRATION_PROPOSAL: "enclave-funding-migration-proposal-r1",      // state.js PROPOSAL_SCHEMA
  FUNDING_MIGRATION_APPROVAL: "enclave-funding-migration-approval-r1",      // state.js APPROVAL_SCHEMA
  FUNDING_MIGRATION_CUTOVER: "enclave-funding-migration-cutover-r1",        // state.js CUTOVER_CONFIG_SCHEMA
  FUNDING_CUTOVER_ACTIVATION: "enclave-funding-cutover-activation-r1",      // migration.mjs CUTOVER_ACTIVATION_SCHEMA
});
const SHAPE = {
  FUNDING_MIGRATION_PROPOSAL: ["schema", "chainId", "owner", "oldSid", "legacy6", "gas", "deploymentIds"],   // state.js validateProposal
  FUNDING_MIGRATION_APPROVAL: ["schema", "rootReviewed", "termsHash", "owner", "chainId", "oldSid"],          // state.js approvalStatus
  FUNDING_MIGRATION_CUTOVER: ["schema", "chainId", "owner", "oldSid", "terms"],                               // state.js validateCutover
  FUNDING_CUTOVER_ACTIVATION: ["activationPlanSha256", "legacyRelayerReconciledThroughNonce", "planId", "relayer",
    "reviewedBy", "rootReviewed", "schema", "terminateBlockHash", "terminateTxHash", "termsHash"],             // migration.mjs ACTIVATION_KEYS
};
const CUTOVER_TERMS = ["pauseAfter", "activationPlanSha256", "rollbackPlanSha256"];
const HUMAN_KEYS = ["termsHash", "evidenceSha256"];
const CONFIG_KEYS = new Set(["schema", "release", "reviewed", "note", "overrides", "acceptLegacy", "humanApproval", "funding"]);
const RELEASES = ["disabled", "enabled", "activation"];
const HEX32 = /^0x[0-9a-f]{64}$/, ZERO32 = `0x${"0".repeat(64)}`, HEX64 = /^[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/, UINT = /^(0|[1-9][0-9]{0,19})$/;
const PLACEHOLDER = /[<>]|REPLACE|PLACEHOLDER|TODO/i;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const lower = (s) => String(s ?? "").toLowerCase();
const fail = (m) => { throw new Error("config: " + m); };
const exact = (o, keys, what) => {
  if (!isObj(o) || Object.keys(o).sort().join() !== [...keys].sort().join()) fail(`${what} must be exactly { ${keys.join(", ")} }`);
};
const hex32 = (v, what) => {
  if (typeof v !== "string" || !HEX32.test(v) || v === ZERO32) fail(`${what} must be a lower-case non-zero 0x + 64 hex`);
  return v;
};
function placeholders(v, at, out = []) {
  if (typeof v === "string") { if (PLACEHOLDER.test(v)) out.push(at); }
  else if (Array.isArray(v)) v.forEach((x, i) => placeholders(x, `${at}[${i}]`, out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) placeholders(x, `${at}.${k}`, out);
  return out;
}
/** owner / chain / original session of a record; `ref` (the proposal) must name the same three. */
function identity(r, what, ref) {
  if (Number(r.chainId) !== PAGE_CHAIN) fail(`${what}.chainId ${r.chainId} is not the page chain ${PAGE_CHAIN} (chain mismatch)`);
  if (typeof r.owner !== "string" || !ADDR.test(r.owner)) fail(`${what}.owner must be an address`);
  hex32(r.oldSid, `${what}.oldSid`);
  if (!ref) return;
  if (lower(r.owner) !== lower(ref.owner)) fail(`${what}.owner differs from FUNDING_MIGRATION_PROPOSAL.owner (owner mismatch)`);
  if (r.oldSid !== ref.oldSid) fail(`${what}.oldSid differs from FUNDING_MIGRATION_PROPOSAL.oldSid (sid mismatch)`);
}

/** release disabled: all five null. enabled: reviewed values, FUNDING_CUTOVER_ACTIVATION still null (cutover preparation).
 *  activation: a later, separate rebuild carrying the reviewed post-operation activation record. */
export function validateConfig(cfg) {
  if (!isObj(cfg)) fail("not an object");
  for (const k of Object.keys(cfg)) if (!CONFIG_KEYS.has(k)) fail(`unknown key ${k}`);
  if (cfg.schema !== CONFIG_SCHEMA) fail(`schema must be ${CONFIG_SCHEMA}`);
  if (!RELEASES.includes(cfg.release)) fail(`release must be one of ${RELEASES.join(", ")}`);
  if (!Object.hasOwn(cfg, "humanApproval")) fail("humanApproval must be present (null unless FUNDING_MIGRATION_APPROVAL is carried)");
  // overrides / acceptLegacy: exactly the r2 rules, unchanged
  R2.validateConfig({ schema: R2.CONFIG_SCHEMA, release: "disabled", overrides: cfg.overrides, acceptLegacy: cfg.acceptLegacy,
    funding: Object.fromEntries(R2.FUNDING_KEYS.map((k) => [k, null])) });
  const f = cfg.funding;
  if (!isObj(f) || Object.keys(f).sort().join() !== [...FUNDING_KEYS].sort().join())
    fail(`funding must list exactly ${FUNDING_KEYS.join(", ")} (explicit null = off)`);
  const ph = [...placeholders(f, "funding"), ...placeholders(cfg.humanApproval, "humanApproval")];
  if (ph.length) fail(`placeholder values are not reviewed terms: ${ph.join(", ")}`);
  const h = cfg.humanApproval;

  if (cfg.release === "disabled") {
    for (const k of FUNDING_KEYS) if (f[k] !== null) fail(`a disabled release keeps ${k} null`);
    if (h !== null) fail("a disabled release keeps humanApproval null");
    return cfg;
  }
  if (cfg.reviewed !== true) fail(`release ${cfg.release} needs reviewed: true`);
  for (const k of FUNDING_KEYS)
    if (f[k] !== null && (!isObj(f[k]) || f[k].schema !== FUNDING_SCHEMA[k])) fail(`${k} must be null or schema ${FUNDING_SCHEMA[k]}`);
  if (f.FUNDING_RUNTIME === null) fail(`release ${cfg.release} needs a concrete FUNDING_RUNTIME`);
  const np = f.FUNDING_MIGRATION_PROPOSAL, ap = f.FUNDING_MIGRATION_APPROVAL, co = f.FUNDING_MIGRATION_CUTOVER, ac = f.FUNDING_CUTOVER_ACTIVATION;

  if (ac !== null && co === null) fail("FUNDING_CUTOVER_ACTIVATION without FUNDING_MIGRATION_CUTOVER is refused");
  if (cfg.release === "enabled" && ac !== null)
    fail("FUNDING_CUTOVER_ACTIVATION must remain null before the actual operation (release enabled); only a separate release activation carries it");
  if (cfg.release === "activation" && [np, ap, co, ac].includes(null))
    fail("release activation needs FUNDING_MIGRATION_PROPOSAL, FUNDING_MIGRATION_APPROVAL, FUNDING_MIGRATION_CUTOVER and FUNDING_CUTOVER_ACTIVATION");
  if ((ap !== null || co !== null) && np === null) fail("an approval or cutover is carried only together with its FUNDING_MIGRATION_PROPOSAL");

  if (np !== null) {
    exact(np, SHAPE.FUNDING_MIGRATION_PROPOSAL, "FUNDING_MIGRATION_PROPOSAL");
    identity(np, "FUNDING_MIGRATION_PROPOSAL", null);
  }
  if (ap !== null) {
    exact(ap, SHAPE.FUNDING_MIGRATION_APPROVAL, "FUNDING_MIGRATION_APPROVAL");
    if (ap.rootReviewed !== true) fail("FUNDING_MIGRATION_APPROVAL is carried only as supplied with rootReviewed: true");
    identity(ap, "FUNDING_MIGRATION_APPROVAL", np);
    hex32(ap.termsHash, "FUNDING_MIGRATION_APPROVAL.termsHash");
    // rootReviewed is not human approval: the human grant approval is referenced separately, for the same terms
    exact(h, HUMAN_KEYS, "humanApproval (the human grant approval reference, required with an approval)");
    if (h.termsHash !== ap.termsHash) fail("humanApproval.termsHash differs from FUNDING_MIGRATION_APPROVAL.termsHash (termsHash mismatch)");
    if (typeof h.evidenceSha256 !== "string" || !HEX64.test(h.evidenceSha256)) fail("humanApproval.evidenceSha256 must be a sha256");
  } else if (h !== null) fail("humanApproval is carried only with FUNDING_MIGRATION_APPROVAL");
  if (co !== null) {
    exact(co, SHAPE.FUNDING_MIGRATION_CUTOVER, "FUNDING_MIGRATION_CUTOVER");
    identity(co, "FUNDING_MIGRATION_CUTOVER", np);
    exact(co.terms, CUTOVER_TERMS, "FUNDING_MIGRATION_CUTOVER.terms");
    if (co.terms.pauseAfter !== "terminate") fail("FUNDING_MIGRATION_CUTOVER.terms.pauseAfter must be terminate");
    hex32(co.terms.activationPlanSha256, "FUNDING_MIGRATION_CUTOVER.terms.activationPlanSha256");
    hex32(co.terms.rollbackPlanSha256, "FUNDING_MIGRATION_CUTOVER.terms.rollbackPlanSha256");
    if (co.terms.activationPlanSha256 === co.terms.rollbackPlanSha256) fail("the activation and rollback plans must differ");
  }
  if (ac !== null) {
    exact(ac, SHAPE.FUNDING_CUTOVER_ACTIVATION, "FUNDING_CUTOVER_ACTIVATION");
    if (ac.rootReviewed !== true || typeof ac.reviewedBy !== "string" || !ac.reviewedBy.trim())
      fail("FUNDING_CUTOVER_ACTIVATION needs rootReviewed: true and a non-empty reviewedBy");
    if (typeof ac.planId !== "string" || !ac.planId) fail("FUNDING_CUTOVER_ACTIVATION.planId must be a non-empty string");
    hex32(ac.termsHash, "FUNDING_CUTOVER_ACTIVATION.termsHash");
    if (ac.termsHash !== ap.termsHash) fail("FUNDING_CUTOVER_ACTIVATION.termsHash differs from the approval (termsHash mismatch)");
    hex32(ac.activationPlanSha256, "FUNDING_CUTOVER_ACTIVATION.activationPlanSha256");
    if (ac.activationPlanSha256 !== co.terms.activationPlanSha256)
      fail("FUNDING_CUTOVER_ACTIVATION.activationPlanSha256 is not the cutover's reviewed activation plan");
    hex32(ac.terminateTxHash, "FUNDING_CUTOVER_ACTIVATION.terminateTxHash");
    hex32(ac.terminateBlockHash, "FUNDING_CUTOVER_ACTIVATION.terminateBlockHash");
    if (typeof ac.relayer !== "string" || !ADDR.test(ac.relayer)) fail("FUNDING_CUTOVER_ACTIVATION.relayer must be an address");
    const n = String(ac.legacyRelayerReconciledThroughNonce);
    if (!UINT.test(n) || BigInt(n) >= 2n ** 64n) fail("FUNDING_CUTOVER_ACTIVATION.legacyRelayerReconciledThroughNonce must be a uint64");
  }
  return cfg;
}

/** config.js edits: reviewed literal overrides, then any concrete FUNDING_* value replacing its `= null`. */
export function configReplacements(cfg) {
  validateConfig(cfg);
  const pairs = cfg.overrides.map((o) => [JSON.stringify(o.literal), JSON.stringify(o.value)]);
  for (const k of FUNDING_KEYS)
    if (cfg.funding[k] !== null) pairs.push([`export const ${k} = null;`, `export const ${k} = ${JSON.stringify(cfg.funding[k])};`]);
  return pairs;
}

/** The source config.js must itself declare all five as `= null` exactly once (no reliance on "absent means null"). */
export function checkNullExports(text) {
  for (const k of FUNDING_KEYS) {
    const decl = R2.countOf(text, `export const ${k} `), nul = R2.countOf(text, `export const ${k} = null;`);
    if (decl !== 1 || nul !== 1) throw new Error(`site/js/core/config.js must declare \`export const ${k} = null;\` exactly once (found ${nul} of ${decl})`);
  }
  return [...FUNDING_KEYS];
}

/** r2 pin rules, plus: this version, the exact qualified/tested inputs, and the reused r2 lib pinned. */
export function validatePins(p) {
  R2.validatePins(p);
  if (p.version !== VERSION) throw new Error(`pins: version must be ${VERSION} (pins of another addon version are not reused)`);
  for (const [k, v] of Object.entries(QUALIFIED)) if (p.inputs[k] !== v) throw new Error(`pins: ${k} must be the qualified ${v}`);
  if (!HEX64.test(p.inputs["addon:lib.mjs"] ?? "")) throw new Error("pins: addon:lib.mjs (the reused r2 lib) must be pinned");
  return p;
}
