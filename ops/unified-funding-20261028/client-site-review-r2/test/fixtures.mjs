// UNREVIEWED, NOT RUN. Synthetic fixtures shaped like the r4 core's journal entries and gas key records
// (buildMigrationPlan / newGasRecord field names). Values are made up; nothing here was produced by the core.
import * as ST from "../authored/site/js/funding/state.js";

export const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const VAULT = `0x${"11".repeat(20)}`, LVAULT = `0x${"22".repeat(20)}`, VAULT2 = `0x${"33".repeat(20)}`;
export const RELAY = "https://api.enclave.host";
export const SID = `0x${"5a".repeat(32)}`, SID2 = `0x${"5b".repeat(32)}`;
export const H = (n) => `0x${n.toString(16).padStart(64, "0")}`;
export const APPS = Array.from({ length: 10 }, (_, i) => H(i + 1));
export const NUC = APPS.slice(1, 9), METAL = [APPS[0], APPS[9]];
export const DEPS = APPS.map((_, i) => H(1000 + i));
export const code = (c) => (e) => e?.code === c;
export const ctxOf = (owner = OWNER, relay = RELAY, vault = VAULT) => ST.contextOf({ owner, chainId: 8453, vault, legacyVault: LVAULT, relay });
export const ctxA = ctxOf(OWNER), ctxB = ctxOf(OTHER);

export const proposal = (over = {}) => ({ schema: ST.PROPOSAL_SCHEMA, chainId: 8453, owner: OWNER, oldSid: SID, legacy6: "29000000",
  gas: [{ name: "nucbox", budget6: "800000", opsPerPeriod: "16", appIds: NUC }, { name: "metal", budget6: "200000", opsPerPeriod: "4", appIds: METAL }],
  deploymentIds: DEPS, ...over });
export const np = (over) => ST.validateProposal(proposal(over), { owner: OWNER, chainId: 8453 });

let n = 0;
export const step = (status, extra = {}, signBefore = "5000") => ({ status, attempt: 1, history: [],
  review: { digest: `0xd${status}${(n += 1)}`, grant: { signBefore } }, ...extra });
export const termStep = (status, extra = {}) => ({ status, attempt: 1, history: [], review: { digest: "0xdterm", message: { signBefore: "5000" } }, ...extra });
const gasStep = (name, status = "planned", extra = {}) => {
  const s = step(status, extra);
  s.review = { ...s.review, recordId: `gas-${name}`, keyHash: H(500 + name.length), sid: H(600 + name.length) };
  return s;
};

/** A plan of `owner` whose gas steps reference records gas-nucbox / gas-metal. */
export const plan = (steps = {}, over = {}, owner = OWNER) => ({ id: `migration:${SID}`, kind: "migration", v: 3, at: 1, termsHash: "0xterms",
  terms: { owner, chainId: 8453, order: ["terminate", "legacyOpen", "gasOpen:nucbox", "gasOpen:metal"],
    legacy: { vault: LVAULT, oldSid: SID, oldBalance6: "30000000", grantTemplate: { apps: ["*"] } },
    split: { legacy6: "29000000", gas6: "1000000", parts: [{ name: "nucbox", budget6: "800000" }, { name: "metal", budget6: "200000" }], total6: "30000000" },
    gas: { vault: VAULT, deployments: [...DEPS].sort(), parts: [
      { name: "nucbox", step: "gasOpen:nucbox", budget6: "800000", opsPerPeriod: "16", appIds: [...NUC].sort() },
      { name: "metal", step: "gasOpen:metal", budget6: "200000", opsPerPeriod: "4", appIds: [...METAL].sort() }] } },
  steps: { terminate: termStep("planned"), legacyOpen: step("planned"), "gasOpen:nucbox": gasStep("nucbox"), "gasOpen:metal": gasStep("metal"), ...steps },
  ...over });

/** The gas key records buildMigrationPlan would have saved for that plan (owner, chain, vault, relay, keyHash). */
export const recordsFor = (p, { owner = p.terms.owner, relay = RELAY, vault = p.terms.gas.vault } = {}) =>
  p.terms.order.slice(2).map((k) => ({ id: p.steps[k].review.recordId, keyHash: p.steps[k].review.keyHash, owner, chainId: 8453,
    vault, relay, status: "reviewed", sid: p.steps[k].review.sid, grant: { apps: p.terms.gas.parts.find((x) => x.step === k).appIds } }));
