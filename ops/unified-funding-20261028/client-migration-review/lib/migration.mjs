// UNREVIEWED SOURCE (unified-funding client-migration-r1). Budget migration of the live legacy $30 session into
// replacement-legacy (API, domain "1", SAME key) + successor gas-only (domain "2", fresh key). NOT approved, NOT signable
// until root review; nothing here runs on import or page load.
//
// Concrete constraints found in the deployed source (they change the proposed sequence, not the split):
//   - SessionVault._end (owner terminate) sends the escrow refund straight to the OWNER WALLET (`_send(owner, refund)`);
//     no free vault balance is created, so there is nothing to withdraw and the "withdraw exactly $1" step is not needed;
//   - the original relay's POST /open always uses factory.openWithDepositFor when budget > 0 (relay/sessions.mjs), so the
//     replacement legacy grant is funded by an owner EIP-3009 authorization from the refunded wallet balance;
//   - therefore: terminate(old 30) -> openWithDepositFor(legacy 29) -> successor openWithDeposit(gas 1). Deposits total
//     exactly the refund; no new budget. The API is down from terminate (relay marks the sid revoked after simulation)
//     until the replacement open is mined.
// The v1 SDK module `S` is the vendored /vendor/sessions.js (passed in, never re-implemented): grantDigest, sessionIdOf,
// typedData, digestOf, sessionVaultAbi, ACTIONS, RelayClient. The legacy key is reused BY REFERENCE inside the SDK store.
import { decodeEventLog, parseAbi } from "../../../source/node_modules/viem/_esm/index.js";
import { parseAddress, parseHex32, parseUint, keyHashOf } from "../../client-r1/funding-codec.mjs";
import { canon, fail, hashOf, jsonable, lower, randomHex32, sameAddr } from "./util.mjs";
import {
  CHAIN_ID, GAS_GRANT_CANDIDATE, OWNER_OP_WINDOW, SIGN_WINDOW, canonicalReceipt, depositTypedData, ethCall,
  prepareGasOpen, signGasOpen, submitGasOpen, usdcDomain, walletSignTyped,
} from "./funding-client.mjs";

export const MIGRATION_SCHEMA = "enclave-funding-migration-plan-r1";
export const MAX_COMBINED6 = 30_000_000n;
export const V1_GRANT_FIELDS = Object.freeze(["label", "preset", "sessionKey", "actions", "apps", "environments", "budget",
  "spendPerPeriod", "periodSeconds", "opsPerPeriod", "maxFeePerOp", "maxAppFeePerHour", "maxRatePerHour", "expiresAt",
  "measurement", "grantNonce", "signBefore"]);
export const REPLACED_FIELDS = Object.freeze(["budget", "grantNonce", "signBefore"]);
export const ORDER = Object.freeze(["terminate", "legacyOpen", "gasOpen"]);
export const STEP_NOTES = Object.freeze({
  withdraw: "not-applicable: SessionVault._end refunds the old escrow to the owner wallet; no vault free balance is created",
  legacyFunding: "relay POST /open -> factory.openWithDepositFor (owner EIP-3009, nonce = replacement grant digest)",
  gasFunding: "relay POST /v1/sessions/funding/open -> successor openWithDeposit (owner EIP-3009, nonce = gas grant digest)",
  interruption: "API session auth stops when the original relay simulates terminate (store.data.revoked) and resumes when the "
    + "replacement open is mined and this browser's active pointer moves to the new sid: two relay round trips + two Base "
    + "blocks if nothing fails; unbounded if a step must be reconciled (see RECOVERY).",
});

/** Concrete partial states and the only allowed next action. Nothing is ever resent automatically. */
export const RECOVERY = Object.freeze({
  "terminate:unknown": "read sessionOf(oldSid): live -> the signed Terminate may still land until signBefore; wait past it, then a NEW plan. Not live -> mark done via reconcile, continue.",
  "terminate:refused": "nothing changed on chain if sessionOf(oldSid) is live; the API may still be refused by the relay's off-chain revoke - rebuild the plan or keep the old session.",
  "terminate:pending": "wait for the canonical receipt (reconcile); never resubmit.",
  "legacyOpen:unknown": "read sessionOf(newSid) and USDC authorizationState(owner, legacyDigest). Opened -> reconcile, continue. Not opened and signBefore passed -> owner wallet holds the $30 refund; build a fresh replacement (new grantNonce, same fields). API is DOWN meanwhile.",
  "legacyOpen:refused": "owner wallet holds the $30 refund; API is DOWN. Build a fresh replacement plan from the SAME persisted record (the old record is kept for exactly this).",
  "legacyOpen:pending": "wait for the canonical receipt (reconcile); API is DOWN until it lands.",
  "gasOpen:unknown": "relay GET /funding/session/<vault>/<gasSid> and authorizationState(owner, gasDigest). API is unaffected; $1 stays in the owner wallet if not opened.",
  "gasOpen:refused": "API is unaffected; $1 stays in the owner wallet. Re-prepare the gas grant later (fresh key) after review.",
});

const LOCAL_ABI = parseAbi([
  "function owner() view returns (address)",
  "function free() view returns (uint256)",
  "function vaultFor(address owner) view returns (address)",
  "function balanceOf(address account) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

// =====================================================================================================================
// Chain adapter (JSON-RPC). Tests replace it with a scripted object of the same shape.
// =====================================================================================================================

export function legacyChain(rpc, S) {
  const call = (to, fn, args, block = "latest", abi = LOCAL_ABI) => ethCall(rpc, to, fn, args, block, abi);
  return Object.freeze({
    async sessionOf(vault, sid) {
      const [s, live, apps] = await call(vault, "sessionOf", [sid], "latest", S.sessionVaultAbi);
      return normState(s, live, apps);
    },
    owner: (vault) => call(vault, "owner", []),
    free: async (vault) => BigInt(await call(vault, "free", [])),
    vaultFor: (factory, owner) => call(factory, "vaultFor", [owner]),
    usdcBalance: async (usdc, who) => BigInt(await call(usdc, "balanceOf", [who])),
    authorizationUsed: (usdc, who, nonce) => call(usdc, "authorizationState", [who, nonce]),
    receipt: (txHash) => canonicalReceipt(rpc, txHash),
  });
}

export function normState(s, live, apps) {
  return Object.freeze({
    live: Boolean(live), state: Number(s.state), keyHash: lower(s.keyHash), measurement: lower(s.measurement),
    actions: BigInt(s.actions), expiresAt: BigInt(s.expiresAt), envs: Number(s.envs), anyApp: Boolean(s.anyApp),
    balance6: BigInt(s.balance6), spent6: BigInt(s.spent6), perPeriod6: BigInt(s.perPeriod6), maxFee6: BigInt(s.maxFee6),
    maxAppFeeHour6: BigInt(s.maxAppFeeHour6), period: Number(s.period), opsPerPeriod: Number(s.opsPerPeriod),
    periodSpent6: BigInt(s.periodSpent6), apps: Object.freeze([...(apps ?? [])].map(lower)),
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
const envMask = (envs) => envs.reduce((m, e) => m | ({ staging: 1, prod: 2 }[e] ?? fail("legacy_env_unknown", `environment ${e}`)), 0);

/** Every grant-derived field the vault mirrors must equal the chain; label/preset/maxRatePerHour are not mirrored and
 *  come from the persisted record only (bound by sid = keccak(vault, sessionKey, grantNonce) and the key itself). */
function compareGrantToChain(S, g, st, what) {
  const want = {
    keyHash: lower(g.sessionKey), measurement: lower(g.measurement), actions: actionsMaskV1(S, g.actions),
    expiresAt: BigInt(g.expiresAt), envs: envMask(g.environments), perPeriod6: BigInt(g.spendPerPeriod),
    maxFee6: BigInt(g.maxFeePerOp), maxAppFeeHour6: BigInt(g.maxAppFeePerHour), period: Number(g.periodSeconds),
    opsPerPeriod: Number(g.opsPerPeriod),
  };
  const diff = Object.keys(want).filter((k) => want[k] !== st[k]);
  if (diff.length) fail("legacy_fields_mismatch", `${what}: persisted grant differs from chain in [${diff}]`, { diff });
  if (g.apps.length !== 0) fail("legacy_apps_unverifiable", "app-scoped legacy grants cannot be reproduced offline; STOP");
  if (st.apps.length !== 0 || st.anyApp !== true) fail("legacy_fields_mismatch", `${what}: chain apps differ from an any-app grant`);
}

// =====================================================================================================================
// 1. Evidence: the persisted legacy record + fresh chain reads. Any gap -> STOP (never synthesised).
// =====================================================================================================================

export async function loadLegacyEvidence({ S, legacyStore, sid, owner, chain, legacyConfig, runtime }) {
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
  if (!sameAddr(await chain.vaultFor(factory, o), vault)) fail("legacy_vault_mismatch", "factory.vaultFor(owner) is not the record's vault");
  if (!sameAddr(await chain.owner(vault), o)) fail("legacy_owner_mismatch", "vault.owner() is not the connected owner");
  if (!sameAddr(runtime.cfg.legacyVault, vault)) fail("legacy_vault_mismatch", "successor config legacyVault differs from the record's vault");

  const st = await chain.sessionOf(vault, id);
  if (!st.live) fail("legacy_not_live", "the old session is not live; STOP");
  compareGrantToChain(S, g, st, "old session");
  if (st.spent6 !== 0n || st.periodSpent6 !== 0n || st.balance6 !== BigInt(g.budget)) {
    fail("legacy_state_changed", `balance ${st.balance6} / spent ${st.spent6} is not the untouched ${g.budget}; STOP`, { balance6: st.balance6, spent6: st.spent6 });
  }
  const free6 = await chain.free(vault);
  return Object.freeze({ record: rec, grant: g, vault, sid: id, owner: o, factory, state: st, free6 });
}

// =====================================================================================================================
// 2. Plan (no wallet): replacement legacy grant, gas grant (fresh key saved in the v2 store), Terminate typed data.
//    `terms` holds everything a reviewer approves and nothing that changes per build (no nonces, windows, blocks).
// =====================================================================================================================

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
  const prior = await gasStore.getJournal(`migration:${evidence.sid}`);
  if (prior && Object.values(prior.steps ?? {}).some((s) => s !== "planned")) {
    fail("migration_in_progress", "a migration for this sid already has submitted steps; reconcile it, never re-plan over it");
  }

  const replacement = { ...old, budget: legacy6, grantNonce: randomHex32(rng), signBefore: n + SIGN_WINDOW };
  const changed = V1_GRANT_FIELDS.filter((k) => canon(jsonable({ v: replacement[k] })) !== canon(jsonable({ v: old[k] })));
  if (changed.some((k) => !REPLACED_FIELDS.includes(k))) fail("replacement_changed_scope", `replacement changes [${changed}]`);
  const chainId = CHAIN_ID;
  const legacyDigest = lower(S.grantDigest(chainId, evidence.vault, replacement));
  const newLegacySid = lower(S.sessionIdOf(evidence.vault, replacement.sessionKey, replacement.grantNonce));
  if (newLegacySid === evidence.sid) fail("replacement_sid_reused", "replacement sid equals the old sid");
  const legacyTd = S.typedData(chainId, evidence.vault, "SessionGrant", replacement);

  const terminateMsg = { sessionId: evidence.sid, opNonce: randomHex32(rng), signBefore: n + OWNER_OP_WINDOW };
  const terminateTd = S.typedData(chainId, evidence.vault, "Terminate", terminateMsg);
  const terminateDigest = lower(S.digestOf(chainId, evidence.vault, "Terminate", terminateMsg));

  const gas = await prepareGasOpen({ runtime, store: gasStore, relayBase, appIds: [...scope.appIds],
    legacyExpiresAt: old.expiresAt, expiresAt: gasExpiresAt ?? old.expiresAt, now: n, subtle, rng, signBefore: n + SIGN_WINDOW });
  const gm = gas.review.typedData.message;

  const strip = (g, ks) => Object.fromEntries(Object.entries(jsonable(g)).filter(([k]) => !ks.includes(k)));
  const terms = jsonable({
    schema: MIGRATION_SCHEMA, chainId, owner: evidence.owner, order: [...ORDER], notes: STEP_NOTES,
    legacy: { factory: evidence.factory, vault: evidence.vault, oldSid: evidence.sid, oldBalance6: fresh6, oldSpent6: 0n,
      keyHash: lower(old.sessionKey), grantTemplate: strip(old, REPLACED_FIELDS) },
    split: { legacy6, gas6, total6: fresh6, max6: MAX_COMBINED6 },
    gas: { factory: runtime.cfg.factory, implementation: runtime.cfg.implementation, vault: runtime.cfg.vault,
      appIds: [...scope.appIds], deployments: [...scope.deployments.keys()].sort(),
      grantTemplate: strip(gm, ["sessionKey", "grantNonce", "signBefore"]) },
  });
  const termsHash = hashOf(terms);
  const plan = {
    id: `migration:${evidence.sid}`, kind: "migration", termsHash, terms,
    digests: { terminate: terminateDigest, legacyGrant: legacyDigest, gasGrant: lower(gas.review.digest) },
    newLegacySid, gasSid: lower(gas.review.sessionId), gasRecordId: gas.record.id, gasKeyHash: gas.record.keyHash,
    scopeBlock: Number(scope.block), signBefore: Number(n + OWNER_OP_WINDOW),
    steps: { terminate: "planned", legacyOpen: "planned", gasOpen: "planned" }, at: Number(n),
  };
  await gasStore.putJournal(plan);
  const internal = Object.freeze({ replacement, legacyTd, terminateTd, terminateMsg, gasReview: gas.review, gasRecord: gas.record,
    evidence, legacy6, gas6 });
  return { plan, internal };
}

// =====================================================================================================================
// 3. Sign (explicit click, root approval bound to termsHash): five wallet prompts, signatures kept in memory only
// =====================================================================================================================

export async function signMigration({ plan, internal, approval, provider, rpc, runtime, now }) {
  if (!approval || approval.rootReviewed !== true || approval.termsHash !== plan.termsHash || hashOf(plan.terms) !== plan.termsHash) {
    fail("approval_required", `no root-reviewed approval for terms ${plan.termsHash}; nothing was signed`);
  }
  if (BigInt(now) > BigInt(plan.signBefore)) fail("sign_window_passed", "the plan's signing window passed; build a new plan");
  const owner = plan.terms.owner;
  const e = internal.evidence;
  const terminateSig = await walletSignTyped(provider, owner, internal.terminateTd);
  const legacySig = await walletSignTyped(provider, owner, internal.legacyTd);
  const usdc = await usdcDomain(rpc, runtime.pins.usdc);
  const dep = depositTypedData(usdc, { from: owner, to: e.vault, value: internal.legacy6, nonce: plan.digests.legacyGrant,
    validBefore: internal.replacement.signBefore });
  const legacyDepSig = await walletSignTyped(provider, owner, dep);
  // the gas grant's terms are inside termsHash; this binds signGasOpen's per-digest approval to the reviewed plan
  const gasOpen = await signGasOpen({ runtime, provider, rpc, review: internal.gasReview, now,
    approval: { rootReviewed: true, digest: plan.digests.gasGrant } });
  return Object.freeze({
    terminate: { owner, vault: e.vault, op: "terminate", args: internal.terminateMsg, sig: terminateSig },
    legacyOpen: { owner, grant: internal.replacement, ownerSig: legacySig,
      deposit: { validAfter: 0n, validBefore: internal.replacement.signBefore, sig: legacyDepSig } },
    gasOpen,
  });
}

// =====================================================================================================================
// 4. Execute (explicit click): one step at a time, each verified on the canonical chain before the next
// =====================================================================================================================

const unreachable = (e) => e?.code === "relay_unreachable" || /relay unreachable/.test(String(e?.message));

async function setStep(store, id, step, status, extra = {}) {
  const p = await store.getJournal(id);
  p.steps[step] = status;
  if (extra.txHash) p[`${step}Tx`] = extra.txHash;
  if (extra.code) p[`${step}Code`] = String(extra.code);
  await store.putJournal(p);
  return p;
}

function endedLog(S, rc, vault, sid) {
  const out = [];
  for (const l of rc.logs ?? []) {
    if (!sameAddr(l.address, vault)) continue;
    try {
      const ev = decodeEventLog({ abi: S.sessionVaultAbi, topics: l.topics, data: l.data, strict: true });
      if (ev.eventName === "SessionEnded" && lower(ev.args.sid) === sid) out.push(ev.args);
    } catch { /* other events */ }
  }
  if (out.length !== 1) fail("terminate_log", `expected one SessionEnded for ${sid}, found ${out.length}`);
  return out[0];
}

export async function executeMigration({ S, plan, internal, signed, legacyRelay, relay, chain, rpc, runtime, legacyStore,
  gasStore, setActive, now }) {
  const e = internal.evidence;
  const p0 = await gasStore.getJournal(plan.id);
  if (!p0 || p0.termsHash !== plan.termsHash) fail("plan_missing", "the plan is not journaled");
  if (ORDER.some((k) => p0.steps[k] !== "planned")) fail("step_not_planned", "a step was already attempted; reconcile, never resend", { steps: p0.steps });
  const owner = plan.terms.owner;
  const usdc = runtime.pins.usdc;

  // ---- terminate (old legacy, domain 1) -----------------------------------------------------------------------------
  const st0 = await chain.sessionOf(e.vault, e.sid);
  if (!st0.live || st0.balance6 !== e.state.balance6 || st0.spent6 !== 0n) fail("legacy_state_changed", "the old session changed since the plan; STOP");
  await setStep(gasStore, plan.id, "terminate", "submitting");
  let t;
  try { t = await legacyRelay.request("POST", "/owner", signed.terminate); }
  catch (err) { await setStep(gasStore, plan.id, "terminate", unreachable(err) ? "unknown" : "refused", { code: err.code }); throw err; }
  const tTx = lower(t.txHash);
  const trc = await chain.receipt(tTx);
  if (!trc) { await setStep(gasStore, plan.id, "terminate", "pending", { txHash: tTx }); return { stage: "terminate", pending: true, txHash: tTx }; }
  const ended = endedLog(S, trc, e.vault, e.sid);
  if (BigInt(ended.refund6) !== e.state.balance6 || BigInt(ended.fee6) !== 0n) fail("terminate_refund", `refund ${ended.refund6} fee ${ended.fee6} is not the full ${e.state.balance6}`);
  if ((await chain.sessionOf(e.vault, e.sid)).live) fail("terminate_not_final", "old session still live after the receipt");
  await setStep(gasStore, plan.id, "terminate", "done", { txHash: tTx });

  // ---- replacement legacy open (same key, budget legacy6, funded by EIP-3009 from the refunded wallet) ---------------
  if (await chain.authorizationUsed(usdc, owner, plan.digests.legacyGrant)) fail("legacy_auth_used", "the replacement authorization is already used; reconcile");
  if ((await chain.usdcBalance(usdc, owner)) < internal.legacy6 + internal.gas6) fail("owner_balance_short", "owner wallet lacks the refunded amount; STOP before opening");
  await setStep(gasStore, plan.id, "legacyOpen", "submitting");
  let o;
  try { o = await legacyRelay.request("POST", "/open", signed.legacyOpen); }
  catch (err) { await setStep(gasStore, plan.id, "legacyOpen", unreachable(err) ? "unknown" : "refused", { code: err.code }); throw err; }
  if (lower(o.sid) !== plan.newLegacySid) fail("relay_sid_mismatch", `relay opened ${o.sid}, expected ${plan.newLegacySid}`);
  const oTx = lower(o.txHash);
  if (!(await chain.receipt(oTx))) { await setStep(gasStore, plan.id, "legacyOpen", "pending", { txHash: oTx }); return { stage: "legacyOpen", pending: true, txHash: oTx }; }
  const st1 = await chain.sessionOf(e.vault, plan.newLegacySid);
  if (!st1.live || st1.balance6 !== internal.legacy6) fail("replacement_state", "replacement is not live with the planned budget");
  compareGrantToChain(S, internal.replacement, st1, "replacement");
  if (st1.actions !== e.state.actions || st1.envs !== e.state.envs || st1.expiresAt !== e.state.expiresAt) fail("replacement_scope", "replacement scope differs from the old session");
  await persistReplacementRecord({ legacyStore, oldRecord: e.record, replacement: internal.replacement, newSid: plan.newLegacySid, now });
  await setStep(gasStore, plan.id, "legacyOpen", "done", { txHash: oTx });
  if (typeof setActive === "function") await setActive(plan.newLegacySid);

  // ---- successor gas open (fresh key, domain 2) ---------------------------------------------------------------------
  await setStep(gasStore, plan.id, "gasOpen", "submitting");
  let g;
  try {
    g = await submitGasOpen({ runtime, store: gasStore, relay, rpc, record: internal.gasRecord, review: internal.gasReview,
      body: signed.gasOpen, now });
  } catch (err) { await setStep(gasStore, plan.id, "gasOpen", unreachable(err) ? "unknown" : "refused", { code: err.code }); throw err; }
  await setStep(gasStore, plan.id, "gasOpen", g.pending ? "pending" : "done", { txHash: g.txHash });
  return { stage: "gasOpen", pending: Boolean(g.pending), legacySid: plan.newLegacySid, gasSid: plan.gasSid };
}

/** Adds the replacement record next to the old one: same CryptoKey reference, new id/handle/grant. The old record is
 *  never removed or modified (it is the evidence a later re-plan needs). */
export async function persistReplacementRecord({ legacyStore, oldRecord, replacement, newSid, now }) {
  const existing = await legacyStore.load(newSid);
  if (existing && existing.keyHash !== oldRecord.keyHash) fail("record_collision", "another record already uses the replacement sid");
  const rec = { ...oldRecord, id: newSid, grant: replacement, createdAt: Number(now),
    handle: { ...oldRecord.handle, sid: newSid } };
  await legacyStore.save(rec);
  const kept = await legacyStore.load(oldRecord.id);
  if (!kept || kept.keyHash !== oldRecord.keyHash) fail("legacy_record_lost", "the old record must survive the migration");
  return rec;
}

// =====================================================================================================================
// 5. Reconcile (read only). Updates a step only when the chain proves it; never submits.
// =====================================================================================================================

export async function reconcileMigration({ plan, chain, relay, runtime, gasStore }) {
  const p = await gasStore.getJournal(plan.id);
  if (!p) fail("plan_missing", "no journaled plan");
  const owner = plan.terms.owner;
  const usdc = runtime.pins.usdc;
  const v = plan.terms.legacy.vault;
  const facts = {};
  const old = await chain.sessionOf(v, plan.terms.legacy.oldSid);
  facts.terminate = { oldLive: old.live };
  if (!old.live && p.steps.terminate !== "done") await setStep(gasStore, plan.id, "terminate", "done");
  const rep = await chain.sessionOf(v, plan.newLegacySid);
  facts.legacyOpen = { opened: rep.state !== 0, live: rep.live, authUsed: await chain.authorizationUsed(usdc, owner, plan.digests.legacyGrant) };
  if (rep.live && p.steps.legacyOpen !== "done") await setStep(gasStore, plan.id, "legacyOpen", "done");
  let gasView = null;
  try { gasView = await relay("GET", `/funding/session/${runtime.cfg.vault}/${plan.gasSid}`); } catch (err) { gasView = { error: err.code ?? "relay" }; }
  facts.gasOpen = { live: gasView?.state?.live === true, authUsed: await chain.authorizationUsed(usdc, owner, plan.digests.gasGrant), relay: gasView?.error ?? null };
  if (facts.gasOpen.live && p.steps.gasOpen !== "done") await setStep(gasStore, plan.id, "gasOpen", "done");
  const cur = await gasStore.getJournal(plan.id);
  const next = ORDER.map((k) => `${k}:${cur.steps[k]}`).filter((k) => RECOVERY[k]).map((k) => ({ state: k, action: RECOVERY[k] }));
  return { steps: cur.steps, facts, next };
}
