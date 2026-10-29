// Pure unit tests (no source tree needed). Record values below are obviously-synthetic TEST shapes, never production terms.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as L from "../lib.mjs";
import * as R2 from "../../production-site-addon-r2/lib.mjs";
import { CONFIG_PATCH, CANDIDATE, BASELINE } from "../make-overlay.mjs";

const readJson = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), "utf8"));
const OWNER = "0x" + "11".repeat(20), SID = "0x" + "a1".repeat(32), TH = "0x" + "b2".repeat(32);
const APLAN = "0x" + "c3".repeat(32), RPLAN = "0x" + "d4".repeat(32);
const runtime = () => ({ schema: "enclave-funding-browser-runtime-r1", chainId: 8453, test: true });
const proposal = () => ({ schema: "enclave-funding-migration-proposal-r1", chainId: 8453, owner: OWNER, oldSid: SID, legacy6: "1", gas: [], deploymentIds: [] });
const approval = () => ({ schema: "enclave-funding-migration-approval-r1", rootReviewed: true, termsHash: TH, owner: OWNER, chainId: 8453, oldSid: SID });
const human = () => ({ termsHash: TH, evidenceSha256: "e5".repeat(32) });
const cutover = () => ({ schema: "enclave-funding-migration-cutover-r1", chainId: 8453, owner: OWNER, oldSid: SID,
  terms: { pauseAfter: "terminate", activationPlanSha256: APLAN, rollbackPlanSha256: RPLAN } });
const activation = () => ({ schema: "enclave-funding-cutover-activation-r1", planId: "test-plan", rootReviewed: true, reviewedBy: "test",
  termsHash: TH, terminateTxHash: "0x" + "f6".repeat(32), terminateBlockHash: "0x" + "f7".repeat(32), activationPlanSha256: APLAN,
  relayer: "0x" + "22".repeat(20), legacyRelayerReconciledThroughNonce: "7" });
const nulls = () => Object.fromEntries(L.FUNDING_KEYS.map((k) => [k, null]));
const cfgOf = (release, funding = {}, humanApproval = null) => ({ schema: L.CONFIG_SCHEMA, release, reviewed: release !== "disabled", note: "TEST",
  overrides: [], acceptLegacy: [], humanApproval, funding: { ...nulls(), ...funding } });
const prep = () => cfgOf("enabled", { FUNDING_RUNTIME: runtime(), FUNDING_MIGRATION_PROPOSAL: proposal(), FUNDING_MIGRATION_APPROVAL: approval(),
  FUNDING_MIGRATION_CUTOVER: cutover() }, human());
const act = () => { const c = prep(); c.release = "activation"; c.funding.FUNDING_CUTOVER_ACTIVATION = activation(); return c; };
const refuses = (cfg, re) => assert.throws(() => L.validateConfig(cfg), re);

test("version, five explicit keys, unchanged r2 artifact format", () => {
  assert.equal(L.VERSION, "funding-cutover-r1");
  assert.deepEqual(L.FUNDING_KEYS, ["FUNDING_RUNTIME", "FUNDING_MIGRATION_PROPOSAL", "FUNDING_MIGRATION_APPROVAL",
    "FUNDING_MIGRATION_CUTOVER", "FUNDING_CUTOVER_ACTIVATION"]);
  assert.equal(L.MANIFEST_SCHEMA, "enclave-funding-addon-manifest-r2");
  assert.equal(L.PINS_SCHEMA, "enclave-funding-addon-pins-r2");
  assert.equal(L.applyExact, R2.applyExact);        // the r2 checks are the same functions, not copies
  assert.equal(L.planAdditions, R2.planAdditions);
  assert.equal(L.checkClosure, R2.checkClosure);
  assert.equal(L.transformHtml, R2.transformHtml);
});

test("exact versioned new SDK: tested candidate vendor/core/page pins", () => {
  assert.equal(L.QUALIFIED["site/vendor/funding.js"], "f23ba2d79661ade43ed484e186d0347b95756dbe70a9735c4b3152da653dd957");
  assert.notEqual(L.QUALIFIED["site/vendor/funding.js"], "16629d5c8f1b708b3c9dd1bd7ece00908ae8f1f1a9f34c0284dcc8ed57fa6368");   // r2 vendor
  assert.ok(L.QUALIFIED["site/vendor/sessions.js"].startsWith(L.LEGACY_SESSIONS_PREFIX));
  for (const k of Object.keys(CANDIDATE)) if (CANDIDATE[k]) assert.equal(CANDIDATE[k], L.QUALIFIED[k]);
  assert.equal(Object.keys(BASELINE).length + Object.keys(CANDIDATE).length + 1, 33);
});

test("disabled null: shipped config accepted, nothing replaced; any non-null refused", () => {
  const cfg = L.validateConfig(readJson("../config-disabled-cutover-r1.json"));
  assert.deepEqual(cfg.funding, nulls());
  assert.deepEqual(L.configReplacements(cfg), []);
  for (const k of L.FUNDING_KEYS) refuses(cfgOf("disabled", { [k]: {} }), /disabled release keeps/);
  refuses(cfgOf("disabled", {}, human()), /humanApproval null/);
});

test("old/absent keys and old schema refused (no absent-means-null at the config input)", () => {
  refuses(readJson("../../production-site-addon-r2/config-disabled-r1.json"), /schema must be/);
  const c = cfgOf("disabled"); delete c.funding.FUNDING_CUTOVER_ACTIVATION; refuses(c, /exactly/);
  const d = cfgOf("disabled"); delete d.humanApproval; refuses(d, /humanApproval must be present/);
  refuses({ ...cfgOf("disabled"), extra: 1 }, /unknown key/);
});

test("template refused until actual reviewed terms", () => {
  refuses(readJson("../config.cutover.template.json"), /placeholder/);
  assert.throws(() => L.validatePins(readJson("../pins.template.json")), /reviewed/);
});

test("cutover preparation: concrete reviewed terms accepted, activation still null", () => {
  const c = L.validateConfig(prep());
  assert.equal(c.funding.FUNDING_CUTOVER_ACTIVATION, null);
  const pairs = L.configReplacements(c);
  assert.equal(pairs.length, 4);
  assert.ok(pairs.every(([from]) => /^export const FUNDING_[A-Z_]+ = null;$/.test(from)));
  assert.ok(!pairs.some(([from]) => from.includes("FUNDING_CUTOVER_ACTIVATION")));
  L.validateConfig(cfgOf("enabled", { FUNDING_RUNTIME: runtime() }));   // r2 normal release still valid
  L.validateConfig(cfgOf("enabled", { FUNDING_RUNTIME: runtime(), FUNDING_MIGRATION_PROPOSAL: proposal(), FUNDING_MIGRATION_CUTOVER: cutover() }));
  const u = prep(); u.reviewed = false; refuses(u, /reviewed: true/);
  refuses(cfgOf("enabled", { FUNDING_MIGRATION_PROPOSAL: proposal() }), /concrete FUNDING_RUNTIME/);
});

test("forbidden activation: before the operation, or without cutover", () => {
  const a = prep(); a.funding.FUNDING_CUTOVER_ACTIVATION = activation(); refuses(a, /must remain null before the actual operation/);
  const b = cfgOf("enabled", { FUNDING_RUNTIME: runtime(), FUNDING_MIGRATION_PROPOSAL: proposal(), FUNDING_MIGRATION_APPROVAL: approval(),
    FUNDING_CUTOVER_ACTIVATION: activation() }, human());
  refuses(b, /without FUNDING_MIGRATION_CUTOVER/);
  const c = act(); c.funding.FUNDING_MIGRATION_CUTOVER = null; refuses(c, /without FUNDING_MIGRATION_CUTOVER/);
  const d = act(); d.funding.FUNDING_CUTOVER_ACTIVATION = null; refuses(d, /release activation needs/);
  const e = act(); e.funding.FUNDING_CUTOVER_ACTIVATION.rootReviewed = false; refuses(e, /rootReviewed: true/);
  const f = act(); f.funding.FUNDING_CUTOVER_ACTIVATION.extra = 1; refuses(f, /must be exactly/);
  L.validateConfig(act());   // the shape a later post-operation rebuild would need
});

test("owner / chain / sid / termsHash / plan mismatches refused", () => {
  const set = (fn) => { const c = act(); fn(c.funding, c); return c; };
  refuses(set((f) => { f.FUNDING_MIGRATION_APPROVAL.owner = "0x" + "33".repeat(20); }), /owner mismatch/);
  refuses(set((f) => { f.FUNDING_MIGRATION_CUTOVER.owner = "0x" + "33".repeat(20); }), /owner mismatch/);
  refuses(set((f) => { f.FUNDING_MIGRATION_CUTOVER.chainId = 84532; }), /chain mismatch/);
  refuses(set((f) => { f.FUNDING_MIGRATION_PROPOSAL.chainId = 1; }), /chain mismatch/);
  refuses(set((f) => { f.FUNDING_MIGRATION_APPROVAL.oldSid = "0x" + "a2".repeat(32); }), /sid mismatch/);
  refuses(set((f) => { f.FUNDING_MIGRATION_CUTOVER.oldSid = "0x" + "a2".repeat(32); }), /sid mismatch/);
  refuses(set((f) => { f.FUNDING_CUTOVER_ACTIVATION.termsHash = "0x" + "b3".repeat(32); }), /termsHash mismatch/);
  refuses(set((f, c) => { c.humanApproval.termsHash = "0x" + "b3".repeat(32); }), /termsHash mismatch/);
  refuses(set((f) => { f.FUNDING_CUTOVER_ACTIVATION.activationPlanSha256 = RPLAN; }), /reviewed activation plan/);
  refuses(set((f) => { f.FUNDING_MIGRATION_CUTOVER.terms.rollbackPlanSha256 = APLAN; }), /must differ/);
  refuses(set((f) => { f.FUNDING_MIGRATION_CUTOVER.terms.pauseAfter = "legacyOpen"; }), /terminate/);
  refuses(set((f) => { f.FUNDING_MIGRATION_CUTOVER.terms.activationPlanSha256 = APLAN.toUpperCase().replace("0X", "0x"); }), /lower-case/);
  refuses(set((f) => { f.FUNDING_MIGRATION_APPROVAL.schema = "enclave-funding-migration-approval-r0"; }), /schema/);
});

test("rootReviewed permits wallet review but is not human approval; optional reference remains bound", () => {
  const a = prep(); a.humanApproval = null; assert.doesNotThrow(() => L.validateConfig(a));
  const b = cfgOf("enabled", { FUNDING_RUNTIME: runtime(), FUNDING_MIGRATION_PROPOSAL: proposal() }, human()); refuses(b, /only with FUNDING_MIGRATION_APPROVAL/);
  const c = prep(); c.funding.FUNDING_MIGRATION_APPROVAL.rootReviewed = "yes"; refuses(c, /rootReviewed: true/);
  const d = prep(); d.funding.FUNDING_MIGRATION_PROPOSAL = null; refuses(d, /together with its FUNDING_MIGRATION_PROPOSAL/);
  assert.match(L.APPROVAL_NOTE, /NOT human grant approval/);
});

test("config.js null exports: overlay patch exact, reversible, and required by the builder", () => {
  const base = "x;\n" + CONFIG_PATCH[0][0] + "y;\n";
  assert.throws(() => L.checkNullExports(base), /FUNDING_RUNTIME/);   // fixture lacks the r2 lines too
  const full = "export const FUNDING_RUNTIME = null;\nexport const FUNDING_MIGRATION_PROPOSAL = null;\n" + base;
  assert.throws(() => L.checkNullExports(full), /FUNDING_MIGRATION_CUTOVER/);
  const r = L.applyExact("site/js/core/config.js", full, CONFIG_PATCH);
  assert.equal(r.reverseEqual, true);
  assert.deepEqual(L.checkNullExports(r.text), L.FUNDING_KEYS);
  assert.deepEqual(L.configLiterals(r.text), L.configLiterals(full));   // no new endpoint/address literal
  assert.throws(() => L.checkNullExports(r.text + "export const FUNDING_CUTOVER_ACTIVATION = {};\n"), /exactly once/);
  assert.throws(() => L.applyExact("x", r.text, CONFIG_PATCH), /already present|exactly one/);   // never applied twice
});

test("pins: version, qualified inputs and reused r2 lib required", () => {
  const h = "ab".repeat(32);
  const good = () => ({ schema: L.PINS_SCHEMA, reviewed: true, version: L.VERSION, esbuildVersion: "0.28.1", config: h, existingPaths: h,
    liveInventory: h, liveSessionsVendor: h, inputs: { ...L.QUALIFIED, "addon:lib.mjs": h } });
  L.validatePins(good());
  const a = good(); delete a.version; assert.throws(() => L.validatePins(a), /version/);
  const b = good(); b.inputs["site/vendor/funding.js"] = "16629d5c8f1b708b3c9dd1bd7ece00908ae8f1f1a9f34c0284dcc8ed57fa6368"; assert.throws(() => L.validatePins(b), /qualified/);
  const c = good(); delete c.inputs["addon:lib.mjs"]; assert.throws(() => L.validatePins(c), /addon:lib\.mjs/);
  const d = good(); d.reviewed = false; assert.throws(() => L.validatePins(d), /reviewed/);
  assert.throws(() => L.validatePins(readJson("../../production-site-addon-r2/pins-disabled-reviewed-r1.json")), /version|qualified/);
});
