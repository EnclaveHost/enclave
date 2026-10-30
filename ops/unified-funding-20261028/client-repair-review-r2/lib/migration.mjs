// UNREVIEWED SOURCE (unified-funding client-repair-r2). Resumable budget migration of the live legacy $30 session into
// replacement-legacy (API, domain "1", SAME key) + successor gas-only (domain "2", fresh key). NOT approved, NOT signable
// until root review; nothing here runs on import or page load.
//
// Sequence (deployed-source constraints): SessionVault._end refunds owner terminations straight to the owner wallet, and
// the original relay's POST /open with budget > 0 always uses openWithDepositFor. So:
//   terminate(old) -> /open replacement legacy (EIP-3009 from the refunded wallet) -> /funding/open successor gas.
//
// Journal (one public entry "migration:<oldSid>", IndexedDB "enclave-funding-v2"): terms (reviewed, stable), and per step
// the UNSIGNED exact review (typed message / grant + digest), status, txHash and proof. Never signatures or key bytes.
// Step status:  planned -> admitted -> submitted -> proven            (normal)
//               admitted|submitted -> void   (only when the chain proves the signed review can never apply)
//               void|planned -> planned (new attempt, new nonce: rearmStep)
// Only "planned" steps are ever sent. admitted/submitted steps are NEVER resent: reconcile proves them (by txHash or by
// discovering the step's own event in logs) or, after their signature window closed, proves them void.
// Admission is a compare-and-set in one IndexedDB transaction (casJournal), so a second tab cannot submit the same step.
import { encodeEventTopics, parseAbi } from "../../../source/node_modules/viem/_esm/index.js";
import { parseAddress, parseHex32, parseUint, keyHashOf } from "../../client-r1/funding-codec.mjs";
import { canon, fail, hashOf, jsonable, lower, randomHex32, sameAddr } from "./util.mjs";
import {
  CHAIN_ID, GAS_GRANT_CANDIDATE, OWNER_OP_WINDOW, SIGN_WINDOW, buildGasGrant, ethCall, grantBody, pinBlock,
  prepareGasOpen, rebuildGasReview, signGasOpen, usdcDomain, depositTypedData, walletSignTyped,
} from "./funding-client.mjs";
import { VAULT_EVENTS, canonicalReceipt, proveEnded, proveOpened, receiptFinality } from "./chain-proof.mjs";

export const MIGRATION_SCHEMA = "enclave-funding-migration-plan-r2";
export const MAX_COMBINED6 = 30_000_000n;
export const V1_GRANT_FIELDS = Object.freeze(["label", "preset", "sessionKey", "actions", "apps", "environments", "budget",
  "spendPerPeriod", "periodSeconds", "opsPerPeriod", "maxFeePerOp", "maxAppFeePerHour", "maxRatePerHour", "expiresAt",
  "measurement", "grantNonce", "signBefore"]);
export const REPLACED_FIELDS = Object.freeze(["budget", "grantNonce", "signBefore"]);
const V1_BIG = ["budget", "spendPerPeriod", "maxFeePerOp", "maxAppFeePerHour", "maxRatePerHour", "expiresAt", "signBefore"];
const V1_NUM = ["periodSeconds", "opsPerPeriod"];
const GAS_VOLATILE = ["sessionKey", "grantNonce", "signBefore"];
export const ORDER = Object.freeze(["terminate", "legacyOpen", "gasOpen"]);
export const STEP_NOTES = Object.freeze({
  withdraw: "not-applicable: SessionVault._end refunds the old escrow to the owner wallet; no vault free balance is created",
  legacyFunding: "relay POST /open -> factory.openWithDepositFor (owner EIP-3009, nonce = replacement grant digest)",
  gasFunding: "relay POST /v1/sessions/funding/open -> successor openWithDeposit (owner EIP-3009, nonce = gas grant digest)",
  interruption: "API session auth stops when the original relay simulates terminate and resumes when the replacement open "
    + "is proven and the active pointer moves; a pending or lost reply extends it until reconcile proves the step.",
  proofs: "terminate: SessionEnded(oldSid, reason 1, refund = full balance, fee 0) + USDC Transfer(vault -> owner). open: "
    + "SessionOpened(sid, key, scope, budget) + USDC AuthorizationUsed(owner, digest) + Transfer(owner -> vault). All from a "
    + "canonical receipt; finality is recorded separately.",
});

const LOCAL_ABI = parseAbi([
  "function owner() view returns (address)",
  "function free() view returns (uint256)",
  "function vaultFor(address owner) view returns (address)",
  "function balanceOf(address account) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);
const toQty = (n) => `0x${BigInt(n).toString(16)}`;

// =====================================================================================================================
// Chain adapter (JSON-RPC). Tests replace it with a scripted object of the same shape.
// =====================================================================================================================

export function legacyChain(rpc, S) {
  const call = (to, fn, args, block, abi = LOCAL_ABI) => ethCall(rpc, to, fn, args, block ?? "latest", abi);
  return Object.freeze({
    pin: (now) => pinBlock(rpc, now),
    async sessionOf(vault, sid, block) {
      const [s, live, apps] = await call(vault, "sessionOf", [sid], block, S.sessionVaultAbi);
      return normState(s, live, apps);
    },
    owner: (vault, block) => call(vault, "owner", [], block),
    free: async (vault, block) => BigInt(await call(vault, "free", [], block)),
    vaultFor: (factory, owner, block) => call(factory, "vaultFor", [owner], block),
    usdcBalance: async (usdc, who, block) => BigInt(await call(usdc, "balanceOf", [who], block)),
    authorizationUsed: (usdc, who, nonce, block) => call(usdc, "authorizationState", [who, nonce], block),
    receipt: (txHash) => canonicalReceipt(rpc, txHash),
    finality: (rc) => receiptFinality(rpc, rc),
    async getLogs({ address, topics, fromBlock }) {
      const logs = await rpc("eth_getLogs", [{ address, topics, fromBlock: toQty(fromBlock), toBlock: "latest" }]);
      if (!Array.isArray(logs)) fail("rpc_logs", "eth_getLogs did not return an array");
      return logs;
    },
  });
}

/** The original Session struct as read by sessionOf (SessionVault.sol `struct Session`), incl. maxRateHour6. */
export function normState(s, live, apps) {
  return Object.freeze({
    live: Boolean(live), state: Number(s.state), keyHash: lower(s.keyHash), measurement: lower(s.measurement),
    actions: BigInt(s.actions), expiresAt: BigInt(s.expiresAt), envs: Number(s.envs), anyApp: Boolean(s.anyApp),
    balance6: BigInt(s.balance6), spent6: BigInt(s.spent6), perPeriod6: BigInt(s.perPeriod6), maxFee6: BigInt(s.maxFee6),
    maxAppFeeHour6: BigInt(s.maxAppFeeHour6), maxRateHour6: BigInt(s.maxRateHour6), period: Number(s.period),
    opsPerPeriod: Number(s.opsPerPeriod), periodSpent6: BigInt(s.periodSpent6),
    apps: Object.freeze([...(apps ?? [])].map(lower)),
  });
}

export function actionsMaskV1(S, names) {
  let m = 0n;
  for (const a of names) {
    if (!Object.prototype.hasOwnProperty.call(S.ACTIONS, a)) fail("legacy_action_unknown", `action ${a} is not a v1 action`);
    m |= 1n << BigInt(S.ACTIONS[a]);
  }
  return m;
}
export const envMask = (envs) => envs.reduce((m, e) => m | ({ staging: 1, prod: 2 }[e] ?? fail("legacy_env_unknown", `environment ${e}`)), 0);

/** Every grant field the vault mirrors must equal the chain (maxRatePerHour -> maxRateHour6 included). Only label and
 *  preset are not mirrored; they come from the persisted record, bound by its sid and key. */
export function compareGrantToChain(S, g, st, what) {
  const want = {
    keyHash: lower(g.sessionKey), measurement: lower(g.measurement), actions: actionsMaskV1(S, g.actions),
    expiresAt: BigInt(g.expiresAt), envs: envMask(g.environments), perPeriod6: BigInt(g.spendPerPeriod),
    maxFee6: BigInt(g.maxFeePerOp), maxAppFeeHour6: BigInt(g.maxAppFeePerHour), maxRateHour6: BigInt(g.maxRatePerHour),
    period: Number(g.periodSeconds), opsPerPeriod: Number(g.opsPerPeriod),
  };
  const diff = Object.keys(want).filter((k) => want[k] !== st[k]);
  if (diff.length) fail("legacy_fields_mismatch", `${what}: grant differs from chain in [${diff}]`, { diff });
  if (g.apps.length !== 0) fail("legacy_apps_unverifiable", "app-scoped legacy grants cannot be reproduced offline; STOP");
  if (st.apps.length !== 0 || st.anyApp !== true) fail("legacy_fields_mismatch", `${what}: chain apps differ from an any-app grant`);
}

/** Journal JSON -> the SDK's Grant (bigint / number fields as in sdk/sessions/src/typed.ts). */
export function v1GrantFromJson(j) {
  const keys = Object.keys(j).sort();
  if (canon(keys) !== canon([...V1_GRANT_FIELDS].sort())) fail("legacy_grant_shape", `grant fields are [${keys}]`);
  const g = { ...j, actions: [...j.actions], apps: [...j.apps], environments: [...j.environments] };
  for (const k of V1_BIG) g[k] = BigInt(j[k]);
  for (const k of V1_NUM) g[k] = Number(j[k]);
  return g;
}

// =====================================================================================================================
// 1. Evidence: the persisted legacy record + chain reads at ONE pinned fresh block. Any gap -> STOP.
// =====================================================================================================================

export async function loadLegacyEvidence({ S, legacyStore, sid, owner, chain, legacyConfig, runtime, now }) {
  const o = parseAddress(owner, "owner");
  const id = parseHex32(lower(sid), "sid", { nonZero: true });
  const rec = await legacyStore.load(id);
  if (!rec) fail("legacy_record_missing", `no persisted SDK record ${id} in this origin's IndexedDB; STOP - grant fields cannot be reproduced`);
  if (rec.v !== 1 || !rec.handle || lower(rec.handle.sid) !== id || !rec.grant) fail("legacy_record_shape", "record is not an open v1 session with its grant");
  if (rec.pkcs8 !== undefined) fail("legacy_record_secret", "browser records never hold exportable key bytes");
  if (!rec.privateKey || rec.privateKey.extractable !== false) fail("legacy_key_unusable", "the legacy key is not a non-extractable CryptoKey");
  if (!sameAddr(rec.handle.owner, o)) fail("legacy_owner_mismatch", "record belongs to another owner");
  if (Number(rec.chainId) !== CHAIN_ID || Number(rec.handle.chainId) !== CHAIN_ID) fail("chain_mismatch", "legacy record is not Base 8453");
  const g = rec.grant;
  const keys = Object.keys(g).sort();
  if (canon(keys) !== canon([...V1_GRANT_FIELDS].sort())) fail("legacy_grant_shape", `grant fields are [${keys}]`);
  if (keyHashOf(BigInt(rec.x), BigInt(rec.y)) !== lower(rec.keyHash) || lower(g.sessionKey) !== lower(rec.keyHash)) {
    fail("key_hash_mismatch", "record public key, key hash and grant.sessionKey disagree");
  }
  const vault = parseAddress(rec.handle.vault, "handle.vault");
  if (lower(S.sessionIdOf(vault, g.sessionKey, g.grantNonce)) !== id) fail("legacy_sid_mismatch", "sid is not derived from the persisted grant");

  const factory = parseAddress(legacyConfig.factory, "legacy relay config.factory");
  if (Number(legacyConfig.chainId) !== CHAIN_ID) fail("chain_mismatch", "legacy relay is not Base");
  if (!sameAddr(factory, runtime.pins.legacyFactory)) fail("legacy_factory_mismatch", "legacy relay factory differs from the successor's pinned legacyFactory");
  if (!sameAddr(runtime.cfg.legacyVault, vault)) fail("legacy_vault_mismatch", "successor config legacyVault differs from the record's vault");
  const pin = await chain.pin(now);
  if (!sameAddr(await chain.vaultFor(factory, o, pin.tag), vault)) fail("legacy_vault_mismatch", "factory.vaultFor(owner) is not the record's vault");
  if (!sameAddr(await chain.owner(vault, pin.tag), o)) fail("legacy_owner_mismatch", "vault.owner() is not the connected owner");
  const st = await chain.sessionOf(vault, id, pin.tag);
  if (!st.live) fail("legacy_not_live", "the old session is not live (ended, revoked or expired); STOP");
  compareGrantToChain(S, g, st, "old session");
  if (st.spent6 !== 0n || st.periodSpent6 !== 0n || st.balance6 !== BigInt(g.budget)) {
    fail("legacy_state_changed", `balance ${st.balance6} / spent ${st.spent6} is not the untouched ${g.budget}; STOP`, { balance6: st.balance6, spent6: st.spent6 });
  }
  const free6 = await chain.free(vault, pin.tag);
  await pin.recheck();
  return Object.freeze({ record: rec, grant: g, vault, sid: id, owner: o, factory, state: st, free6,
    observed: Object.freeze({ block: Number(pin.number), hash: pin.hash, timestamp: Number(pin.timestamp) }) });
}

// =====================================================================================================================
// 2. Plan (no wallet). `terms` = what is reviewed: stable, no nonce / window / observed block.
// =====================================================================================================================

const strip = (g, ks) => Object.fromEntries(Object.entries(jsonable(g)).filter(([k]) => !ks.includes(k)));

function legacyReview(S, terms, n, rng) {
  const tpl = terms.legacy.grantTemplate;
  const grant = v1GrantFromJson({ ...tpl, budget: terms.split.legacy6, grantNonce: randomHex32(rng), signBefore: String(n + SIGN_WINDOW) });
  const vault = terms.legacy.vault;
  return { grant: jsonable(grant), digest: lower(S.grantDigest(CHAIN_ID, vault, grant)),
    sid: lower(S.sessionIdOf(vault, grant.sessionKey, grant.grantNonce)) };
}
function terminateReview(S, terms, n, rng) {
  const message = { sessionId: terms.legacy.oldSid, opNonce: randomHex32(rng), signBefore: n + OWNER_OP_WINDOW };
  return { message: jsonable(message), digest: lower(S.digestOf(CHAIN_ID, terms.legacy.vault, "Terminate", message)) };
}
const gasReviewJson = (built, recordId) => ({ grant: grantBody(built), digest: lower(built.digest), sid: lower(built.sessionId),
  recordId, keyHash: lower(built.typedData.message.sessionKey) });

export async function buildMigrationPlan({ S, evidence, runtime, scope, split, now, rng, subtle, gasStore, relayBase, gasExpiresAt }) {
  if (!split || split.legacy6 === undefined || split.gas6 === undefined) fail("split_required", "the split is an explicit plan field");
  const legacy6 = parseUint(split.legacy6, 128, "split.legacy6");
  const gas6 = parseUint(split.gas6, 128, "split.gas6");
  const fresh6 = evidence.state.balance6;
  if (legacy6 === 0n || gas6 === 0n) fail("split_zero", "both parts must be positive");
  if (legacy6 + gas6 !== fresh6) fail("split_total", `legacy ${legacy6} + gas ${gas6} must equal the fresh old balance ${fresh6}`);
  if (fresh6 > MAX_COMBINED6) fail("split_total", "combined budget may not exceed 30 USDC");
  if (gas6 !== GAS_GRANT_CANDIDATE.budget) fail("gas_budget_not_candidate", "gas part differs from the reviewed 1 USDC candidate");
  if (!runtime.intake?.openEnabled) fail("intake_off", "successor open intake is off; no plan is built");
  const n = BigInt(now);
  const old = evidence.grant;
  if (BigInt(old.expiresAt) <= n + SIGN_WINDOW) fail("legacy_expiring", "the old grant expires inside the signing window");
  const id = `migration:${evidence.sid}`;
  const prior = await gasStore.getJournal(id);
  if (prior && ORDER.some((k) => prior.steps?.[k]?.status !== "planned")) {
    fail("migration_in_progress", "a migration for this sid already has admitted steps; reconcile it, never re-plan over it");
  }

  const gas = await prepareGasOpen({ runtime, store: gasStore, relayBase, appIds: [...scope.appIds],
    legacyExpiresAt: old.expiresAt, expiresAt: gasExpiresAt ?? old.expiresAt, now: n, subtle, rng, signBefore: n + SIGN_WINDOW });
  const terms = jsonable({
    schema: MIGRATION_SCHEMA, chainId: CHAIN_ID, owner: evidence.owner, order: [...ORDER], notes: STEP_NOTES,
    legacy: { factory: evidence.factory, vault: evidence.vault, oldSid: evidence.sid, oldBalance6: fresh6, oldSpent6: 0n,
      keyHash: lower(old.sessionKey), grantTemplate: strip(old, REPLACED_FIELDS) },
    split: { legacy6, gas6, total6: fresh6, max6: MAX_COMBINED6 },
    gas: { factory: runtime.cfg.factory, implementation: runtime.cfg.implementation, vault: runtime.cfg.vault,
      usdc: runtime.pins.usdc, appIds: [...scope.appIds], deployments: [...scope.deployments.keys()].sort(),
      grantTemplate: strip(gas.review.typedData.message, GAS_VOLATILE) },
  });
  const plan = {
    id, kind: "migration", v: 2, rev: 1, termsHash: hashOf(terms), terms, at: Number(n),
    observed: { evidence: evidence.observed, scope: { block: Number(scope.block), hash: scope.blockHash ?? null } },
    steps: {
      terminate: { status: "planned", attempt: 1, review: terminateReview(S, terms, n, rng), history: [] },
      legacyOpen: { status: "planned", attempt: 1, review: legacyReview(S, terms, n, rng), history: [] },
      gasOpen: { status: "planned", attempt: 1, review: gasReviewJson(gas.review, gas.record.id), history: [] },
    },
  };
  await gasStore.casJournal(id, (cur) => {
    if (cur && ORDER.some((k) => cur.steps?.[k]?.status !== "planned")) fail("migration_in_progress", "another tab admitted a step meanwhile");
    return plan;
  });
  return plan;
}

// =====================================================================================================================
// 3. Sign (explicit click). Every review is rebuilt from the journal and must hash to its stored digest AND match the
//    approved terms. Signatures are returned in memory only.
// =====================================================================================================================

function checkTerms(plan, approval) {
  if (!approval || approval.rootReviewed !== true || approval.termsHash !== plan.termsHash || hashOf(plan.terms) !== plan.termsHash) {
    fail("approval_required", `no root-reviewed approval for terms ${plan.termsHash}; nothing was signed`);
  }
}

/** The exact replacement grant from the journal, checked against the reviewed template and its digest/sid. */
export function replacementFromJournal(S, plan) {
  const r = plan.steps.legacyOpen.review;
  const g = v1GrantFromJson(r.grant);
  const tpl = plan.terms.legacy.grantTemplate;
  const diff = Object.keys(tpl).filter((k) => canon(jsonable({ v: g[k] })) !== canon({ v: tpl[k] }));
  if (diff.length || String(g.budget) !== plan.terms.split.legacy6) fail("review_not_terms", `replacement differs from the reviewed terms in [${diff}]`);
  if (lower(S.grantDigest(CHAIN_ID, plan.terms.legacy.vault, g)) !== r.digest) fail("review_digest_mismatch", "replacement grant does not hash to its digest");
  if (lower(S.sessionIdOf(plan.terms.legacy.vault, g.sessionKey, g.grantNonce)) !== r.sid) fail("review_digest_mismatch", "replacement sid mismatch");
  return g;
}

function terminateFromJournal(S, plan) {
  const r = plan.steps.terminate.review;
  const m = { sessionId: parseHex32(r.message.sessionId, "sessionId", { nonZero: true }), opNonce: r.message.opNonce,
    signBefore: BigInt(r.message.signBefore) };
  if (m.sessionId !== plan.terms.legacy.oldSid) fail("review_not_terms", "Terminate names another session");
  if (lower(S.digestOf(CHAIN_ID, plan.terms.legacy.vault, "Terminate", m)) !== r.digest) fail("review_digest_mismatch", "Terminate does not hash to its digest");
  return m;
}

function gasFromJournal(plan, runtime, now) {
  const r = plan.steps.gasOpen.review;
  const built = rebuildGasReview(runtime.cfg, r.grant, r.digest, now);
  const tpl = plan.terms.gas.grantTemplate;
  const msg = strip(built.typedData.message, GAS_VOLATILE);
  if (canon(msg) !== canon(tpl) || lower(built.sessionId) !== r.sid || lower(built.typedData.message.sessionKey) !== r.keyHash) {
    fail("review_not_terms", "gas grant differs from the reviewed terms");
  }
  if (!sameAddr(runtime.cfg.vault, plan.terms.gas.vault)) fail("review_not_terms", "runtime vault differs from the reviewed one");
  return built;
}

export async function signSteps({ S, plan, steps, approval, provider, rpc, runtime, now }) {
  checkTerms(plan, approval);
  const n = BigInt(now);
  const pending = ORDER.filter((k) => plan.steps[k].status !== "proven");
  if (!Array.isArray(steps) || steps.length === 0 || steps.some((k) => !pending.includes(k))) fail("sign_steps", "sign only steps that are not proven");
  if (steps.join() !== pending.slice(0, steps.length).join()) fail("sign_steps", "sign the NEXT steps in order, without gaps");
  if (steps.includes("terminate") && !steps.includes("legacyOpen")) fail("sign_steps", "the original is only touched once its replacement is signed");
  for (const k of steps) if (plan.steps[k].status !== "planned") fail("step_not_planned", `${k} is ${plan.steps[k].status}; reconcile it`);
  const owner = plan.terms.owner;
  const vault = plan.terms.legacy.vault;
  const out = {};
  if (steps.includes("terminate")) {
    const m = terminateFromJournal(S, plan);
    if (n >= m.signBefore) fail("sign_window_passed", "Terminate window closed; rearm it");
    const sig = await walletSignTyped(provider, owner, S.typedData(CHAIN_ID, vault, "Terminate", m));
    out.terminate = { digest: plan.steps.terminate.review.digest, body: { owner, vault, op: "terminate", args: m, sig } };
  }
  if (steps.includes("legacyOpen")) {
    const g = replacementFromJournal(S, plan);
    if (n >= g.signBefore) fail("sign_window_passed", "replacement window closed; rearm it");
    const ownerSig = await walletSignTyped(provider, owner, S.typedData(CHAIN_ID, vault, "SessionGrant", g));
    const dep = depositTypedData(await usdcDomain(rpc, plan.terms.gas.usdc), { from: owner, to: vault, value: g.budget,
      nonce: plan.steps.legacyOpen.review.digest, validBefore: g.signBefore });
    const depSig = await walletSignTyped(provider, owner, dep);
    out.legacyOpen = { digest: plan.steps.legacyOpen.review.digest,
      body: { owner, grant: g, ownerSig, deposit: { validAfter: 0n, validBefore: g.signBefore, sig: depSig } } };
  }
  if (steps.includes("gasOpen")) {
    const built = gasFromJournal(plan, runtime, n);
    const body = await signGasOpen({ runtime, provider, rpc, review: built, now: n,
      approval: { rootReviewed: true, digest: plan.steps.gasOpen.review.digest } });
    out.gasOpen = { digest: plan.steps.gasOpen.review.digest, body };
  }
  return Object.freeze(out);
}

// =====================================================================================================================
// 4. Proofs per step (shared by run and reconcile) and post-proof adoption (idempotent)
// =====================================================================================================================

const stepEvent = (plan, k) => (k === "terminate"
  ? { address: plan.terms.legacy.vault, topics: encodeEventTopics({ abi: VAULT_EVENTS, eventName: "SessionEnded", args: { sid: plan.terms.legacy.oldSid } }) }
  : { address: k === "legacyOpen" ? plan.terms.legacy.vault : plan.terms.gas.vault,
    topics: encodeEventTopics({ abi: VAULT_EVENTS, eventName: "SessionOpened", args: { sid: plan.steps[k].review.sid } }) });

/** null = not canonical yet. Throws when the receipt contradicts the step (wrong refund, scope, key, amount...) and
 *  `tx_reverted` when the canonical receipt reverted. */
export async function proveStep(ctx, plan, k, txHash) {
  const { S, chain } = ctx;
  const rc = await chain.receipt(txHash);
  if (!rc) return null;
  const owner = plan.terms.owner;
  const usdc = plan.terms.gas.usdc;
  if (k === "terminate") {
    proveEnded(rc, { vault: plan.terms.legacy.vault, usdc, owner, sid: plan.terms.legacy.oldSid, refund6: BigInt(plan.terms.legacy.oldBalance6) });
  } else if (k === "legacyOpen") {
    const g = replacementFromJournal(S, plan);
    proveOpened(rc, { vault: plan.terms.legacy.vault, usdc, owner, sid: plan.steps.legacyOpen.review.sid, keyHash: plan.terms.legacy.keyHash,
      digest: plan.steps.legacyOpen.review.digest, amount6: g.budget, expiresAt: g.expiresAt, actions: actionsMaskV1(S, g.actions),
      envs: envMask(g.environments) });
    compareGrantToChain(S, g, await chain.sessionOf(plan.terms.legacy.vault, plan.steps.legacyOpen.review.sid), "replacement");
  } else {
    const r = plan.steps.gasOpen.review;
    proveOpened(rc, { vault: plan.terms.gas.vault, usdc, owner, sid: r.sid, keyHash: r.keyHash, digest: r.digest,
      amount6: BigInt(r.grant.budget), expiresAt: BigInt(r.grant.expiresAt), actions: 1n << 10n, envs: 3 });
  }
  const fin = chain.finality ? await chain.finality(rc) : { final: false };
  if (ctx.requireFinal && !fin.final) return null;
  return { txHash: lower(txHash), block: Number(BigInt(rc.blockNumber)), blockHash: lower(rc.blockHash), final: Boolean(fin.final) };
}

/** Adds the replacement record next to the old one (same CryptoKey, rebuilt from the journal's exact grant) and moves the
 *  active pointer through the caller. The old record is never modified or removed. Safe to repeat. */
export async function adoptReplacement(ctx, plan) {
  const { S, legacyStore, setActive, now } = ctx;
  const old = await legacyStore.load(plan.terms.legacy.oldSid);
  if (!old || lower(old.keyHash) !== plan.terms.legacy.keyHash) fail("legacy_record_lost", "the original record (holding the key) is missing; STOP");
  const g = replacementFromJournal(S, plan);
  const sid = plan.steps.legacyOpen.review.sid;
  const existing = await legacyStore.load(sid);
  if (existing && lower(existing.keyHash) !== plan.terms.legacy.keyHash) fail("record_collision", "another record uses the replacement sid");
  if (!existing) {
    await legacyStore.save({ ...old, id: sid, grant: g, createdAt: Number(now), handle: { ...old.handle, sid } });
  }
  const kept = await legacyStore.load(old.id);
  if (!kept || kept.keyHash !== old.keyHash) fail("legacy_record_lost", "the old record must survive the migration");
  if (typeof setActive === "function") await setActive(sid, plan.terms.legacy.oldSid);
  return sid;
}

async function adoptGas(ctx, plan, proof) {
  const r = plan.steps.gasOpen.review;
  const rec = await ctx.gasStore.loadKey(r.recordId);
  if (!rec || lower(rec.keyHash) !== r.keyHash) fail("gas_record_lost", "the gas key record is missing");
  if (rec.status === "open" && lower(rec.sid) === r.sid) return;
  Object.assign(rec, { status: "open", sid: r.sid, grant: r.grant, grantDigest: r.digest, open: { txHash: proof.txHash, block: proof.block } });
  await ctx.gasStore.saveKey(rec);
}

async function afterProven(ctx, plan, k, proof) {
  if (k === "legacyOpen") await adoptReplacement(ctx, plan);
  if (k === "gasOpen") await adoptGas(ctx, plan, proof);
}

// =====================================================================================================================
// 5. Journal transitions (all compare-and-set)
// =====================================================================================================================

function cas(ctx, id, k, fn) {
  return ctx.gasStore.casJournal(id, (cur) => {
    if (!cur) fail("plan_missing", "no journaled plan");
    fn(cur.steps[k], cur);
    cur.rev = Number(cur.rev ?? 0) + 1;
    return cur;
  });
}
const admit = (ctx, id, k, digest, observed) => cas(ctx, id, k, (st, cur) => {
  if (st.status !== "planned" || st.review.digest !== digest) fail("step_not_planned", `${k} is ${st.status} (or was re-armed); nothing sent`);
  for (const p of ORDER.slice(0, ORDER.indexOf(k))) if (cur.steps[p].status !== "proven") fail("previous_unproven", `${p} is not proven`);
  Object.assign(st, { status: "admitted", admittedAt: Number(ctx.now), observed });
});
const noteSubmitted = (ctx, id, k, txHash) => cas(ctx, id, k, (st) => {
  if (st.status !== "admitted" && !(st.status === "submitted" && st.txHash === txHash)) fail("step_state", `${k} is ${st.status}`);
  Object.assign(st, { status: "submitted", txHash });
});
const noteError = (ctx, id, k, code) => cas(ctx, id, k, (st) => { st.lastError = String(code ?? "error"); });
const markProven = (ctx, id, k, proof) => cas(ctx, id, k, (st) => {
  if (st.status === "proven") return;
  if (st.status !== "admitted" && st.status !== "submitted") fail("step_state", `${k} is ${st.status}`);
  Object.assign(st, { status: "proven", txHash: proof.txHash, proof: { block: proof.block, blockHash: proof.blockHash, final: proof.final } });
});

// =====================================================================================================================
// 6. Run (explicit click): submit the NEXT planned steps that have a matching in-memory signature, one at a time,
//    each re-checked at a fresh pinned block first and proven on chain before the next.
// =====================================================================================================================

async function preconditions(ctx, plan, k) {
  const { S, chain, legacyStore, gasStore } = ctx;
  const T = plan.terms;
  const pin = await chain.pin(ctx.now);
  const used = (d) => chain.authorizationUsed(T.gas.usdc, T.owner, d, pin.tag);
  if (k === "terminate") {
    const old = await legacyStore.load(T.legacy.oldSid);
    if (!old || lower(old.keyHash) !== T.legacy.keyHash) fail("legacy_record_lost", "original record missing; the original stays untouched");
    const st = await chain.sessionOf(T.legacy.vault, T.legacy.oldSid, pin.tag);
    if (!st.live || st.balance6 !== BigInt(T.legacy.oldBalance6) || st.spent6 !== 0n) fail("legacy_state_changed", "the old session changed since the plan; STOP");
    compareGrantToChain(S, old.grant, st, "old session");
    if (await used(plan.steps.legacyOpen.review.digest)) fail("legacy_auth_used", "replacement authorization already used");
  } else if (k === "legacyOpen") {
    if (!(await legacyStore.load(T.legacy.oldSid))) fail("legacy_record_lost", "original record (the key) missing; not opening");
    if ((await chain.sessionOf(T.legacy.vault, plan.steps.legacyOpen.review.sid, pin.tag)).state !== 0) fail("replacement_exists", "replacement sid already exists; reconcile");
    if (await used(plan.steps.legacyOpen.review.digest)) fail("legacy_auth_used", "replacement authorization already used; reconcile");
    if ((await chain.usdcBalance(T.gas.usdc, T.owner, pin.tag)) < BigInt(T.split.legacy6)) fail("owner_balance_short", "owner wallet lacks the replacement amount");
  } else {
    if (!ctx.runtime.intake?.openEnabled) fail("intake_off", "successor open intake is off");
    const rec = await gasStore.loadKey(plan.steps.gasOpen.review.recordId);
    if (!rec || lower(rec.keyHash) !== plan.steps.gasOpen.review.keyHash) fail("gas_record_lost", "gas key record missing");
    if (await used(plan.steps.gasOpen.review.digest)) fail("gas_auth_used", "gas authorization already used; reconcile");
    if ((await chain.usdcBalance(T.gas.usdc, T.owner, pin.tag)) < BigInt(T.split.gas6)) fail("owner_balance_short", "owner wallet lacks the gas amount");
  }
  await pin.recheck();
  return { block: Number(pin.number), hash: pin.hash, timestamp: Number(pin.timestamp) };
}

const SEND = {
  terminate: (ctx, body) => ctx.legacyRelay.request("POST", "/owner", body),
  legacyOpen: (ctx, body) => ctx.legacyRelay.request("POST", "/open", body),
  gasOpen: (ctx, body) => ctx.relay("POST", "/funding/open", body),
};

export async function runMigration(ctx, planId, signed) {
  for (;;) {
    const plan = await ctx.gasStore.getJournal(planId);
    if (!plan) fail("plan_missing", "no journaled plan");
    const k = ORDER.find((s) => plan.steps[s].status !== "proven");
    if (!k) return { done: true, steps: statusOf(plan) };
    const st = plan.steps[k];
    if (st.status !== "planned") return { stage: k, needsReconcile: true, steps: statusOf(plan) };
    const sg = signed?.[k];
    if (!sg || lower(sg.digest) !== st.review.digest) return { stage: k, needsSignature: true, steps: statusOf(plan) };
    if (k === "terminate" && signed?.legacyOpen?.digest !== plan.steps.legacyOpen.review.digest) {
      fail("replacement_unsigned", "the original is only terminated with its replacement already signed");
    }
    const observed = await preconditions(ctx, plan, k);
    await admit(ctx, planId, k, st.review.digest, observed);
    let out;
    try { out = await SEND[k](ctx, sg.body); }
    catch (err) { await noteError(ctx, planId, k, err?.code); throw err; }   // stays admitted: ambiguous, never resent
    const txHash = typeof out?.txHash === "string" ? lower(out.txHash) : null;
    if (!txHash) return { stage: k, pending: true, steps: statusOf(await ctx.gasStore.getJournal(planId)) };
    await noteSubmitted(ctx, planId, k, txHash);
    if (out.sid !== undefined && k !== "terminate" && lower(out.sid) !== st.review.sid) {
      await noteError(ctx, planId, k, "relay_sid_mismatch");
      fail("relay_sid_mismatch", `relay reported ${out.sid}, expected ${st.review.sid}`);
    }
    let proof;
    try { proof = await proveStep(ctx, await ctx.gasStore.getJournal(planId), k, txHash); }
    catch (err) { await noteError(ctx, planId, k, err?.code); throw err; }  // stays submitted: reconcile decides
    if (!proof) return { stage: k, pending: true, txHash, steps: statusOf(await ctx.gasStore.getJournal(planId)) };
    await markProven(ctx, planId, k, proof);
    await afterProven(ctx, await ctx.gasStore.getJournal(planId), k, proof);
  }
}

const statusOf = (plan) => Object.fromEntries(ORDER.map((k) => [k, plan.steps[k].status]));

// =====================================================================================================================
// 7. Reconcile (explicit click, read only towards the relay): prove submitted/admitted steps from the chain, adopt
//    proven results (record + pointer), or prove a step void once its window closed. Never submits anything.
// =====================================================================================================================

async function notApplied(ctx, plan, k) {
  const { chain } = ctx;
  const T = plan.terms;
  if (k === "terminate") {
    const st = await chain.sessionOf(T.legacy.vault, T.legacy.oldSid);
    return st.live && st.balance6 === BigInt(T.legacy.oldBalance6);
  }
  const r = plan.steps[k].review;
  if (await chain.authorizationUsed(T.gas.usdc, T.owner, r.digest)) return false;
  if (k === "legacyOpen") return (await chain.sessionOf(T.legacy.vault, r.sid)).state === 0;
  return true;
}
const windowOf = (plan, k) => BigInt(k === "terminate" ? plan.steps[k].review.message.signBefore : plan.steps[k].review.grant.signBefore);

export async function reconcileMigration(ctx, planId) {
  const report = [];
  for (const k of ORDER) {
    let plan = await ctx.gasStore.getJournal(planId);
    const st = plan.steps[k];
    if (st.status === "proven") { await afterProven(ctx, plan, k, { txHash: st.txHash, block: st.proof.block }); report.push({ k, status: "proven" }); continue; }
    if (st.status === "planned" || st.status === "void") {
      report.push({ k, status: st.status, next: st.status === "void" || BigInt(ctx.now) >= windowOf(plan, k) ? "rearm" : "sign" });
      break;
    }
    // admitted / submitted: find THE transaction (journaled hash, else the step's own event) and prove it
    let hashes = st.txHash ? [st.txHash] : [];
    if (!hashes.length && st.observed) {
      const ev = stepEvent(plan, k);
      const logs = await ctx.chain.getLogs({ address: ev.address, topics: ev.topics, fromBlock: st.observed.block });
      hashes = [...new Set(logs.filter((l) => l.removed !== true).map((l) => lower(l.transactionHash)))];
    }
    let proof = null;
    let reverted = 0;
    for (const h of hashes) {
      try { proof = await proveStep(ctx, plan, k, h); }        // a contradicting receipt throws: STOP for review
      catch (e) { if (e?.code === "tx_reverted") { reverted += 1; continue; } throw e; }
      if (proof) break;
    }
    if (proof) {
      if (!st.txHash) await noteSubmitted(ctx, planId, k, proof.txHash);
      await markProven(ctx, planId, k, proof);
      plan = await ctx.gasStore.getJournal(planId);
      await afterProven(ctx, plan, k, proof);
      report.push({ k, status: "proven" });
      continue;
    }
    if (hashes.length > reverted) { report.push({ k, status: st.status, next: "wait_canonical" }); break; }
    if (BigInt(ctx.now) < windowOf(plan, k)) { report.push({ k, status: st.status, next: "wait_window" }); break; }
    if (!(await notApplied(ctx, plan, k))) fail("step_contradiction", `${k}: chain shows an effect without a provable transaction; STOP for review`);
    await cas(ctx, planId, k, (s) => {
      if (s.status !== st.status || (s.txHash ?? null) !== (st.txHash ?? null)) fail("step_state", `${k} changed meanwhile`);
      s.status = "void";
      s.voidAt = Number(ctx.now);
    });
    report.push({ k, status: "void", next: "rearm" });
    break;
  }
  const plan = await ctx.gasStore.getJournal(planId);
  return { steps: statusOf(plan), report };
}

/** A fresh review (new nonce, new window) for a step that is void or never admitted. Terms are unchanged, so the same
 *  approval applies; the owner signs again by explicit click. */
export async function rearmStep(ctx, planId, k) {
  const { S, runtime, rng } = ctx;
  const n = BigInt(ctx.now);
  const plan = await ctx.gasStore.getJournal(planId);
  const st = plan.steps[k];
  if (st.status !== "void" && st.status !== "planned") fail("step_not_rearmable", `${k} is ${st.status}; reconcile it`);
  let review;
  if (k === "terminate") review = terminateReview(S, plan.terms, n, rng);
  else if (k === "legacyOpen") review = legacyReview(S, plan.terms, n, rng);
  else {
    const old = st.review;
    const built = buildGasGrant(runtime.cfg, { now: n, sessionKey: old.keyHash, appIds: plan.terms.gas.appIds,
      expiresAt: plan.terms.gas.grantTemplate.expiresAt, legacyExpiresAt: plan.terms.legacy.grantTemplate.expiresAt,
      grantNonce: randomHex32(rng), signBefore: n + SIGN_WINDOW, label: plan.terms.gas.grantTemplate.label });
    review = gasReviewJson(built, old.recordId);
    const rec = await ctx.gasStore.loadKey(old.recordId);
    Object.assign(rec, { status: "reviewed", sid: review.sid, grant: review.grant, grantDigest: review.digest });
    await ctx.gasStore.saveKey(rec);
  }
  await cas(ctx, planId, k, (s) => {
    if (s.status !== st.status || s.review.digest !== st.review.digest) fail("step_state", `${k} changed meanwhile`);
    s.history.push({ attempt: s.attempt, digest: s.review.digest, status: s.status, txHash: s.txHash ?? null });
    Object.assign(s, { status: "planned", attempt: s.attempt + 1, review });
    delete s.txHash; delete s.observed; delete s.lastError; delete s.admittedAt; delete s.voidAt;
  });
  return ctx.gasStore.getJournal(planId);
}
