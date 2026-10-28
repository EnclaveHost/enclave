// DERIVED by production-grant-terms-r1/generator/generate_sdk.py from source/sdk/funding/migration.mjs (sha256-pinned). The ONLY
// changes (marked "production-grant-terms-r1"): the reviewed terms carry the exact gas candidate literals, and one comment.
// UNREVIEWED SOURCE (unified-funding client-repair-r4; r3 + exact legacy app-scope semantics). Resumable budget
// migration of the live legacy $30 session into replacement-legacy (API, domain "1", SAME key) + one or more successor
// gas-only grants (domain "2", a fresh key EACH). NOT approved, NOT signable until root review; nothing here runs on
// import or page load.
//
// Sequence (deployed-source constraints): SessionVault._end refunds owner terminations straight to the owner wallet, and
// the original relay's POST /open with budget > 0 always uses openWithDepositFor. So:
//   terminate(old) -> /open replacement legacy (EIP-3009 from the refunded wallet) -> /funding/open gas part 1..n.
// Single gas grant: steps terminate, legacyOpen, gasOpen (split { legacy6, gas6 }).
// Explicit partition: steps terminate, legacyOpen, gasOpen:<name>... (split { legacy6, gas: [{ name, budget6,
// opsPerPeriod, appIds }] }): each part <= 8 apps, parts disjoint, together exactly the fresh scope, gas parts summing to
// exactly the reviewed candidate budget (6 USDC, production-grant-terms-r1), legacy + gas = the fresh old balance <= 30 USDC.
// Nothing is widened or duplicated.
//
// Journal (one public entry "migration:<oldSid>", IndexedDB "enclave-funding-v2"): terms (reviewed, stable), and per step
// the UNSIGNED exact review (typed message / grant + digest), status, txHash and proof. Never signatures or key bytes.
// Step status:  planned -> admitted -> submitted -> proven            (normal)
//               admitted|submitted -> void   (only when the CHAIN proves the signed review can never apply)
//               void|planned -> planned (new attempt, new nonce: rearmStep)
// Only "planned" steps are ever sent; admitted/submitted steps are NEVER resent. Admission is a compare-and-set in one
// IndexedDB transaction (casJournal), so a second tab cannot submit the same step.
// Proofs are canonical-at-observation (finality is recorded separately). Before every send and every adoption all
// earlier proven steps are re-proven against the chain at their ORIGINAL block number and hash; a lost or moved receipt
// refuses (proof retained, step NOT reset). Finalized proofs skip that recheck only under an explicit finality policy.
import { encodeEventTopics, parseAbi } from "viem";
import { parseAddress, parseHex32, parseUint, keyHashOf } from "./funding-codec.mjs";
import { canon, fail, hashOf, jsonable, lower, randomHex32, sameAddr } from "./util.mjs";
import {
  CHAIN_ID, GAS_GRANT_CANDIDATE, MAX_GRANT_APPS, OWNER_OP_WINDOW, SIGN_WINDOW, buildGasGrant, ethCall, grantBody, pinBlock,
  prepareGasOpen, rebuildGasReview, signGasOpen, usdcDomain, depositTypedData, walletSignTyped,
} from "./funding-client.mjs";
import { VAULT_EVENTS, canonicalReceipt, proveEnded, proveOpened, receiptFinality } from "./chain-proof.mjs";

export const MIGRATION_SCHEMA = "enclave-funding-migration-plan-r3";
export const MAX_COMBINED6 = 30_000_000n;
export const V1_GRANT_FIELDS = Object.freeze(["label", "preset", "sessionKey", "actions", "apps", "environments", "budget",
  "spendPerPeriod", "periodSeconds", "opsPerPeriod", "maxFeePerOp", "maxAppFeePerHour", "maxRatePerHour", "expiresAt",
  "measurement", "grantNonce", "signBefore"]);
export const REPLACED_FIELDS = Object.freeze(["budget", "grantNonce", "signBefore"]);
const V1_BIG = ["budget", "spendPerPeriod", "maxFeePerOp", "maxAppFeePerHour", "maxRatePerHour", "expiresAt", "signBefore"];
const V1_NUM = ["periodSeconds", "opsPerPeriod"];
const GAS_VOLATILE = ["sessionKey", "grantNonce", "signBefore"];
export const ORDER = Object.freeze(["terminate", "legacyOpen", "gasOpen"]);     // the single-gas plan
const PART_NAME = /^[a-z0-9-]{1,24}$/;
export const isGasStep = (k) => k === "gasOpen" || (typeof k === "string" && k.startsWith("gasOpen:") && PART_NAME.test(k.slice(8)));
export const STEP_NOTES = Object.freeze({
  withdraw: "not-applicable: SessionVault._end refunds the old escrow to the owner wallet; no vault free balance is created",
  legacyFunding: "relay POST /open -> factory.openWithDepositFor (owner EIP-3009, nonce = replacement grant digest)",
  gasFunding: "relay POST /v1/sessions/funding/open -> successor openWithDeposit, once per gas part (owner EIP-3009, nonce = that part's grant digest)",
  interruption: "API session auth stops when the original relay simulates terminate and resumes when the replacement open "
    + "is proven and the active pointer moves; a pending or lost reply extends it until reconcile proves the step.",
  proofs: "terminate: SessionEnded(oldSid, reason 1, refund = full balance, fee 0) + USDC Transfer(vault -> owner). open: "
    + "SessionOpened(sid, key, scope, budget) + USDC AuthorizationUsed(owner, digest) + Transfer(owner -> vault). All from a "
    + "canonical receipt, re-proven at the original block before every later send or adoption; finality recorded separately.",
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

const HEX32_CANON = /^0x[0-9a-f]{64}$/;
/** What the ORIGINAL SessionVault._open stores for `g.apps` (source/contracts/SessionVault.sol, the loop at 624-632),
 *  for exactly the shapes this client can PROVE without any resolution:
 *    []                         -> no-app scope:  anyApp = false, no ids  (NOT a wildcard)
 *    ["*"]                      -> wildcard:      anyApp = true,  no ids
 *    distinct canonical ids     -> anyApp = false, exactly those ids in grant order (the vault parses 66-char hex literally)
 *  Everything else fails closed, even where the vault would accept it: app NAMES (resolved on chain through
 *  appIdOf(book, name), never assumed here), upper-case or otherwise non-canonical hex, non-strings, duplicates, "*" twice
 *  or "*" mixed with ids. A scope is never widened or narrowed to make a comparison pass. */
export function appScopeOf(apps) {
  if (!Array.isArray(apps)) fail("legacy_apps_malformed", "grant.apps must be an array");
  if (apps.length === 0) return Object.freeze({ anyApp: false, ids: Object.freeze([]) });
  if (apps.some((a) => typeof a !== "string")) fail("legacy_apps_malformed", "grant.apps must be strings");
  if (apps.includes("*")) {
    if (apps.length !== 1) fail("legacy_apps_malformed", `"*" must be the only entry of a wildcard scope`, { apps: [...apps] });
    return Object.freeze({ anyApp: true, ids: Object.freeze([]) });
  }
  const bad = apps.filter((a) => !HEX32_CANON.test(a));
  if (bad.length) fail("legacy_apps_unverifiable", `app entries [${bad}] need an on-chain resolution this client does not prove; STOP`, { bad });
  if (new Set(apps).size !== apps.length) fail("legacy_apps_malformed", "grant.apps lists an app twice");
  return Object.freeze({ anyApp: false, ids: Object.freeze([...apps]) });
}

/** Every grant field the vault mirrors must equal the chain: key, measurement, actions, expiry, environments, period
 *  limits, fees, maxRatePerHour -> maxRateHour6, and the app scope exactly (anyApp flag AND id list). Only label and
 *  preset are not mirrored; they come from the persisted record, bound by its sid and key. */
export function compareGrantToChain(S, g, st, what) {
  const scope = appScopeOf(g.apps);                    // fail closed on anything unprovable, before comparing
  const want = {
    keyHash: lower(g.sessionKey), measurement: lower(g.measurement), actions: actionsMaskV1(S, g.actions),
    expiresAt: BigInt(g.expiresAt), envs: envMask(g.environments), perPeriod6: BigInt(g.spendPerPeriod),
    maxFee6: BigInt(g.maxFeePerOp), maxAppFeeHour6: BigInt(g.maxAppFeePerHour), maxRateHour6: BigInt(g.maxRatePerHour),
    period: Number(g.periodSeconds), opsPerPeriod: Number(g.opsPerPeriod), anyApp: scope.anyApp,
  };
  const diff = Object.keys(want).filter((k) => want[k] !== st[k]);
  if (canon([...st.apps]) !== canon([...scope.ids])) diff.push("apps");
  if (diff.length) fail("legacy_fields_mismatch", `${what}: grant differs from chain in [${diff}]`, { diff });
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

/** The plan's step order (reviewed: it is inside `terms`). */
export function orderOf(plan) {
  const o = plan?.terms?.order;
  if (!Array.isArray(o) || o.length < 3 || o[0] !== "terminate" || o[1] !== "legacyOpen" || !o.slice(2).every(isGasStep)
    || new Set(o).size !== o.length) fail("plan_shape", "the plan's step order is malformed");
  return o;
}
export const gasStepsOf = (plan) => orderOf(plan).slice(2);
export function partOf(plan, k) {
  const p = plan.terms.gas.parts.find((x) => x.step === k);
  if (!p) fail("plan_shape", `no gas part for ${k}`);
  return p;
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
// 2. Split + plan (no wallet). `terms` = what is reviewed: stable, no nonce / window / observed block.
// =====================================================================================================================

/** split = { legacy6, gas6 } (one gas grant over the whole fresh scope, <= 8 apps) or
 *  split = { legacy6, gas: [{ name, budget6, opsPerPeriod, appIds }, ...] } (explicit finite partition). */
export function parseSplit(split, scope, fresh6) {
  const T = GAS_GRANT_CANDIDATE;
  if (!split || split.legacy6 === undefined || (split.gas6 === undefined && split.gas === undefined)) fail("split_required", "the split is an explicit plan field");
  if (split.gas6 !== undefined && split.gas !== undefined) fail("split_shape", "give gas6 (one grant) OR gas[] (a partition), not both");
  const legacy6 = parseUint(split.legacy6, 128, "split.legacy6");
  let parts;
  if (split.gas !== undefined) {
    if (!Array.isArray(split.gas) || split.gas.length === 0) fail("split_shape", "gas[] must list the parts");
    parts = split.gas.map((p, i) => {
      if (p === null || typeof p !== "object" || canon(Object.keys(p).sort()) !== canon(["appIds", "budget6", "name", "opsPerPeriod"])) {
        fail("split_shape", `gas[${i}] must be exactly { name, budget6, opsPerPeriod, appIds }`);
      }
      if (typeof p.name !== "string" || !PART_NAME.test(p.name)) fail("split_shape", `gas[${i}].name must match ${PART_NAME}`);
      if (!Array.isArray(p.appIds) || p.appIds.length === 0 || p.appIds.length > MAX_GRANT_APPS) {
        fail("gas_part_apps", `gas[${i}] must name 1..${MAX_GRANT_APPS} explicit app ids (no wildcard)`);
      }
      const appIds = p.appIds.map((a, j) => parseHex32(lower(a), `gas[${i}].appIds[${j}]`, { nonZero: true })).sort();
      if (new Set(appIds).size !== appIds.length) fail("gas_part_apps", `gas[${i}] lists an app twice`);
      const ops = parseUint(p.opsPerPeriod, 32, `gas[${i}].opsPerPeriod`);
      if (ops === 0n) fail("gas_part_ops", `gas[${i}].opsPerPeriod must be positive`);
      return { name: p.name, step: `gasOpen:${p.name}`, budget6: parseUint(p.budget6, 128, `gas[${i}].budget6`), opsPerPeriod: ops, appIds };
    });
    if (new Set(parts.map((p) => p.name)).size !== parts.length) fail("split_shape", "gas part names must be distinct");
  } else {
    if (scope.appIds.length > MAX_GRANT_APPS) {
      fail("gas_partition_required", `${scope.appIds.length} apps exceed ${MAX_GRANT_APPS} per grant; name an explicit partition (gas[])`, { byApp: scope.byApp });
    }
    parts = [{ name: "gas", step: "gasOpen", budget6: parseUint(split.gas6, 128, "split.gas6"), opsPerPeriod: T.opsPerPeriod,
      appIds: [...scope.appIds].map(lower), whole: true }];
  }
  const gasTotal = parts.reduce((s, p) => s + p.budget6, 0n);
  if (legacy6 === 0n || parts.some((p) => p.budget6 === 0n)) fail("split_zero", "every part must be positive");
  if (legacy6 + gasTotal !== fresh6) fail("split_total", `legacy ${legacy6} + gas ${gasTotal} must equal the fresh old balance ${fresh6}`);
  if (fresh6 > MAX_COMBINED6) fail("split_total", "combined budget may not exceed 30 USDC");
  if (gasTotal !== T.budget) fail("gas_budget_not_candidate", `gas parts total ${gasTotal}; they must total exactly the reviewed ${T.budget} (never duplicated or enlarged)`);
  if (parts.some((p) => p.budget6 > T.budget)) fail("gas_part_budget", "no gas part may exceed the reviewed budget");
  const opsTotal = parts.reduce((s, p) => s + p.opsPerPeriod, 0n);
  if (opsTotal > T.opsPerPeriod) fail("gas_part_ops", `gas parts allow ${opsTotal} ops per period in total; the candidate is ${T.opsPerPeriod}`);
  const all = parts.flatMap((p) => p.appIds);
  if (new Set(all).size !== all.length) fail("gas_scope_overlap", "an app is named by two gas parts (budget would be duplicated)");
  const scopeSet = new Set(scope.appIds.map(lower));
  const excess = all.filter((a) => !scopeSet.has(a));
  if (excess.length) fail("gas_scope_excess", `apps outside the fresh recovery scope: [${excess}]`, { excess });
  const uncovered = [...scopeSet].filter((a) => !all.includes(a));
  if (uncovered.length) fail("gas_scope_uncovered", `apps of the fresh recovery scope no part covers: [${uncovered}]`, { uncovered });
  return { legacy6, parts, gasTotal };
}

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
  const fresh6 = evidence.state.balance6;
  const sp = parseSplit(split, scope, fresh6);
  if (!runtime.intake?.openEnabled) fail("intake_off", "successor open intake is off; no plan is built");
  const n = BigInt(now);
  const old = evidence.grant;
  if (BigInt(old.expiresAt) <= n + SIGN_WINDOW) fail("legacy_expiring", "the old grant expires inside the signing window");
  const id = `migration:${evidence.sid}`;
  const prior = await gasStore.getJournal(id);
  if (prior && Object.values(prior.steps ?? {}).some((s) => s.status !== "planned")) {
    fail("migration_in_progress", "a migration for this sid already has admitted steps; reconcile it, never re-plan over it");
  }

  const gas = [];
  for (const p of sp.parts) {                        // a fresh non-extractable key for EACH part
    const built = await prepareGasOpen({ runtime, store: gasStore, relayBase, appIds: p.appIds,
      legacyExpiresAt: old.expiresAt, expiresAt: gasExpiresAt ?? old.expiresAt, now: n, subtle, rng, signBefore: n + SIGN_WINDOW,
      label: p.whole ? "Gas recovery" : `Gas recovery · ${p.name}`, part: { budget6: p.budget6, opsPerPeriod: p.opsPerPeriod } });
    gas.push({ p, ...built });
  }
  const keys = [lower(old.sessionKey), ...gas.map((x) => lower(x.record.keyHash))];
  if (new Set(keys).size !== keys.length) fail("key_reuse", "every gas part needs its own fresh key, distinct from the legacy key");

  const order = ["terminate", "legacyOpen", ...sp.parts.map((p) => p.step)];
  const terms = jsonable({
    schema: MIGRATION_SCHEMA, chainId: CHAIN_ID, owner: evidence.owner, order, notes: STEP_NOTES,
    gasCandidate: GAS_GRANT_CANDIDATE,      // production-grant-terms-r1: the exact candidate literals are part of termsHash
    legacy: { factory: evidence.factory, vault: evidence.vault, oldSid: evidence.sid, oldBalance6: fresh6, oldSpent6: 0n,
      keyHash: lower(old.sessionKey), grantTemplate: strip(old, REPLACED_FIELDS) },
    split: { legacy6: sp.legacy6, gas6: sp.gasTotal, parts: sp.parts.map((p) => ({ name: p.name, budget6: p.budget6 })),
      total6: fresh6, max6: MAX_COMBINED6 },
    gas: { factory: runtime.cfg.factory, implementation: runtime.cfg.implementation, vault: runtime.cfg.vault,
      usdc: runtime.pins.usdc, appIds: [...scope.appIds], deployments: [...scope.deployments.keys()].sort(),
      parts: gas.map(({ p, review }) => ({ name: p.name, step: p.step, budget6: p.budget6, opsPerPeriod: p.opsPerPeriod,
        appIds: p.appIds, grantTemplate: strip(review.typedData.message, GAS_VOLATILE) })) },
  });
  const steps = {
    terminate: { status: "planned", attempt: 1, review: terminateReview(S, terms, n, rng), history: [] },
    legacyOpen: { status: "planned", attempt: 1, review: legacyReview(S, terms, n, rng), history: [] },
  };
  for (const { p, record, review } of gas) steps[p.step] = { status: "planned", attempt: 1, review: gasReviewJson(review, record.id), history: [] };
  const plan = {
    id, kind: "migration", v: 3, rev: 1, termsHash: hashOf(terms), terms, at: Number(n),
    observed: { evidence: evidence.observed, scope: { block: Number(scope.block), hash: scope.blockHash ?? null } },
    steps,
  };
  await gasStore.casJournal(id, (cur) => {
    if (cur && Object.values(cur.steps ?? {}).some((s) => s.status !== "planned")) fail("migration_in_progress", "another tab admitted a step meanwhile");
    return plan;
  });
  return plan;
}

// =====================================================================================================================
// 3. Sign (explicit click). Every review is rebuilt from the journal and must hash to its stored digest AND match the
//    approved terms. Signatures are returned in memory only. Full plan = 1 + 2 + 2 x parts owner prompts.
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

function gasFromJournal(plan, k, runtime, now) {
  const r = plan.steps[k].review;
  const part = partOf(plan, k);
  const built = rebuildGasReview(runtime.cfg, r.grant, r.digest, now);
  const msg = strip(built.typedData.message, GAS_VOLATILE);
  if (canon(msg) !== canon(part.grantTemplate) || lower(built.sessionId) !== r.sid || lower(built.typedData.message.sessionKey) !== r.keyHash) {
    fail("review_not_terms", `${k}: gas grant differs from the reviewed terms`);
  }
  if (BigInt(built.typedData.message.budget) !== BigInt(part.budget6)) fail("review_not_terms", `${k}: budget differs from its part`);
  if (!sameAddr(runtime.cfg.vault, plan.terms.gas.vault)) fail("review_not_terms", "runtime vault differs from the reviewed one");
  return built;
}

export async function signSteps({ S, plan, steps, approval, provider, rpc, runtime, now }) {
  checkTerms(plan, approval);
  const n = BigInt(now);
  const order = orderOf(plan);
  const pending = order.filter((k) => plan.steps[k].status !== "proven");
  if (!Array.isArray(steps) || steps.length === 0 || steps.some((k) => !pending.includes(k))) fail("sign_steps", "sign only steps that are not proven");
  if (steps.join() !== pending.slice(0, steps.length).join()) fail("sign_steps", "sign the NEXT steps in order, without gaps");
  if (steps.includes("terminate") && !steps.includes("legacyOpen")) fail("sign_steps", "the original is only touched once its replacement is signed");
  for (const k of steps) if (plan.steps[k].status !== "planned") fail("step_not_planned", `${k} is ${plan.steps[k].status}; reconcile it`);
  const owner = plan.terms.owner;
  const vault = plan.terms.legacy.vault;
  const out = {};
  for (const k of steps) {
    if (k === "terminate") {
      const m = terminateFromJournal(S, plan);
      if (n >= m.signBefore) fail("sign_window_passed", "Terminate window closed; rearm it");
      const sig = await walletSignTyped(provider, owner, S.typedData(CHAIN_ID, vault, "Terminate", m));
      out.terminate = { digest: plan.steps.terminate.review.digest, body: { owner, vault, op: "terminate", args: m, sig } };
    } else if (k === "legacyOpen") {
      const g = replacementFromJournal(S, plan);
      if (n >= g.signBefore) fail("sign_window_passed", "replacement window closed; rearm it");
      const ownerSig = await walletSignTyped(provider, owner, S.typedData(CHAIN_ID, vault, "SessionGrant", g));
      const dep = depositTypedData(await usdcDomain(rpc, plan.terms.gas.usdc), { from: owner, to: vault, value: g.budget,
        nonce: plan.steps.legacyOpen.review.digest, validBefore: g.signBefore });
      const depSig = await walletSignTyped(provider, owner, dep);
      out.legacyOpen = { digest: plan.steps.legacyOpen.review.digest,
        body: { owner, grant: g, ownerSig, deposit: { validAfter: 0n, validBefore: g.signBefore, sig: depSig } } };
    } else {
      const built = gasFromJournal(plan, k, runtime, n);
      const body = await signGasOpen({ runtime, provider, rpc, review: built, now: n,
        approval: { rootReviewed: true, digest: plan.steps[k].review.digest } });
      out[k] = { digest: plan.steps[k].review.digest, body };
    }
  }
  return Object.freeze(out);
}

// =====================================================================================================================
// 4. Proofs per step (shared by run, reconcile and the prior-proof recheck) and post-proof adoption (idempotent)
// =====================================================================================================================

const stepEvent = (plan, k) => (k === "terminate"
  ? { address: plan.terms.legacy.vault, topics: encodeEventTopics({ abi: VAULT_EVENTS, eventName: "SessionEnded", args: { sid: plan.terms.legacy.oldSid } }) }
  : { address: k === "legacyOpen" ? plan.terms.legacy.vault : plan.terms.gas.vault,
    topics: encodeEventTopics({ abi: VAULT_EVENTS, eventName: "SessionOpened", args: { sid: plan.steps[k].review.sid } }) });

/** null = not canonical (yet). Throws when the receipt contradicts the step (wrong refund, scope, key, amount...) and
 *  `tx_reverted` when the canonical receipt reverted. The returned proof says whether it was final when observed. */
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
    const r = plan.steps[k].review;
    const part = partOf(plan, k);
    if (BigInt(r.grant.budget) !== BigInt(part.budget6)) fail("review_not_terms", `${k}: journal budget differs from its part`);
    proveOpened(rc, { vault: plan.terms.gas.vault, usdc, owner, sid: r.sid, keyHash: r.keyHash, digest: r.digest,
      amount6: BigInt(part.budget6), expiresAt: BigInt(r.grant.expiresAt), actions: 1n << 10n, envs: 3 });
  }
  const fin = chain.finality ? await chain.finality(rc) : { final: false };
  return { txHash: lower(txHash), block: Number(BigInt(rc.blockNumber)), blockHash: lower(rc.blockHash), final: Boolean(fin.final) };
}
const acceptable = (ctx, proof) => (proof && (!ctx.requireFinal || proof.final) ? proof : null);

/** Optional, explicit: { cacheFinalized: true, source: "finalized-tag", reviewedBy }. Anything else -> no caching. */
export function finalityPolicy(p) {
  if (p === undefined || p === null) return null;
  if (typeof p !== "object" || canon(Object.keys(p).sort()) !== canon(["cacheFinalized", "reviewedBy", "source"])
    || p.cacheFinalized !== true || p.source !== "finalized-tag" || typeof p.reviewedBy !== "string" || p.reviewedBy.length === 0) {
    fail("finality_policy_invalid", "finality policy must be exactly { cacheFinalized: true, source: \"finalized-tag\", reviewedBy }");
  }
  return p;
}

/** Re-prove one PROVEN step at its original block number and hash. On a lost, moved or contradicting receipt the proof
 *  is kept, the observation is journaled, and this throws: nothing is sent or adopted, nothing is reset or re-armed. */
async function recheckProven(ctx, planId, plan, k) {
  const st = plan.steps[k];
  if (st.status !== "proven" || !st.proof || !st.txHash) fail("previous_unproven", `${k} is ${st.status}`);
  if (finalityPolicy(ctx.finalityPolicy) && st.proof.final === true) return;
  let proof = null;
  let why = null;
  try { proof = await proveStep(ctx, plan, k, st.txHash); } catch (e) { why = `contradiction:${e?.code ?? "error"}`; }
  if (!why && !proof) why = "lost";
  if (!why && (proof.block !== st.proof.block || proof.blockHash !== st.proof.blockHash)) why = "moved";
  if (why) {
    await cas(ctx, planId, k, (s) => { s.recheck = { at: Number(ctx.now), result: why }; });
    fail(why === "lost" ? "prior_proof_lost" : why === "moved" ? "prior_proof_changed" : "prior_proof_contradiction",
      `${k}: its proven receipt no longer holds at block ${st.proof.block} (${why}); nothing is sent or adopted - reconcile once the chain settles, or review`);
  }
  if ((proof.final && !st.proof.final) || st.recheck) {
    await cas(ctx, planId, k, (s) => { s.proof.final = s.proof.final || proof.final; delete s.recheck; });
  }
}
async function recheckPrior(ctx, planId, plan, k) {
  const order = orderOf(plan);
  for (const p of order.slice(0, order.indexOf(k))) await recheckProven(ctx, planId, await ctx.gasStore.getJournal(planId), p);
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

async function adoptGas(ctx, plan, k, proof) {
  const r = plan.steps[k].review;
  const rec = await ctx.gasStore.loadKey(r.recordId);
  if (!rec || lower(rec.keyHash) !== r.keyHash) fail("gas_record_lost", `${k}: the gas key record is missing`);
  if (rec.status === "open" && lower(rec.sid) === r.sid) return;
  Object.assign(rec, { status: "open", sid: r.sid, grant: r.grant, grantDigest: r.digest, open: { txHash: proof.txHash, block: proof.block } });
  await ctx.gasStore.saveKey(rec);
}

async function afterProven(ctx, plan, k, proof) {
  if (k === "legacyOpen") await adoptReplacement(ctx, plan);
  else if (isGasStep(k)) await adoptGas(ctx, plan, k, proof);
}

// =====================================================================================================================
// 5. Journal transitions (all compare-and-set)
// =====================================================================================================================

function cas(ctx, id, k, fn) {
  return ctx.gasStore.casJournal(id, (cur) => {
    if (!cur) fail("plan_missing", "no journaled plan");
    if (!cur.steps[k]) fail("plan_shape", `no step ${k}`);
    fn(cur.steps[k], cur);
    cur.rev = Number(cur.rev ?? 0) + 1;
    return cur;
  });
}
const admit = (ctx, id, k, digest, observed) => cas(ctx, id, k, (st, cur) => {
  if (st.status !== "planned" || st.review.digest !== digest) fail("step_not_planned", `${k} is ${st.status} (or was re-armed); nothing sent`);
  const order = orderOf(cur);
  for (const p of order.slice(0, order.indexOf(k))) if (cur.steps[p].status !== "proven" || cur.steps[p].recheck) fail("previous_unproven", `${p} is not (still) proven`);
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
// 6. Run (explicit click): submit the NEXT planned steps that have a matching in-memory signature, one at a time.
//    Before each: every earlier proven step is re-proven, then the step's own preconditions at a fresh pinned block.
// =====================================================================================================================

async function preconditions(ctx, planId, plan, k) {
  const { S, chain, legacyStore, gasStore } = ctx;
  await recheckPrior(ctx, planId, plan, k);
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
    const r = plan.steps[k].review;
    const rec = await gasStore.loadKey(r.recordId);
    if (!rec || lower(rec.keyHash) !== r.keyHash) fail("gas_record_lost", `${k}: gas key record missing`);
    if (await used(r.digest)) fail("gas_auth_used", `${k}: gas authorization already used; reconcile`);
    if ((await chain.usdcBalance(T.gas.usdc, T.owner, pin.tag)) < BigInt(partOf(plan, k).budget6)) fail("owner_balance_short", `${k}: owner wallet lacks this part's amount`);
  }
  await pin.recheck();
  return { block: Number(pin.number), hash: pin.hash, timestamp: Number(pin.timestamp) };
}

function send(ctx, k, body) {
  if (k === "terminate") return ctx.legacyRelay.request("POST", "/owner", body);
  if (k === "legacyOpen") return ctx.legacyRelay.request("POST", "/open", body);
  return ctx.relay("POST", "/funding/open", body);
}

export async function runMigration(ctx, planId, signed) {
  for (;;) {
    const plan = await ctx.gasStore.getJournal(planId);
    if (!plan) fail("plan_missing", "no journaled plan");
    const order = orderOf(plan);
    const k = order.find((s) => plan.steps[s].status !== "proven");
    if (!k) return { done: true, steps: statusOf(plan) };
    const st = plan.steps[k];
    if (st.status !== "planned") return { stage: k, needsReconcile: true, steps: statusOf(plan) };
    const sg = signed?.[k];
    if (!sg || lower(sg.digest) !== st.review.digest) return { stage: k, needsSignature: true, steps: statusOf(plan) };
    if (k === "terminate" && signed?.legacyOpen?.digest !== plan.steps.legacyOpen.review.digest) {
      fail("replacement_unsigned", "the original is only terminated with its replacement already signed");
    }
    const observed = await preconditions(ctx, planId, plan, k);
    await admit(ctx, planId, k, st.review.digest, observed);
    let out;
    try { out = await send(ctx, k, sg.body); }
    catch (err) { await noteError(ctx, planId, k, err?.code); throw err; }   // stays admitted: ambiguous, never resent
    const txHash = typeof out?.txHash === "string" ? lower(out.txHash) : null;
    if (!txHash) return { stage: k, pending: true, steps: statusOf(await ctx.gasStore.getJournal(planId)) };
    await noteSubmitted(ctx, planId, k, txHash);
    if (out.sid !== undefined && k !== "terminate" && lower(out.sid) !== st.review.sid) {
      await noteError(ctx, planId, k, "relay_sid_mismatch");
      fail("relay_sid_mismatch", `relay reported ${out.sid}, expected ${st.review.sid}`);
    }
    let proof;
    try { proof = acceptable(ctx, await proveStep(ctx, await ctx.gasStore.getJournal(planId), k, txHash)); }
    catch (err) { await noteError(ctx, planId, k, err?.code); throw err; }  // stays submitted: reconcile decides
    if (!proof) return { stage: k, pending: true, txHash, steps: statusOf(await ctx.gasStore.getJournal(planId)) };
    await markProven(ctx, planId, k, proof);
    await recheckPrior(ctx, planId, plan, k);            // adoption only on a still-valid chain of earlier proofs
    await afterProven(ctx, await ctx.gasStore.getJournal(planId), k, proof);
  }
}

const statusOf = (plan) => Object.fromEntries(orderOf(plan).map((k) => [k, plan.steps[k].status]));

// =====================================================================================================================
// 7. Reconcile (explicit click, read only towards the relay): re-prove proven steps before re-adopting them, prove
//    submitted/admitted steps from the chain, or prove a step void once the CHAIN's time passed its window. Never sends.
// =====================================================================================================================

async function notApplied(ctx, plan, k, tag) {
  const { chain } = ctx;
  const T = plan.terms;
  if (k === "terminate") {
    const st = await chain.sessionOf(T.legacy.vault, T.legacy.oldSid, tag);
    return st.live && st.balance6 === BigInt(T.legacy.oldBalance6);
  }
  const r = plan.steps[k].review;
  if (await chain.authorizationUsed(T.gas.usdc, T.owner, r.digest, tag)) return false;
  if (k === "legacyOpen") return (await chain.sessionOf(T.legacy.vault, r.sid, tag)).state === 0;
  return true;
}
const windowOf = (plan, k) => BigInt(k === "terminate" ? plan.steps[k].review.message.signBefore : plan.steps[k].review.grant.signBefore);

export async function reconcileMigration(ctx, planId) {
  const report = [];
  const order = orderOf(await ctx.gasStore.getJournal(planId));
  for (const k of order) {
    let plan = await ctx.gasStore.getJournal(planId);
    const st = plan.steps[k];
    if (st.status === "proven") {
      await recheckProven(ctx, planId, plan, k);          // throws (proof kept) if the receipt is gone or moved
      plan = await ctx.gasStore.getJournal(planId);
      await afterProven(ctx, plan, k, { txHash: st.txHash, block: st.proof.block });
      report.push({ k, status: "proven" });
      continue;
    }
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
      try { proof = acceptable(ctx, await proveStep(ctx, plan, k, h)); }   // a contradicting receipt throws: STOP for review
      catch (e) { if (e?.code === "tx_reverted") { reverted += 1; continue; } throw e; }
      if (proof) break;
    }
    if (proof) {
      if (!st.txHash) await noteSubmitted(ctx, planId, k, proof.txHash);
      await markProven(ctx, planId, k, proof);
      await recheckPrior(ctx, planId, plan, k);
      await afterProven(ctx, await ctx.gasStore.getJournal(planId), k, proof);
      report.push({ k, status: "proven" });
      continue;
    }
    if (hashes.length > reverted) { report.push({ k, status: st.status, next: "wait_canonical" }); break; }
    // void needs the CHAIN's time past the signed window (not the local clock alone) and no effect at that same block
    const w = windowOf(plan, k);
    const pin = await ctx.chain.pin(ctx.now);
    if (BigInt(pin.timestamp) <= w || BigInt(ctx.now) <= w) { report.push({ k, status: st.status, next: "wait_window" }); break; }
    const clean = await notApplied(ctx, plan, k, pin.tag);
    await pin.recheck();
    if (!clean) fail("step_contradiction", `${k}: chain shows an effect without a provable transaction; STOP for review`);
    await cas(ctx, planId, k, (s) => {
      if (s.status !== st.status || (s.txHash ?? null) !== (st.txHash ?? null)) fail("step_state", `${k} changed meanwhile`);
      s.status = "void";
      s.voidAt = Number(ctx.now);
      s.voidEvidence = { block: Number(pin.number), hash: pin.hash, timestamp: Number(pin.timestamp) };
    });
    report.push({ k, status: "void", next: "rearm" });
    break;
  }
  const plan = await ctx.gasStore.getJournal(planId);
  return { steps: statusOf(plan), report };
}

/** A fresh review (new nonce, new window) for a step that is chain-proven void or was never admitted. Terms are
 *  unchanged (same key per step, same part budget and scope), so the same approval applies; the owner re-signs by click. */
export async function rearmStep(ctx, planId, k) {
  const { S, runtime, rng } = ctx;
  const n = BigInt(ctx.now);
  const plan = await ctx.gasStore.getJournal(planId);
  if (!orderOf(plan).includes(k)) fail("plan_shape", `no step ${k}`);
  const st = plan.steps[k];
  if (st.status !== "void" && st.status !== "planned") fail("step_not_rearmable", `${k} is ${st.status}; reconcile it`);
  let review;
  if (k === "terminate") review = terminateReview(S, plan.terms, n, rng);
  else if (k === "legacyOpen") review = legacyReview(S, plan.terms, n, rng);
  else {
    const old = st.review;
    const part = partOf(plan, k);
    const built = buildGasGrant(runtime.cfg, { now: n, sessionKey: old.keyHash, appIds: part.appIds,
      expiresAt: part.grantTemplate.expiresAt, legacyExpiresAt: plan.terms.legacy.grantTemplate.expiresAt,
      grantNonce: randomHex32(rng), signBefore: n + SIGN_WINDOW, label: part.grantTemplate.label,
      part: { budget6: part.budget6, opsPerPeriod: part.opsPerPeriod } });
    if (canon(strip(built.typedData.message, GAS_VOLATILE)) !== canon(part.grantTemplate)) fail("review_not_terms", `${k}: re-armed grant differs from its terms`);
    review = gasReviewJson(built, old.recordId);
    const rec = await ctx.gasStore.loadKey(old.recordId);
    Object.assign(rec, { status: "reviewed", sid: review.sid, grant: review.grant, grantDigest: review.digest });
    await ctx.gasStore.saveKey(rec);
  }
  await cas(ctx, planId, k, (s) => {
    if (s.status !== st.status || s.review.digest !== st.review.digest) fail("step_state", `${k} changed meanwhile`);
    s.history.push({ attempt: s.attempt, digest: s.review.digest, status: s.status, txHash: s.txHash ?? null });
    Object.assign(s, { status: "planned", attempt: s.attempt + 1, review });
    delete s.txHash; delete s.observed; delete s.lastError; delete s.admittedAt; delete s.voidAt; delete s.voidEvidence;
  });
  return ctx.gasStore.getJournal(planId);
}
