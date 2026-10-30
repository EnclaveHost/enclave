var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __reExport = (target, mod, secondTarget) => (__copyProps(target, mod, "default"), secondTarget && __copyProps(secondTarget, mod, "default"));

// source/site/js/core/util.js
function lsGet(k) {
  try {
    return localStorage.getItem(k);
  } catch (e) {
    return null;
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch (e) {
  }
}
function showToast(msg) {
  document.dispatchEvent(new CustomEvent("enclave:toast", { detail: { message: msg } }));
}
function emit(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
}
function on(name, fn) {
  document.addEventListener(name, (e) => fn(e.detail || {}, e));
}
var $, esc;
var init_util = __esm({
  "source/site/js/core/util.js"() {
    $ = (s, r) => (r || document).querySelector(s);
    esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
});

// unified-funding-20261028/production-grant-terms-r1/shell/facade/api.js
var WALLET_SESSION_KEY, Enclave;
var init_api = __esm({
  "unified-funding-20261028/production-grant-terms-r1/shell/facade/api.js"() {
    WALLET_SESSION_KEY = "client-site-browser-r1-TEST-wallet-session";
    Enclave = { address: null, chainId: null, provider: null, base: null };
  }
});

// unified-funding-20261028/production-grant-terms-r1/shell/harness-state.js
var PREFIX, SS_KEY, NAME, KNOWN_REAL, pageConfig, H;
var init_harness_state = __esm({
  "unified-funding-20261028/production-grant-terms-r1/shell/harness-state.js"() {
    PREFIX = "client-site-browser-r1-TEST-";
    SS_KEY = "client-site-browser-r1";
    NAME = /^client-site-browser-r1-TEST-(legacy|v2)-[0-9a-f]{16}$/;
    KNOWN_REAL = /* @__PURE__ */ new Set(["enclave-sessions", "enclave-funding-v2", "enclave_sessions", "enclave-v2"]);
    pageConfig = null;
    H = {
      counters: { accountFromSession: 0, rpcHolds: 0, signHolds: 0 },
      configUnavailable: false,
      load() {
        return JSON.parse(sessionStorage.getItem(SS_KEY) || "null");
      },
      save(o) {
        sessionStorage.setItem(SS_KEY, JSON.stringify(o));
      },
      /** The TEST database name for `kind`, refusing anything that is not this run's random prefixed name. */
      dbName(kind, alsoRefuse = []) {
        const st = H.load();
        const n = kind === "legacy" ? st?.legacyDb : kind === "v2" ? st?.v2Db : null;
        if (typeof n !== "string" || !NAME.test(n) || !n.startsWith(`${PREFIX}${kind}-`) || KNOWN_REAL.has(n) || alsoRefuse.includes(n)) {
          throw new Error(`TEST harness refuses database ${String(n)} (no random ${PREFIX}${kind}-* name for this run)`);
        }
        return n;
      },
      setPageConfig(c2) {
        if (pageConfig) throw new Error("page config is set once per page load");
        pageConfig = Object.freeze({ runtime: c2.runtime ?? null, proposal: c2.proposal ?? null, approval: c2.approval ?? null });
      },
      pageConfig() {
        if (!pageConfig) throw new Error("TEST harness: the page module was evaluated before the fixture config was loaded");
        return pageConfig;
      },
      // ---- one-shot holds -----------------------------------------------------------------------------------------------
      signHold: null,
      // { n, action }: after the n-th fixture-signer answer from now, run action()
      rpcHold: null,
      // { action }: before the next RPC read from now, run action()
      armSign(n, action) {
        H.signHold = { left: n, action };
      },
      armRpc(action) {
        H.rpcHold = { action };
      },
      async afterSign() {
        const h = H.signHold;
        if (!h) return;
        h.left -= 1;
        if (h.left > 0) return;
        H.signHold = null;
        H.counters.signHolds += 1;
        await h.action();
      },
      async onRpc() {
        const h = H.rpcHold;
        if (!h) return;
        H.rpcHold = null;
        H.counters.rpcHolds += 1;
        await h.action();
      }
    };
  }
});

// unified-funding-20261028/production-grant-terms-r1/shell/facade/empty.js
var init_empty = __esm({
  "unified-funding-20261028/production-grant-terms-r1/shell/facade/empty.js"() {
  }
});

// unified-funding-20261028/production-grant-terms-r1/shell/facade/wallet.js
async function connectWallet() {
  throw new Error("TEST harness: no wallet here; the fixture owner is connected by the harness TEST Start button");
}
var init_wallet = __esm({
  "unified-funding-20261028/production-grant-terms-r1/shell/facade/wallet.js"() {
  }
});

// unified-funding-20261028/production-grant-terms-r1/shell/facade/sessions.js
async function sdk() {
  if (!_sdk) {
    _sdk = import("/harness/vendor/sessions.js").then((S2) => {
      class IndexedDbStore extends S2.IndexedDbStore {
        constructor(...args) {
          if (args.length) throw new Error("TEST harness: the page must not choose a database name");
          super(H.dbName("legacy"));
        }
      }
      return Object.freeze({ ...S2, IndexedDbStore });
    });
  }
  return _sdk;
}
async function sessionsConfig() {
  if (H.configUnavailable) throw new Error("TEST fault (client-site-browser-r1): sessions config / catalog unavailable");
  try {
    const S2 = await sdk();
    return await new S2.RelayClient(relayRoot()).config();
  } catch (e) {
    if (e && (e.code === "sessions_disabled" || /503|sessions_disabled/.test(String(e.message)))) return null;
    throw e;
  }
}
async function accountFromSession() {
  H.counters.accountFromSession += 1;
  return null;
}
var _sdk, relayRoot;
var init_sessions = __esm({
  "unified-funding-20261028/production-grant-terms-r1/shell/facade/sessions.js"() {
    init_api();
    init_harness_state();
    _sdk = null;
    relayRoot = () => String(Enclave.base || "").replace(/\/v1\/?$/, "");
  }
});

// unified-funding-20261028/production-grant-terms-r1/shell/facade/config.js
var c, APP_CATALOG_RPCS, FUNDING_RUNTIME, FUNDING_MIGRATION_PROPOSAL, FUNDING_MIGRATION_APPROVAL;
var init_config = __esm({
  "unified-funding-20261028/production-grant-terms-r1/shell/facade/config.js"() {
    init_harness_state();
    c = H.pageConfig();
    APP_CATALOG_RPCS = Object.freeze([`${location.origin}/rpc`]);
    FUNDING_RUNTIME = c.runtime;
    FUNDING_MIGRATION_PROPOSAL = c.proposal;
    FUNDING_MIGRATION_APPROVAL = c.approval;
  }
});

// unified-funding-20261028/client-site-repair-r2/authored/site/js/funding/state.js
function formatUsd6(v) {
  let n = BigInt(v);
  const sign = n < 0n ? "-" : "";
  if (n < 0n) n = -n;
  const frac = (n % 1000000n).toString().padStart(6, "0");
  let f = frac.replace(/0+$/, "");
  if (f.length < 2) f = frac.slice(0, 2);
  return `${sign}$${n / 1000000n}.${f}`;
}
function contextOf({ owner, chainId, vault, legacyVault, relay }) {
  if (!ADDR.test(String(owner))) fail("context", "no connected owner");
  const c2 = { owner: lower(owner), chainId: Number(chainId), vault: lower(vault), legacyVault: lower(legacyVault), relay: normRelay(relay) };
  if (!ADDR.test(c2.vault) || !ADDR.test(c2.legacyVault) || !Number.isInteger(c2.chainId) || !c2.relay) fail("context", "incomplete context");
  return Object.freeze({ ...c2, key: `${c2.owner}|${c2.chainId}|${c2.vault}|${c2.legacyVault}|${c2.relay}` });
}
function controlsContextOf({ owner, chainId, vault, relay }) {
  if (!ADDR.test(String(owner))) fail("context", "no connected owner");
  return Object.freeze({
    owner: lower(owner),
    chainId: Number(chainId),
    vault: lower(vault),
    relay: normRelay(relay),
    key: `${lower(owner)}|${Number(chainId)}|${lower(vault)}|${normRelay(relay)}`
  });
}
function selectOwnRecords(records, ctx) {
  return (records || []).filter((r) => r && lower(r.owner) === ctx.owner && Number(r.chainId) === ctx.chainId && lower(r.vault) === ctx.vault && normRelay(r.relay) === ctx.relay);
}
function planScope(e, ctx, records, oldSid) {
  if (!e || e.kind !== "migration" || e.v !== 3 || !e.terms || !e.steps) return { ok: false, reason: "not_a_plan" };
  const t = e.terms;
  if (lower(t.owner) !== ctx.owner) return { ok: false, reason: "other_owner" };
  if (Number(t.chainId) !== ctx.chainId) return { ok: false, reason: "other_chain" };
  if (lower(t.legacy?.vault) !== ctx.legacyVault || lower(t.gas?.vault) !== ctx.vault) return { ok: false, reason: "other_vault" };
  if (oldSid !== void 0 && lower(t.legacy?.oldSid) !== lower(oldSid)) return { ok: false, reason: "other_session" };
  if (!Array.isArray(records)) return { ok: false, reason: "relay_evidence_missing" };
  const order = Array.isArray(t.order) ? t.order : [];
  const gas = order.filter(isGasStep);
  if (order[0] !== "terminate" || order[1] !== "legacyOpen" || gas.length === 0 || gas.length !== order.length - 2) {
    return { ok: false, reason: "relay_evidence_missing" };
  }
  const own = selectOwnRecords(records, ctx);
  for (const k of gas) {
    const r = e.steps[k]?.review;
    const rec = r && own.find((x) => x.id === r.recordId);
    if (!rec) {
      const anywhere = r && records.find((x) => x && x.id === r.recordId);
      return { ok: false, reason: anywhere ? "other_relay_or_owner" : "relay_evidence_missing", step: k };
    }
    if (lower(rec.keyHash) !== lower(r.keyHash)) return { ok: false, reason: "record_key_mismatch", step: k };
  }
  return { ok: true, reason: "scoped" };
}
function selectPlans(entries, ctx, oldSid, records) {
  return (entries || []).filter((e) => planScope(e, ctx, records, oldSid).ok).sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0));
}
function validateProposal(p, { owner, chainId }) {
  if (p === null || p === void 0) return null;
  exactKeys(p, ["schema", "chainId", "owner", "oldSid", "legacy6", "gas", "deploymentIds"], "proposal");
  if (p.schema !== PROPOSAL_SCHEMA) fail("schema", `proposal.schema must be ${PROPOSAL_SCHEMA}`);
  if (Number(p.chainId) !== Number(chainId)) fail("chain", "the proposal is for another chain");
  if (!ADDR.test(String(p.owner)) || lower(p.owner) !== lower(owner)) fail("owner", "the proposal is for another wallet");
  if (!HEX32.test(String(p.oldSid)) || p.oldSid === ZERO32) fail("sid", "proposal.oldSid must be a lower-case 0x + 64 hex session id");
  const legacy6 = dec(p.legacy6, "proposal.legacy6");
  if (legacy6 === 0n) fail("amount", "the replacement legacy budget must be positive");
  if (!Array.isArray(p.gas) || p.gas.length === 0) fail("shape", "proposal.gas must list at least one finite gas grant");
  const seen = /* @__PURE__ */ new Set();
  const parts = p.gas.map((g, i) => {
    exactKeys(g, ["name", "budget6", "opsPerPeriod", "appIds"], `proposal.gas[${i}]`);
    if (!PART.test(String(g.name))) fail("shape", `proposal.gas[${i}].name must match ${PART}`);
    if (!Array.isArray(g.appIds) || g.appIds.length === 0 || g.appIds.length > 8) fail("scope", `gas grant "${g.name}" must name 1..8 apps`);
    for (const a of g.appIds) {
      if (a === "*") fail("scope_wildcard", `gas grant "${g.name}" may not be a wildcard`);
      if (!HEX32.test(String(a)) || a === ZERO32) fail("scope", `gas grant "${g.name}": ${a} is not a lower-case app id`);
      if (seen.has(a)) fail("scope_overlap", `app ${a} is named twice`);
      seen.add(a);
    }
    const budget6 = dec(g.budget6, `proposal.gas[${i}].budget6`);
    const opsPerPeriod = dec(g.opsPerPeriod, `proposal.gas[${i}].opsPerPeriod`);
    if (budget6 === 0n || opsPerPeriod === 0n) fail("amount", `gas grant "${g.name}" needs a positive budget and op count`);
    return Object.freeze({ name: g.name, budget6, opsPerPeriod, appIds: Object.freeze([...g.appIds].sort()) });
  });
  if (new Set(parts.map((x) => x.name)).size !== parts.length) fail("shape", "gas grant names must be distinct");
  if (!Array.isArray(p.deploymentIds) || p.deploymentIds.length === 0 || p.deploymentIds.length > 64) fail("shape", "proposal.deploymentIds must list 1..64 deployments");
  for (const d of p.deploymentIds) if (!HEX32.test(String(d)) || d === ZERO32) fail("shape", `deployment ${d} is not a lower-case id`);
  if (new Set(p.deploymentIds).size !== p.deploymentIds.length) fail("shape", "a deployment is listed twice");
  const gas6 = parts.reduce((s, x) => s + x.budget6, 0n);
  if (legacy6 + gas6 > MAX_TOTAL6) fail("amount", `the proposal moves ${formatUsd6(legacy6 + gas6)}; at most ${formatUsd6(MAX_TOTAL6)}`);
  return Object.freeze({
    oldSid: p.oldSid,
    legacy6,
    parts: Object.freeze(parts),
    gas6,
    total6: legacy6 + gas6,
    deploymentIds: Object.freeze([...p.deploymentIds])
  });
}
function scopeCoverage(np, scopeAppIds) {
  const named = new Set(np.parts.flatMap((x) => x.appIds));
  const scope = new Set((scopeAppIds || []).map(lower));
  return {
    uncovered: [...scope].filter((a) => !named.has(a)),
    extra: [...named].filter((a) => !scope.has(a)),
    ok: [...scope].every((a) => named.has(a)) && [...named].every((a) => scope.has(a))
  };
}
function termsView(plan) {
  const t = plan.terms;
  return Object.freeze({
    original6: BigInt(t.legacy.oldBalance6),
    legacy6: BigInt(t.split.legacy6),
    parts: Object.freeze(t.gas.parts.map((x) => Object.freeze({
      name: x.name,
      budget6: BigInt(x.budget6),
      opsPerPeriod: BigInt(x.opsPerPeriod),
      appIds: Object.freeze([...x.appIds].map(lower).sort())
    }))),
    deploymentIds: Object.freeze([...t.gas.deployments].map(lower).sort()),
    legacyApps: t.legacy.grantTemplate?.apps
  });
}
function proposalMatchesPlan(np, plan) {
  if (!np || !plan) return { ok: false, diffs: ["missing"] };
  let tv;
  try {
    tv = termsView(plan);
  } catch {
    return { ok: false, diffs: ["plan_terms_unreadable"] };
  }
  const diffs = [];
  if (lower(plan.terms.legacy.oldSid) !== lower(np.oldSid)) diffs.push("oldSid");
  if (tv.legacy6 !== np.legacy6) diffs.push("legacy6");
  if (tv.parts.length !== np.parts.length) diffs.push("parts");
  else {
    tv.parts.forEach((x, i) => {
      const y = np.parts[i];
      if (x.name !== y.name) diffs.push(`parts[${i}].name`);
      if (x.budget6 !== y.budget6) diffs.push(`parts[${i}].budget6`);
      if (x.opsPerPeriod !== y.opsPerPeriod) diffs.push(`parts[${i}].opsPerPeriod`);
      if (x.appIds.join() !== [...y.appIds].map(lower).sort().join()) diffs.push(`parts[${i}].appIds`);
    });
  }
  if (tv.deploymentIds.join() !== [...np.deploymentIds].map(lower).sort().join()) diffs.push("deploymentIds");
  return { ok: diffs.length === 0, diffs };
}
function legacyScopeLabel(apps) {
  if (!Array.isArray(apps)) return { kind: "invalid", text: "unreadable app scope" };
  if (apps.length === 0) return { kind: "none", text: "no apps (empty scope)" };
  if (apps.length === 1 && apps[0] === "*") return { kind: "wildcard", text: "all apps (explicit wildcard in the original grant)" };
  if (apps.includes("*")) return { kind: "invalid", text: "malformed scope (wildcard mixed with ids)" };
  if (apps.every((a) => HEX32.test(String(a))) && new Set(apps).size === apps.length) {
    return { kind: "finite", text: `${apps.length} named app${apps.length === 1 ? "" : "s"}` };
  }
  return { kind: "invalid", text: "scope this page cannot verify (names or non-canonical ids)" };
}
function moneyRows({ original6, legacy6, parts }) {
  const rows = [
    { key: "legacy", label: "Replacement API session (same key)", amount6: BigInt(legacy6) },
    ...parts.map((x) => ({ key: x.name, label: `Gas grant "${x.name}" (${x.appIds.length} apps)`, amount6: BigInt(x.budget6) }))
  ];
  const total6 = rows.reduce((s, r) => s + r.amount6, 0n);
  const orig = original6 === void 0 || original6 === null ? null : BigInt(original6);
  return {
    rows,
    total6,
    original6: orig,
    ok: orig !== null && total6 === orig && orig <= MAX_TOTAL6,
    text: rows.map((r) => `${r.label}: ${formatUsd6(r.amount6)}`)
  };
}
function approvalStatus(approval, plan, ctx) {
  if (!plan) return { ok: false, reason: "no_plan" };
  if (approval === null || approval === void 0) return { ok: false, reason: "waiting_for_review", termsHash: plan.termsHash };
  try {
    exactKeys(approval, ["schema", "rootReviewed", "termsHash", "owner", "chainId", "oldSid"], "approval");
  } catch {
    return { ok: false, reason: "approval_malformed" };
  }
  if (approval.schema !== APPROVAL_SCHEMA) return { ok: false, reason: "approval_schema" };
  if (approval.rootReviewed !== true) return { ok: false, reason: "approval_not_reviewed" };
  if (lower(approval.owner) !== ctx.owner) return { ok: false, reason: "approval_other_owner" };
  if (Number(approval.chainId) !== ctx.chainId) return { ok: false, reason: "approval_other_chain" };
  if (lower(approval.oldSid) !== lower(plan.terms?.legacy?.oldSid)) return { ok: false, reason: "approval_other_session" };
  if (approval.termsHash !== plan.termsHash) return { ok: false, reason: "approval_other_terms", termsHash: plan.termsHash };
  return { ok: true, reason: "approved", approval: Object.freeze({ rootReviewed: true, termsHash: plan.termsHash }) };
}
function stepView(step, nowSec) {
  const s = step?.status;
  const windowEnd = step?.review ? BigInt(step.review.message?.signBefore ?? step.review.grant?.signBefore ?? 0) : 0n;
  const expired = BigInt(nowSec) >= windowEnd;
  if (s === "proven" && step.recheck) return { label: `Was confirmed, but the chain no longer shows it (${step.recheck.result}). Check again before anything else.`, tone: "warn", actions: ["reconcile"] };
  if (s === "proven") return { label: "Confirmed on chain", tone: "ok", actions: [] };
  if (s === "submitted") return { label: `Sent (${String(step.txHash).slice(0, 10)}\u2026), waiting for chain confirmation`, tone: "wait", actions: ["reconcile"] };
  if (s === "admitted" && step.lastError) return { label: `Outcome unknown (${step.lastError}): it may have been sent. Check the chain; it is never resent automatically.`, tone: "warn", actions: ["reconcile"] };
  if (s === "admitted") return { label: "Being sent, or outcome unknown. Check the chain before anything else.", tone: "warn", actions: ["reconcile"] };
  if (s === "void") return { label: "Expired without effect (proven). It can be prepared again with a new signature window.", tone: "info", actions: ["rearm"] };
  if (s === "planned") return expired ? { label: "Not sent; its signing window has passed. Prepare it again.", tone: "info", actions: ["rearm"] } : { label: "Not sent yet", tone: "idle", actions: ["sign"] };
  return { label: `Unknown state ${String(s)}`, tone: "warn", actions: [] };
}
function nextSignable(plan, nowSec) {
  const order = plan?.terms?.order || [];
  let first = 0;
  while (first < order.length && stillProven(plan.steps[order[first]])) first += 1;
  if (first >= order.length) return [];
  const out = [];
  for (const k of order.slice(first)) {
    const st = plan.steps[k];
    if (st?.status !== "planned" || !stepView(st, nowSec).actions.includes("sign")) break;
    out.push(k);
  }
  if (out[0] === "terminate" && !out.includes("legacyOpen")) return [];
  return out;
}
function planPhase(plan, nowSec, hasSignatures = false) {
  const order = plan?.terms?.order || [];
  const k = order.find((s) => !stillProven(plan.steps[s]));
  if (!k) return { phase: "done" };
  const v = stepView(plan.steps[k], nowSec);
  if (v.actions.includes("reconcile")) return { phase: "reconcile", step: k };
  if (v.actions.includes("rearm")) return { phase: "rearm", step: k };
  return { phase: hasSignatures ? "submit" : "sign", step: k, steps: nextSignable(plan, nowSec) };
}
function activePointerDecision(current, newSid, oldSid) {
  const cur = lower(current);
  if (cur === lower(newSid)) return "noop";
  if (!cur || cur === lower(oldSid)) return "set";
  return "keep";
}
function controlsAvailability({ pinsOk, relayOk, storeOk, ownRecords = 0 }) {
  return {
    terminate: pinsOk && relayOk && storeOk && ownRecords > 0,
    withdraw: pinsOk && relayOk && storeOk,
    end: relayOk && storeOk && ownRecords > 0,
    reason: !pinsOk ? "successor not configured" : !relayOk ? "relay address unavailable" : !storeOk ? "browser storage unavailable" : null
  };
}
function quoteView(review, nowSec) {
  const t = review.totals;
  const deadline = BigInt(review.call.execute.deadline);
  const left = deadline - BigInt(nowSec);
  return {
    maxGas6: t.maxUsdcIn6,
    fee6: t.fee6,
    total6: t.totalMaximum6,
    balance6: t.balance6,
    balanceAfterMax6: t.balance6 - t.totalMaximum6,
    secondsLeft: left > 0n ? Number(left) : 0,
    expired: left <= QUOTE_MARGIN_S,
    text: [
      `gas at most ${formatUsd6(t.maxUsdcIn6)}`,
      `relay fee ${formatUsd6(t.fee6)}`,
      `total at most ${formatUsd6(t.totalMaximum6)}`,
      `grant balance ${formatUsd6(t.balance6)} -> at least ${formatUsd6(t.balance6 - t.totalMaximum6)}`
    ]
  };
}
function quoteInputsOf({ deployment, ethOut, feeTier }) {
  const d = lower(String(deployment ?? "").trim());
  const e = String(ethOut ?? "").trim();
  const t = String(feeTier ?? "").trim();
  if (!HEX32.test(d) || d === ZERO32 || !DEC.test(e) || e === "0" || !/^[1-9][0-9]{0,7}$/.test(t)) return null;
  return Object.freeze({ deployment: d, ethOut: e, feeTier: t });
}
function createMemory() {
  let ctxKey = null;
  let signed = null;
  let quote = null;
  const quoteFits = (q2, ctx, inputs, nowSec) => !!q2 && ctxKey === ctx.key && q2.ctxKey === ctx.key && sameInputs(q2.inputs, inputs) && BigInt(nowSec) + QUOTE_MARGIN_S < q2.deadline;
  const api = {
    bind(ctx) {
      if (ctxKey !== ctx.key) {
        signed = null;
        quote = null;
      }
      ctxKey = ctx.key;
    },
    clear() {
      ctxKey = null;
      signed = null;
      quote = null;
    },
    holdSigned(ctx, plan, steps, bundle) {
      if (ctxKey !== ctx.key) fail("stale", "context changed");
      for (const k of steps) if (plan.steps[k]?.status !== "planned") fail("stale", `${k} is not planned`);
      signed = {
        ctxKey,
        planId: plan.id,
        termsHash: plan.termsHash,
        steps: [...steps],
        digests: Object.fromEntries(steps.map((k) => [k, plan.steps[k].review.digest])),
        bundle
      };
    },
    /** The bundle only for the SAME context, plan, terms and the SAME digest of every signed step, while every signed
     *  step is still `planned` and every step before the first signed one is still proven (no lost proof). */
    signedFor(ctx, plan) {
      if (!signed || ctxKey !== ctx.key || signed.ctxKey !== ctx.key || !plan) return null;
      if (signed.planId !== plan.id || signed.termsHash !== plan.termsHash) return null;
      for (const [k, d] of Object.entries(signed.digests)) {
        const st = plan.steps?.[k];
        if (st?.review?.digest !== d || st.status !== "planned") return null;
      }
      const order = plan.terms?.order || [];
      const at = order.indexOf(signed.steps[0]);
      if (at < 0) return null;
      for (const k of order.slice(0, at)) if (!stillProven(plan.steps[k])) return null;
      return signed.bundle;
    },
    dropSigned() {
      signed = null;
    },
    /** Hold a quote for exactly these inputs; the review itself must state the same deployment, amount, tier and sid. */
    holdQuote(ctx, record, inputs, review) {
      if (ctxKey !== ctx.key) fail("stale", "context changed");
      if (!inputs || lower(review.deployment) !== inputs.deployment || BigInt(review.call.intent.ethOut) !== BigInt(inputs.ethOut) || Number(review.call.intent.fee) !== Number(inputs.feeTier) || lower(review.sid) !== lower(record.sid)) {
        fail("quote_mismatch", "the quote does not state the requested deployment, amount, tier or session");
      }
      quote = {
        ctxKey,
        recordId: record.id,
        sid: lower(record.sid),
        inputs,
        digest: lower(review.call.digest),
        deadline: BigInt(review.call.execute.deadline),
        review
      };
    },
    /** Non-consuming: the held quote to DISPLAY for these exact inputs (else null). Used by re-renders. */
    peekQuote(ctx, inputs, nowSec) {
      return quoteFits(quote, ctx, inputs, nowSec) ? { recordId: quote.recordId, digest: quote.digest, inputs: quote.inputs, review: quote.review } : null;
    },
    /** The inputs of the held quote for this context (to restore the controls after a re-render), else null. */
    quoteInputs(ctx) {
      return quote && quote.ctxKey === ctx.key && ctxKey === ctx.key ? quote.inputs : null;
    },
    dropQuote() {
      quote = null;
    },
    /** Single use: the quote once, for the same context, record, inputs and displayed digest, > margin before deadline. */
    takeQuote(ctx, record, inputs, digest, nowSec) {
      const q2 = quote;
      quote = null;
      if (!quoteFits(q2, ctx, inputs, nowSec) || !record || q2.recordId !== record.id || q2.sid !== lower(record.sid)) return null;
      if (q2.digest !== lower(digest)) return null;
      return q2.review;
    },
    get hasSigned() {
      return signed !== null;
    },
    get hasQuote() {
      return quote !== null;
    }
  };
  return api;
}
var PROPOSAL_SCHEMA, APPROVAL_SCHEMA, MAX_TOTAL6, QUOTE_MARGIN_S, HEX32, ZERO32, ADDR, PART, DEC, StateError, fail, lower, exactKeys, dec, normRelay, isGasStep, splitOf, STEP_LABEL, stepLabel, stillProven, sameInputs;
var init_state = __esm({
  "unified-funding-20261028/client-site-repair-r2/authored/site/js/funding/state.js"() {
    PROPOSAL_SCHEMA = "enclave-funding-migration-proposal-r1";
    APPROVAL_SCHEMA = "enclave-funding-migration-approval-r1";
    MAX_TOTAL6 = 30000000n;
    QUOTE_MARGIN_S = 15n;
    HEX32 = /^0x[0-9a-f]{64}$/;
    ZERO32 = `0x${"0".repeat(64)}`;
    ADDR = /^0x[0-9a-fA-F]{40}$/;
    PART = /^[a-z0-9-]{1,24}$/;
    DEC = /^(0|[1-9][0-9]{0,37})$/;
    StateError = class extends Error {
      constructor(code, message) {
        super(message);
        this.name = "StateError";
        this.code = code;
      }
    };
    fail = (code, message) => {
      throw new StateError(code, message);
    };
    lower = (a) => String(a ?? "").toLowerCase();
    exactKeys = (o, keys, what) => {
      if (!o || typeof o !== "object" || Array.isArray(o)) fail("shape", `${what} must be an object`);
      const got = Object.keys(o).sort().join();
      if (got !== [...keys].sort().join()) fail("shape", `${what} must have exactly: ${keys.join(", ")}`);
    };
    dec = (v, what) => {
      const s = typeof v === "bigint" ? v.toString() : String(v);
      if (!DEC.test(s)) fail("amount", `${what} must be a whole number of USDC micro-units`);
      return BigInt(s);
    };
    normRelay = (r) => String(r ?? "").replace(/\/+$/, "");
    isGasStep = (k) => k === "gasOpen" || typeof k === "string" && k.startsWith("gasOpen:");
    splitOf = (np) => ({
      legacy6: np.legacy6,
      gas: np.parts.map((x) => ({ name: x.name, budget6: x.budget6, opsPerPeriod: x.opsPerPeriod, appIds: [...x.appIds] }))
    });
    STEP_LABEL = {
      terminate: "End the original session (its budget returns to your wallet)",
      legacyOpen: "Open the replacement API session (same key, same apps)"
    };
    stepLabel = (k) => STEP_LABEL[k] ?? (k.startsWith("gasOpen:") ? `Open gas grant "${k.slice(8)}"` : k === "gasOpen" ? "Open the gas grant" : k);
    stillProven = (st) => st?.status === "proven" && !st.recheck;
    sameInputs = (a, b) => !!a && !!b && a.deployment === b.deployment && a.ethOut === b.ethOut && a.feeTier === b.feeTier;
  }
});

// unified-funding-20261028/client-site-repair-r2/authored/site/js/funding/flows.js
function createGuard(read) {
  const at = read();
  const g = {
    at,
    alive() {
      const n = read();
      return n.epoch === at.epoch && lower(n.owner) === lower(at.owner) && Number(n.chainId) === Number(at.chainId) && n.provider === at.provider && !!at.owner;
    },
    check(what = "the next step") {
      if (!g.alive()) throw cancelled(what);
    }
  };
  return g;
}
function startsSomething(before, after) {
  const a = before?.steps || {};
  const b = after?.steps || {};
  return Object.keys({ ...a, ...b }).some((k) => {
    const was = a[k]?.status;
    if (was !== "planned" && was !== "void" && was !== void 0) return false;
    return JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null);
  }) || !before && !!after;
}
function guardGasStore(store, g) {
  return Object.freeze({
    loadKey: (id) => store.loadKey(id),
    listKeys: () => store.listKeys(),
    getJournal: (id) => store.getJournal(id),
    listJournal: () => store.listJournal(),
    putJournal: (e) => store.putJournal(e),
    // core journals outcomes of its own sends (never a start)
    async saveKey(rec) {
      if (!g.alive() && rec?.status !== "open") throw cancelled("updating a gas key record");
      return store.saveKey(rec);
    },
    casJournal(id, mutate) {
      return store.casJournal(id, (cur) => {
        const before = cur ? JSON.parse(JSON.stringify(cur)) : null;
        const next = mutate(cur);
        if (!g.alive() && startsSomething(before, next)) throw cancelled("admitting or re-arming a step");
        return next;
      });
    }
  });
}
async function freshScopedPlan({ g, store, ctx, np, planId, approvalCfg }) {
  const plan = await store.getJournal(planId);
  const records = await store.listKeys();
  g.check("reading the plan");
  const sc = planScope(plan, ctx, records, np?.oldSid);
  if (!sc.ok) throw new StateError("plan_out_of_scope", `this plan does not belong to the connected context (${sc.reason})`);
  const m = proposalMatchesPlan(np, plan);
  if (!m.ok) throw new StateError("proposal_plan_mismatch", `the configured proposal differs from the plan's reviewed terms (${m.diffs.join(", ")})`);
  const ok = approvalStatus(approvalCfg, plan, ctx);
  if (!ok.ok) throw new StateError("approval_required", `not approved: ${ok.reason}`);
  return { plan, approval: ok.approval };
}
async function signFlow({ g, memory: memory2, ctx, np, approvalCfg, shown, store, provider, core, signArgs, now }) {
  g.check("signing");
  const { plan, approval } = await freshScopedPlan({ g, store, ctx, np, planId: shown.planId, approvalCfg });
  if (plan.termsHash !== shown.termsHash) throw new StateError("plan_changed", "the plan changed; review it again");
  const want = nextSignable(plan, now());
  if (want.length === 0 || want.join() !== shown.steps.join()) throw new StateError("plan_changed", "the signable steps changed; review again");
  const bundle = await core.signSteps({ ...signArgs, plan, steps: want, approval, provider: guardProvider(provider, g), now: now() });
  g.check("keeping the signatures");
  memory2.holdSigned(ctx, plan, want, bundle);
  return want;
}
async function runFlow({ g, memory: memory2, ctx, np, approvalCfg, planId, store, core, stepCtx: stepCtx2 }) {
  g.check("sending");
  const { plan } = await freshScopedPlan({ g, store, ctx, np, planId, approvalCfg });
  const bundle = memory2.signedFor(ctx, plan);
  if (!bundle) throw new StateError("signatures_stale", "the held signatures do not match this exact plan anymore; sign again");
  memory2.dropSigned();
  g.check("sending");
  return core.runMigration(stepCtx2, planId, bundle);
}
async function quoteFlow({ g, memory: memory2, ctx, inputs, store, scope, core, quoteArgs, now }) {
  g.check("quoting");
  if (!inputs) throw new StateError("quote_inputs", "choose a deployment, a whole-wei ETH amount and a fee tier");
  const records = selectOwnRecords(await store.listKeys(), ctx);
  const journal = await store.listJournal();
  g.check("quoting");
  const record = core.selectGasRecord(records, scope, inputs.deployment);
  const review = await core.quoteGasFund({
    ...quoteArgs,
    record,
    scope,
    deployment: inputs.deployment,
    ethOut: inputs.ethOut,
    feeTier: Number(inputs.feeTier),
    now: now(),
    journalEntries: journal
  });
  g.check("keeping the quote");
  memory2.holdQuote(ctx, record, inputs, review);
  return { recordId: record.id, digest: lower(review.call.digest) };
}
async function fundFlow({ g, memory: memory2, ctx, inputs, shownDigest, store, scope, core, fundArgs, now }) {
  g.check("funding");
  const records = selectOwnRecords(await store.listKeys(), ctx);
  g.check("funding");
  let record = null;
  try {
    record = inputs ? core.selectGasRecord(records, scope, inputs.deployment) : null;
  } catch {
    record = null;
  }
  const review = memory2.takeQuote(ctx, record, inputs, shownDigest, now());
  if (!review) throw new StateError("quote_stale", "the quote expired, was used, or does not match the current choices; get a new one");
  return core.confirmGasFund({ ...fundArgs, store: guardGasStore(store, g), record, review, relay: guardRelayFn(fundArgs.relay, g), now: now() });
}
var CANCELLED, cancelled, guardProvider, isRead, guardRelayFn, guardLegacyRelay, guardSetActive, guardedStepCtx;
var init_flows = __esm({
  "unified-funding-20261028/client-site-repair-r2/authored/site/js/funding/flows.js"() {
    init_state();
    CANCELLED = "context_changed";
    cancelled = (what) => new StateError(CANCELLED, `the wallet, network or page changed; ${what} was not done`);
    guardProvider = (provider, g) => provider && Object.freeze({
      async request(args) {
        g.check(`the wallet request ${args?.method ?? ""}`);
        const out = await provider.request(args);
        g.check("using the wallet's answer");
        return out;
      }
    });
    isRead = (method) => String(method).toUpperCase() === "GET";
    guardRelayFn = (relay, g) => async (method, path, body) => {
      if (!isRead(method)) g.check(`${method} ${path}`);
      return relay(method, path, body);
    };
    guardLegacyRelay = (client, g) => Object.freeze({
      request: async (method, path, body) => {
        if (!isRead(method)) g.check(`${method} ${path}`);
        return client.request(method, path, body);
      }
    });
    guardSetActive = (setActive2, g) => async (newSid, oldSid) => {
      g.check("moving the active session");
      return setActive2(newSid, oldSid);
    };
    guardedStepCtx = (base, g) => ({
      ...base,
      gasStore: guardGasStore(base.gasStore, g),
      relay: guardRelayFn(base.relay, g),
      legacyRelay: guardLegacyRelay(base.legacyRelay, g),
      setActive: guardSetActive(base.setActive, g)
    });
  }
});

// unified-funding-20261028/production-grant-terms-r1/shell/facade/vendor-funding.js
var vendor_funding_exports = {};
__export(vendor_funding_exports, {
  IndexedDbV2Store: () => IndexedDbV2Store2,
  jsonRpc: () => jsonRpc2
});
import * as Real from "/harness/vendor/funding.js";
import * as funding_star from "/harness/vendor/funding.js";
function jsonRpc2(url, fetchImpl) {
  const rpc2 = fetchImpl === void 0 ? Real.jsonRpc(url) : Real.jsonRpc(url, fetchImpl);
  return async function heldRpc(method, params = []) {
    await H.onRpc(method);
    return rpc2(method, params);
  };
}
var IndexedDbV2Store2;
var init_vendor_funding = __esm({
  "unified-funding-20261028/production-grant-terms-r1/shell/facade/vendor-funding.js"() {
    init_harness_state();
    __reExport(vendor_funding_exports, funding_star);
    IndexedDbV2Store2 = class extends Real.IndexedDbV2Store {
      constructor(...args) {
        if (args.length) throw new Error("TEST harness: the page must not choose a database name");
        super(H.dbName("v2", [Real.V2_DB, Real.LEGACY_DB]));
      }
    };
  }
});

// unified-funding-20261028/client-execution-site-r2/candidate/site/js/pages/funding.js
var funding_exports = {};
__export(funding_exports, {
  boot: () => boot
});
function act(e, owner, fn) {
  return async () => {
    if (e !== epoch || ownerNow() !== owner) {
      showToast("The wallet or page changed; refreshing.");
      return mount();
    }
    if (busy) return;
    busy = true;
    const g = createGuard(live);
    try {
      const out = await fn(g);
      if (out !== void 0) showToast(typeof out === "string" ? out : "Done");
    } catch (err) {
      showToast(`${err?.code ? `${err.code}: ` : ""}${err?.message ?? err}`);
    } finally {
      busy = false;
      if (g.alive()) await render(e, owner);
      else if (e === epoch) mount();
    }
  };
}
function mount() {
  epoch += 1;
  memory.clear();
  view.c = null;
  return render(epoch, ownerNow());
}
async function render(e, owner) {
  view.c = null;
  const b = $("#fdBody");
  if (!b) return;
  if (!owner) {
    b.innerHTML = `<p>Connect the owner wallet. Nothing is signed by connecting.</p><button class="btn" id="fdConnect">Connect wallet</button>`;
    $("#fdConnect").addEventListener("click", async () => {
      try {
        await connectWallet();
      } catch (err) {
        showToast(err.message);
      }
    });
    return;
  }
  b.innerHTML = `<section id="fdControls"><h3>Your controls</h3><p>Loading\u2026</p></section>
    <section id="fdExec"><h3>Gas payments</h3><p>Loading\u2026</p></section>
    <section id="fdMig"><h3>Funding migration</h3><p>Loading\u2026</p></section>
    <section id="fdGas"><h3>Gas for your apps</h3><p>Loading\u2026</p></section>`;
  await renderControls(e, owner);
  if (e !== epoch) return;
  await renderExecutions(e, owner);
  if (e !== epoch) return;
  if (Number(Enclave.chainId) !== CHAIN) {
    $("#fdMig").innerHTML = `<h3>Funding migration</h3><p>Switch your wallet to Base to continue. Nothing is offered on another network.</p>`;
    $("#fdGas").innerHTML = `<h3>Gas for your apps</h3><p>Switch your wallet to Base.</p>`;
    return;
  }
  await renderMigration(e, owner);
  if (e !== epoch) return;
  await renderGas(e, owner);
}
async function renderControls(e, owner) {
  const box = $("#fdControls");
  let f, target = null, relay = null, store = null, recs = [];
  const why = {};
  try {
    f = await lib();
  } catch (err) {
    box.innerHTML = `<h3>Your controls</h3><p>The funding client could not load: ${errText(err)}</p>`;
    return;
  }
  try {
    target = f.controlsTarget(f.parseRuntimePins(FUNDING_RUNTIME), owner);
  } catch (err) {
    why.pins = err;
  }
  try {
    relay = f.relayClient(relayRoot());
  } catch (err) {
    why.relay = err;
  }
  try {
    store = new f.IndexedDbV2Store();
    if (target) recs = selectOwnRecords(await store.listKeys(), controlsContextOf({ owner, chainId: CHAIN, vault: target.vault, relay: relayRoot() }));
  } catch (err) {
    why.store = err;
  }
  if (e !== epoch) return;
  const open = recs.filter((r) => r.sid && (r.status === "open" || r.status === "submitted"));
  const av = controlsAvailability({ pinsOk: !!target, relayOk: !!relay, storeOk: !!store, ownRecords: open.length });
  box.innerHTML = `<h3>Your controls (work even when new funding is paused)</h3>
    ${target ? `<p>Your gas vault: <code>${esc(target.vault)}</code></p>` : `<p>Gas funding is not set up on this site (${errText(why.pins)}).</p>`}
    ${av.reason && target ? `<p>Unavailable: ${esc(av.reason)}</p>` : ""}
    ${open.map((r) => `<div><strong>${esc(r.label || "Gas grant")}</strong> \xB7 ${esc((r.grant?.apps || []).length)} apps \xB7 <code>${esc(r.sid.slice(0, 12))}\u2026</code>
      <button class="btn" data-end="${esc(r.id)}" ${av.end ? "" : "disabled"}>End (this browser's key)</button>
      <button class="btn" data-term="${esc(r.id)}" ${av.terminate ? "" : "disabled"}>Terminate (wallet)</button></div>`).join("")}
    ${target ? `<label>Withdraw unallocated USDC (micro-units) <input id="fdWAmt" inputmode="numeric" value=""></label>
      <button class="btn" id="fdWd" ${av.withdraw ? "" : "disabled"}>Withdraw (wallet)</button>` : ""}
    <p>Original sessions (the API session) are managed on the <a href="sessions">Sessions</a> page.</p>`;
  const byId = (id) => open.find((r) => r.id === id);
  box.querySelectorAll("[data-end]").forEach((el) => el.addEventListener("click", act(e, owner, async (g) => {
    const rec = byId(el.dataset.end);
    if (!rec) throw new Error("that record is not yours or no longer live");
    await f.endGasSession({ record: rec, relay: guardRelayFn(relay, g), store: guardGasStore(store, g), now: nowS() });
    return "Sign-out sent; check its status on chain";
  })));
  box.querySelectorAll("[data-term]").forEach((el) => el.addEventListener("click", act(e, owner, async (g) => {
    const rec = byId(el.dataset.term);
    if (!rec) throw new Error("that record is not yours or no longer live");
    await f.ownerControl({
      target,
      provider: guardProvider(Enclave.provider, g),
      relay: guardRelayFn(relay, g),
      store: guardGasStore(store, g),
      op: "terminate",
      sessionId: rec.sid,
      now: nowS()
    });
    return "Terminate sent";
  })));
  if (target) $("#fdWd").addEventListener("click", act(e, owner, async (g) => {
    await f.ownerControl({
      target,
      provider: guardProvider(Enclave.provider, g),
      relay: guardRelayFn(relay, g),
      store: guardGasStore(store, g),
      op: "withdraw",
      amount: $("#fdWAmt").value.trim(),
      now: nowS()
    });
    return "Withdraw sent";
  }));
}
async function context(owner) {
  const f = await lib();
  const S2 = await sdk();
  const cfg = await sessionsConfig();
  if (!cfg) throw new Error("Sessions are not available on this API endpoint.");
  const rpc2 = f.jsonRpc(cfg.rpc || APP_CATALOG_RPCS[0]);
  const relay = f.relayClient(relayRoot());
  const runtime = await f.verifyRuntime({ pins: FUNDING_RUNTIME, rpc: rpc2, relay, owner, now: nowS() });
  const ctx = contextOf({ owner, chainId: CHAIN, vault: runtime.cfg.vault, legacyVault: runtime.cfg.legacyVault, relay: relayRoot() });
  return { f, S: S2, cfg, rpc: rpc2, relay, runtime, ctx, chain: f.legacyChain(rpc2, S2), legacyStore: new S2.IndexedDbStore(), gasStore: new f.IndexedDbV2Store() };
}
async function renderExecutions(e, owner) {
  const box = $("#fdExec");
  let f, target, store, recs = [], entries = [];
  try {
    f = await lib();
    target = f.controlsTarget(f.parseRuntimePins(FUNDING_RUNTIME), owner);
    store = new f.IndexedDbV2Store();
    recs = selectOwnRecords(await store.listKeys(), controlsContextOf({ owner, chainId: CHAIN, vault: target.vault, relay: relayRoot() }));
    entries = await store.listJournal();
  } catch (err) {
    if (e === epoch) box.innerHTML = `<h3>Gas payments</h3><p>Not available (${errText(err)}).</p>`;
    return;
  }
  if (e !== epoch) return;
  const open = recs.flatMap((r) => f.listGasExecutions(entries, r).filter((x) => x.blocking).map((x) => ({ ...x, label: r.label })));
  box.innerHTML = `<h3>Gas payments</h3>
    ${open.length ? "" : "<p>No unresolved gas payment in this browser.</p>"}
    ${open.map((x) => `<div data-exec-row="${esc(x.id)}" data-exec-status="${esc(x.status)}"><strong>${esc(x.label || "Gas grant")}</strong> \xB7 <code>${esc(x.status)}</code> \xB7
      ${esc(EXEC_LABEL[x.status] ?? "Unresolved; kept reserved.")}${x.maximum ? ` \xB7 at most ${esc(usd(x.maximum.totalMaximum6))}` : ""}${x.evidence?.txHash ? ` \xB7 tx <code>${esc(x.evidence.txHash.slice(0, 12))}\u2026</code>` : ""}
      <button class="btn" data-exec="${esc(x.id)}">Check status on chain (read-only)</button></div>`).join("")}
    ${open.length ? "<p>A new gas payment for those grants is blocked until a check resolves them. A check never signs or resends anything.</p>" : ""}`;
  box.querySelectorAll("[data-exec]").forEach((el) => el.addEventListener("click", act(e, owner, async (g) => {
    const rpc2 = f.jsonRpc(APP_CATALOG_RPCS[0]);
    const relay = f.relayClient(relayRoot());
    const runtime = await f.verifyRuntime({ pins: FUNDING_RUNTIME, rpc: rpc2, relay, owner, now: nowS() });
    const r = await f.reconcileGasExecution({
      runtime,
      store: guardGasStore(store, g),
      rpc: rpc2,
      relay: guardRelayFn(relay, g),
      relayBase: relayRoot(),
      id: el.dataset.exec
    });
    return `Payment ${r.status}: ${r.verdict}${r.why ? ` (${r.why})` : ""}`;
  })));
}
async function setActive(newSid, oldSid) {
  const d = activePointerDecision(lsGet(WALLET_SESSION_KEY), newSid, oldSid);
  if (d === "keep") {
    showToast("The replacement session is ready; your current session choice was kept.");
    return;
  }
  if (d === "noop") return;
  lsSet(WALLET_SESSION_KEY, newSid);
  emit("enclave:session", { active: true });
  await accountFromSession().catch((err) => showToast(`Replacement session open; account login failed: ${err.message}`));
}
async function renderMigration(e, owner) {
  const box = $("#fdMig");
  if (!FUNDING_RUNTIME) {
    box.innerHTML = `<h3>Funding migration</h3><p>Not available: no deployed successor is configured for this site.</p>`;
    return;
  }
  let np;
  try {
    np = validateProposal(FUNDING_MIGRATION_PROPOSAL, { owner, chainId: CHAIN });
  } catch (err) {
    box.innerHTML = `<h3>Funding migration</h3><p>No migration is offered to this wallet (${errText(err)}).</p>`;
    return;
  }
  if (!np) {
    box.innerHTML = `<h3>Funding migration</h3><p>No migration has been proposed for this site.</p>`;
    return;
  }
  let c2;
  try {
    c2 = await context(owner);
  } catch (err) {
    box.innerHTML = `<h3>Funding migration</h3><p>Unavailable right now: ${errText(err)}</p>`;
    return;
  }
  const entries = await c2.gasStore.listJournal();
  const records = await c2.gasStore.listKeys();
  if (e !== epoch || ownerNow() !== owner) return;
  view.c = c2;
  memory.bind(c2.ctx);
  const plans = selectPlans(entries, c2.ctx, np.oldSid, records);
  const refused = entries.filter((x) => x?.kind === "migration" && lower(x.terms?.owner) === c2.ctx.owner && lower(x.terms?.legacy?.oldSid) === lower(np.oldSid) && !plans.includes(x)).map((x) => planScope(x, c2.ctx, records, np.oldSid).reason);
  if (plans.length > 1) {
    box.innerHTML = `<h3>Funding migration</h3><p>More than one plan exists for this session in this browser; resolve them before continuing.</p>`;
    return;
  }
  const plan = plans[0] ?? null;
  const refusedNote = refused.length ? `<p>A plan for this session exists in this browser but is not usable here (${refused.map(esc).join(", ")}):
    it was prepared for another relay, vault or key records. It is left untouched.</p>` : "";
  if (!plan) {
    const money2 = moneyRows({ original6: null, legacy6: np.legacy6, parts: np.parts });
    box.innerHTML = `<h3>Funding migration (proposed, not prepared)</h3>
      <p>Your original session <code>${esc(np.oldSid.slice(0, 12))}\u2026</code> would be ended (its budget returns to your wallet), reopened
        with the <strong>same key and the same permissions</strong>, and the rest funds gas for the named apps only. It is not atomic.</p>
      <table><tbody>${money2.rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(usd(r.amount6))}</td></tr>`).join("")}
        <tr><td><strong>Total</strong></td><td><strong>${esc(usd(money2.total6))}</strong> (checked against the original when prepared)</td></tr></tbody></table>
      ${refusedNote}
      <p>Step 1: check your original session in this browser and prepare the exact plan for review (no wallet).</p>
      <button class="btn" id="fdPrepare" ${refused.length ? "disabled" : ""}>Check original &amp; prepare plan</button>`;
    if (!refused.length) $("#fdPrepare").addEventListener("click", act(e, owner, async (g) => {
      const scope = await c2.f.freshRecoveryScope({
        rpc: c2.rpc,
        book: c2.cfg.book,
        owner,
        legacyVault: c2.runtime.cfg.legacyVault,
        deploymentIds: [...np.deploymentIds],
        now: nowS()
      });
      const cov = scopeCoverage(np, scope.appIds);
      if (!cov.ok) throw new Error(`the proposal does not match the deployments' apps (uncovered ${cov.uncovered.length}, extra ${cov.extra.length})`);
      const evidence = await c2.f.loadLegacyEvidence({
        S: c2.S,
        legacyStore: c2.legacyStore,
        sid: np.oldSid,
        owner,
        chain: c2.chain,
        legacyConfig: c2.cfg,
        runtime: c2.runtime,
        now: nowS()
      });
      g.check("preparing the plan");
      await c2.f.buildMigrationPlan({
        S: c2.S,
        evidence,
        runtime: c2.runtime,
        scope,
        split: splitOf(np),
        now: nowS(),
        gasStore: guardGasStore(c2.gasStore, g),
        relayBase: relayRoot()
      });
      return "Plan prepared. It now needs review before anything can be signed.";
    }));
    return;
  }
  const tv = termsView(plan);
  const match = proposalMatchesPlan(np, plan);
  const money = moneyRows({ original6: tv.original6, legacy6: tv.legacy6, parts: tv.parts });
  const appr = approvalStatus(FUNDING_MIGRATION_APPROVAL, plan, c2.ctx);
  const now = nowS();
  const signedReady = memory.signedFor(c2.ctx, plan);
  const phase2 = planPhase(plan, now, !!signedReady);
  const next = nextSignable(plan, now);
  const legacyLabel = legacyScopeLabel(tv.legacyApps);
  const canSign = appr.ok && match.ok && next.length > 0 && !signedReady;
  box.innerHTML = `<h3>Funding migration (prepared plan)</h3>
    <p>These are the plan's own terms; every signature covers exactly these amounts.</p>
    <table><tbody>
      <tr><td>Held in the original session</td><td>${esc(usd(tv.original6))}</td></tr>
      ${money.rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(usd(r.amount6))}</td></tr>`).join("")}
      <tr><td><strong>Total</strong></td><td><strong>${esc(usd(money.total6))}</strong> ${money.ok ? "= the original, nothing added" : "DOES NOT match the original"}</td></tr>
    </tbody></table>
    ${tv.parts.map((x) => `<details><summary>Gas grant "${esc(x.name)}": ${x.appIds.length} apps, at most ${esc(String(x.opsPerPeriod))} operations per day</summary>
      <ul>${x.appIds.map((a) => `<li><code>${esc(a)}</code></li>`).join("")}</ul></details>`).join("")}
    <p>Recovery deployments: ${tv.deploymentIds.length}. Replacement session apps: <strong>${esc(legacyLabel.text)}</strong>, exactly as your original grant.</p>
    ${match.ok ? "" : `<p><strong>The site's configured proposal differs from this plan (${esc(match.diffs.join(", "))}). Nothing can be signed or sent; you can still check status.</strong></p>`}
    <p>Plan fingerprint (termsHash): <code>${esc(plan.termsHash)}</code></p>
    <p><strong>${appr.ok ? "Approved for exactly this plan." : appr.reason === "waiting_for_review" ? "Waiting for review: nothing can be signed until this exact plan is approved." : `Not approved (${esc(appr.reason)}). Nothing can be signed.`}</strong></p>
    <ol>${plan.terms.order.map((k) => {
    const v = stepView(plan.steps[k], now);
    return `<li data-tone="${esc(v.tone)}"><strong>${esc(stepLabel(k))}</strong>: ${esc(v.label)}
      ${v.actions.includes("rearm") ? `<button class="btn" data-rearm="${esc(k)}">Prepare again</button>` : ""}</li>`;
  }).join("")}</ol>
    ${phase2.phase === "done" ? "<p>Migration complete.</p>" : ""}
    ${phase2.phase === "reconcile" ? "<p>Check what happened on chain before anything else. Nothing is resent automatically.</p>" : ""}
    <button class="btn" id="fdRec">Check status on chain</button>
    <button class="btn" id="fdSign" ${canSign ? "" : "disabled"}>Sign next ${next.length ? `(${next.length} step${next.length === 1 ? "" : "s"})` : ""}</button>
    <button class="btn" id="fdRun" ${signedReady && match.ok && appr.ok ? "" : "disabled"}>Send signed steps</button>`;
  const shown = { planId: plan.id, termsHash: plan.termsHash, steps: next };
  const flowArgs = (g) => ({ g, memory, ctx: c2.ctx, np, approvalCfg: FUNDING_MIGRATION_APPROVAL, store: c2.gasStore });
  $("#fdRec").addEventListener("click", act(e, owner, async (g) => {
    const r = await c2.f.reconcileMigration(stepCtx(c2, g), plan.id);
    return `Status: ${Object.entries(r.steps).map(([k, s]) => `${k} ${s}`).join(", ")}`;
  }));
  $("#fdSign").addEventListener("click", act(e, owner, async (g) => {
    const want = await signFlow({
      ...flowArgs(g),
      shown,
      provider: Enclave.provider,
      core: c2.f,
      signArgs: { S: c2.S, rpc: c2.rpc, runtime: c2.runtime },
      now: nowS
    });
    return `Signed ${want.length} step(s). Review, then send.`;
  }));
  $("#fdRun").addEventListener("click", act(e, owner, async (g) => {
    const r = await runFlow({ ...flowArgs(g), planId: plan.id, core: c2.f, stepCtx: stepCtx(c2, g) });
    return r.done ? "Migration complete" : r.pending ? "Sent; waiting for chain confirmation" : r.needsSignature ? "Next step needs signing" : "Check status on chain";
  }));
  box.querySelectorAll("[data-rearm]").forEach((el) => el.addEventListener("click", act(e, owner, async (g) => {
    memory.dropSigned();
    await c2.f.rearmStep({ ...stepCtx(c2, g), rng: void 0 }, plan.id, el.dataset.rearm);
    return "Prepared again; it needs signing (the approval is unchanged because the terms are unchanged).";
  })));
}
async function renderGas(e, owner) {
  const box = $("#fdGas");
  const c2 = view.c;
  let np = null;
  try {
    np = validateProposal(FUNDING_MIGRATION_PROPOSAL, { owner, chainId: CHAIN });
  } catch {
    np = null;
  }
  if (!c2 || !np) {
    box.innerHTML = `<h3>Gas for your apps</h3><p>Not available here.</p>`;
    return;
  }
  if (!c2.runtime.intake) {
    box.innerHTML = `<h3>Gas for your apps</h3><p>New gas funding is paused (${esc(c2.runtime.intakeWhy || "intake off")}). Your controls above still work.</p>`;
    return;
  }
  const recs = selectOwnRecords(await c2.gasStore.listKeys(), c2.ctx).filter((r) => r.status === "open");
  const execEntries2 = await c2.gasStore.listJournal();
  const execOpen = recs.flatMap((r) => c2.f.listGasExecutions(execEntries2, r).filter((x) => x.blocking));
  if (!recs.length) {
    memory.dropQuote();
    box.innerHTML = `<h3>Gas for your apps</h3><p>No open gas grant in this browser.</p>`;
    return;
  }
  let scope;
  try {
    scope = await c2.f.freshRecoveryScope({
      rpc: c2.rpc,
      book: c2.cfg.book,
      owner,
      legacyVault: c2.runtime.cfg.legacyVault,
      deploymentIds: [...np.deploymentIds],
      now: nowS()
    });
  } catch (err) {
    box.innerHTML = `<h3>Gas for your apps</h3><p>The deployment list could not be read (${errText(err)}).</p>`;
    return;
  }
  if (e !== epoch || ownerNow() !== owner) return;
  const deps = [...scope.deployments.keys()];
  const tiers = c2.runtime.intake.feeTiers.map(String);
  const held = memory.quoteInputs(c2.ctx);
  if (held && (!deps.includes(held.deployment) || !tiers.includes(held.feeTier))) memory.dropQuote();
  const start = memory.quoteInputs(c2.ctx) ?? { deployment: deps[0], ethOut: "20000000000000", feeTier: tiers[0] };
  box.innerHTML = `<h3>Gas for your apps</h3>
    <select id="fdDep">${deps.map((d) => `<option value="${esc(d)}" ${d === start.deployment ? "selected" : ""}>${esc(d.slice(0, 12))}\u2026 (app ${esc(scope.deployments.get(d).appId.slice(0, 10))}\u2026)</option>`).join("")}</select>
    <label>ETH to buy (wei) <input id="fdEth" inputmode="numeric" value="${esc(start.ethOut)}"></label>
    <select id="fdTier">${tiers.map((t) => `<option ${t === start.feeTier ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
    ${execOpen.length ? `<p data-exec-blocked="${execOpen.length}"><strong>${execOpen.length} gas payment(s) of this browser are not resolved yet (see Gas payments). No new payment can be quoted for those grants until a check resolves them.</strong></p>` : ""}
    <button class="btn" id="fdQuote">Get quote</button>
    <div id="fdQuoteOut"></div>
    <button class="btn" id="fdFund" disabled>Sign with this browser's gas key &amp; fund</button>`;
  const inputs = () => quoteInputsOf({ deployment: $("#fdDep").value, ethOut: $("#fdEth").value, feeTier: $("#fdTier").value });
  const out = $("#fdQuoteOut");
  const fund = $("#fdFund");
  const show = () => {
    const q2 = memory.peekQuote(c2.ctx, inputs(), nowS());
    if (!q2) {
      out.innerHTML = "";
      out.dataset.digest = "";
      fund.disabled = true;
      return;
    }
    const rec = recs.find((r) => r.id === q2.recordId);
    const qv = quoteView(q2.review, nowS());
    out.dataset.digest = q2.digest;
    out.innerHTML = `<p>Grant <strong>${esc(rec?.label || q2.recordId)}</strong>, deployment <code>${esc(q2.inputs.deployment.slice(0, 12))}\u2026</code>,
      ${esc(q2.inputs.ethOut)} wei, tier ${esc(q2.inputs.feeTier)}: ${qv.text.map(esc).join(" \xB7 ")} \xB7 valid ${qv.secondsLeft}s \xB7
      call <code>${esc(q2.digest.slice(0, 12))}\u2026</code></p>`;
    fund.disabled = qv.expired;
  };
  show();
  const changed = () => {
    memory.dropQuote();
    show();
    out.innerHTML = "<p>Choices changed; get a new quote.</p>";
  };
  for (const id of ["#fdDep", "#fdEth", "#fdTier"]) {
    $(id).addEventListener("input", changed);
    $(id).addEventListener("change", changed);
  }
  $("#fdQuote").addEventListener("click", act(e, owner, async (g) => {
    memory.dropQuote();
    await quoteFlow({
      g,
      memory,
      ctx: c2.ctx,
      inputs: inputs(),
      store: c2.gasStore,
      scope,
      core: c2.f,
      quoteArgs: { runtime: c2.runtime, relay: guardRelayFn(c2.relay, g) },
      now: nowS
    });
    return "Quote ready: review it, then fund.";
  }));
  fund.addEventListener("click", act(e, owner, async (g) => {
    fund.disabled = true;
    const r = await fundFlow({
      g,
      memory,
      ctx: c2.ctx,
      inputs: inputs(),
      shownDigest: out.dataset.digest || "",
      store: c2.gasStore,
      scope,
      core: c2.f,
      fundArgs: {
        runtime: c2.runtime,
        relay: c2.relay,
        rpc: c2.rpc,
        relayBase: relayRoot(),
        // client-execution-site-r2
        dispatchGuard: () => g.check("sending the payment")
      },
      now: nowS
    });
    return r.pending ? "Sent, not on chain yet: see Gas payments (it is never resent)" : r.status === "settled" ? `Funded: ${usd(r.settlement.actual.totalDebit6)} used (final on chain)` : `Funded: ${usd(r.settlement.actual.totalDebit6)} used (on chain, NOT final yet: Gas payments keeps it until a check proves finality)`;
  }));
}
function boot() {
  mount();
}
var CHAIN, F, lib, nowS, usd, memory, epoch, busy, view, errText, ownerNow, live, EXEC_LABEL, stepCtx;
var init_funding = __esm({
  "unified-funding-20261028/client-execution-site-r2/candidate/site/js/pages/funding.js"() {
    init_empty();
    init_empty();
    init_empty();
    init_api();
    init_wallet();
    init_util();
    init_sessions();
    init_config();
    init_state();
    init_flows();
    CHAIN = 8453;
    F = null;
    lib = async () => F ??= await Promise.resolve().then(() => (init_vendor_funding(), vendor_funding_exports));
    nowS = () => BigInt(Math.floor(Date.now() / 1e3));
    usd = formatUsd6;
    memory = createMemory();
    epoch = 0;
    busy = false;
    view = { c: null };
    errText = (e) => `${esc(e?.code ? `${e.code}: ` : "")}${esc(e?.message ?? String(e))}`;
    ownerNow = () => lower(Enclave.address || "");
    live = () => ({ epoch, owner: Enclave.address || "", chainId: Enclave.chainId, provider: Enclave.provider });
    EXEC_LABEL = {
      admitted: "Admitted but not sent; a check releases it only if it was never dispatched.",
      dispatching: "Outcome unknown: it may have been processed. It is never resent.",
      unknown: "Outcome unknown: it may have been processed. It is never resent.",
      pending: "Sent; not on chain yet. It is never resent.",
      observed: "On chain, but not final yet. A check must prove finality before another payment.",
      reverted_observed: "Its transaction reverted on chain; the signed payment may still be usable until its deadline, so it stays reserved.",
      superseded_observed: "Its nonce was used by another operation; not final yet."
    };
    stepCtx = (c2, g) => guardedStepCtx({
      S: c2.S,
      chain: c2.chain,
      legacyRelay: new c2.S.RelayClient(relayRoot()),
      relay: c2.relay,
      runtime: c2.runtime,
      legacyStore: c2.legacyStore,
      gasStore: c2.gasStore,
      setActive,
      now: nowS()
    }, g);
    on("enclave:wallet", () => {
      if ($("#fdBody")) mount();
    });
  }
});

// unified-funding-20261028/production-grant-terms-r1/shell/main.mjs
init_util();
init_api();
init_harness_state();
import * as F2 from "/harness/vendor/funding.js";
var OTHER = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
var OLD_ACTIONS = [
  "deploy.create",
  "deploy.fund",
  "deploy.setAppRef",
  "deploy.setConfig",
  "deploy.setShares",
  "deploy.setMaxRate",
  "deploy.setActive",
  "deploy.refund",
  "api.status",
  "api.logs",
  "api.restart",
  "api.upload",
  "api.appAccess",
  "api.placement",
  "api.account"
];
var OLD_BUDGET = 30000000n;
var ORDER = ["terminate", "legacyOpen", "gasOpen:nucbox", "gasOpen:metal"];
var WAIT_MS = 9e4;
var $2 = (id) => document.getElementById(id);
var lower2 = (a) => String(a ?? "").toLowerCase();
var hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
var big = (_k, v) => typeof v === "bigint" ? v.toString() : v;
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var origin = location.origin;
var rpcUrl = `${origin}/rpc`;
var rpc = F2.jsonRpc(rpcUrl);
var logEl = $2("hlog");
var statusEl = $2("hstatus");
var stagesEl = $2("hstages");
var toastEl = $2("htoasts");
var log = (m) => {
  logEl.textContent += `${m}
`;
};
var setStatus = (r, m) => {
  statusEl.dataset.result = r;
  statusEl.textContent = `${r}${m ? `: ${m}` : ""}`;
};
var check = (cond, what) => {
  if (!cond) throw new Error(`assertion failed: ${what}`);
  log(`    ok  ${what}`);
};
var toasts = [];
on("enclave:toast", (d) => {
  toasts.push(String(d.message));
  toastEl.textContent = toasts.slice(-8).join("\n");
});
async function waitFor(pred, what, ms = WAIT_MS) {
  const end = Date.now() + ms;
  for (; ; ) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out (${ms / 1e3}s) waiting for ${what}`);
    await sleep(250);
  }
}
var waitToast = (since, re, what) => waitFor(() => toasts.slice(since).find((t) => re.test(t)), `toast ${what} (${re})`);
var q = (sel) => document.querySelector(`#fdBody ${sel}`);
var text = (sel) => q(sel)?.textContent ?? "";
async function settled() {
  const done = () => {
    const b = $2("fdBody");
    return !!b && !b.textContent.includes("Loading\u2026") && !!b.querySelector("#fdControls, #fdConnect");
  };
  await sleep(100);
  await waitFor(done, "the page to finish rendering");
  await sleep(500);
  await waitFor(done, "the page to finish rendering (stable)");
}
async function clickPage(sel) {
  const el = await waitFor(() => q(sel), `page element ${sel}`);
  if (el.disabled) throw new Error(`page button ${sel} is disabled`);
  el.click();
}
async function call(p, body) {
  const r = await fetch(p, body === void 0 ? { method: "GET" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body, big) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { code: j.code ?? `http_${r.status}`, status: r.status });
  return j;
}
var status = () => call("/test/fixture/status");
var tick = () => call("/test/fixture/tick", {});
var usdcOf = (fx2, a) => F2.ethCall(rpc, fx2.usdc, "balanceOf", [a]).then(BigInt);
var posts = (s) => Object.fromEntries(Object.entries(s.hits).filter(([k]) => k.startsWith("POST ")));
var v2 = () => new F2.IndexedDbV2Store(H.dbName("v2", [F2.V2_DB, F2.LEGACY_DB]));
var S = null;
var sdkReal = async () => S ??= await import("/harness/vendor/sessions.js");
var legacyStore = async () => new (await sdkReal()).IndexedDbStore(H.dbName("legacy"));
var fixtureProvider = Object.freeze({
  async request({ method, params }) {
    if (method !== "eth_signTypedData_v4") throw new Error(`the TEST fixture signer refuses ${method}`);
    const { sig } = await call("/test/owner-sign", { address: params[0], payload: params[1] });
    await H.afterSign();
    return sig;
  }
});
function walletState(address, chainId) {
  Object.assign(Enclave, { address, chainId, provider: address ? fixtureProvider : null, base: `${origin}/v1` });
  emit("enclave:wallet", { address });
}
async function fresh() {
  await tick();
  walletState(fx.owner, 8453);
  await settled();
}
var proposalOf = (f, oldSid) => ({
  schema: "enclave-funding-migration-proposal-r1",
  chainId: 8453,
  owner: f.owner,
  oldSid,
  legacy6: f.split.legacy6,
  gas: [
    { name: "nucbox", budget6: f.split.nucbox6, opsPerPeriod: f.split.nucboxOps, appIds: [...f.partition.nucbox] },
    { name: "metal", budget6: f.split.metal6, opsPerPeriod: f.split.metalOps, appIds: [...f.partition.metal] }
  ],
  deploymentIds: f.deployments.map((d) => d.id)
});
function verifyTestTerms(plan, st) {
  const t = plan.terms;
  check(t.order.join() === ORDER.join(), `order ${ORDER.join(" -> ")}`);
  check(lower2(t.owner) === lower2(fx.owner) && Number(t.chainId) === 8453, "owner + chain 8453");
  check(t.legacy.oldSid === st.oldSid && t.legacy.oldBalance6 === "30000000" && t.legacy.keyHash === st.oldKeyHash, "original sid, exactly 30, same legacy key");
  check(JSON.stringify(t.legacy.grantTemplate.apps) === '["*"]', "replacement keeps the original's explicit wildcard (never widened)");
  check(t.split.legacy6 === "24000000" && t.split.gas6 === "6000000" && t.split.total6 === "30000000", "split 24 + 6 = 30");
  const parts = t.gas.parts.map((p) => [p.name, p.budget6, p.opsPerPeriod, [...p.appIds].sort().join()]);
  check(JSON.stringify(parts) === JSON.stringify([
    ["nucbox", "4800000", "16", [...fx.partition.nucbox].sort().join()],
    // production-grant-terms-r1
    ["metal", "1200000", "4", [...fx.partition.metal].sort().join()]
  ]), "gas parts: nucbox 4.8 / 16 ops / 8 apps, metal 1.2 / 4 ops / 2 apps");
  check(!t.gas.parts.some((p) => p.appIds.includes("*")), "no gas wildcard");
  const NEW_CANDIDATE = {
    id: "gas-recovery-6usdc-r1",
    budget: "6000000",
    spendPerPeriod: "6000000",
    periodSeconds: "86400",
    opsPerPeriod: "20",
    maxFeePerOp: "80000",
    maxGasUsdcPerOp: "600000",
    maxUsdcPerEth6: "2500000000",
    maxEthPerOp: "200000000000000"
  };
  check(Object.entries(NEW_CANDIDATE).every(([k, v]) => t.gasCandidate?.[k] === v), "terms carry the exact NEW candidate literals");
  check(t.gas.parts.every((p) => p.grantTemplate.maxFeePerOp === "80000" && p.grantTemplate.maxGasUsdcPerOp === "600000" && p.grantTemplate.maxEthPerOp === "200000000000000" && p.grantTemplate.maxUsdcPerEth6 === "2500000000" && p.grantTemplate.spendPerPeriod === p.budget6 && p.grantTemplate.budget === p.budget6), "each part grant: the candidate caps, its own budget per period");
  check([...t.gas.deployments].sort().join() === fx.deployments.map((d) => d.id).sort().join(), "the ten fixture deployments");
  check(F2.hashOf(t) === plan.termsHash, "termsHash = hash of the journaled terms");
  const shown = [...document.querySelectorAll("#fdMig code")].map((c2) => c2.textContent.trim()).filter((s) => /^0x[0-9a-f]{64}$/.test(s));
  check(shown.includes(plan.termsHash), "the page displays exactly this termsHash");
}
var planOf = async (st) => (await v2()).getJournal(`migration:${st.oldSid}`);
var fx = null;
var busy2 = false;
var PHASES = [];
function phase(id, label, need, fn) {
  PHASES.push({ id, label, need, fn });
}
function refresh() {
  const st = H.load();
  for (const p of PHASES) $2(p.id).disabled = busy2 || !fx || !(p.need === "*" || (p.need === null ? !st : st?.phase === p.need));
  $2("hphase").textContent = st ? `phase: ${st.phase}` : "phase: not started (click TEST Start)";
  $2("hdbs").textContent = st?.legacyDb ? `TEST databases: ${st.legacyDb}, ${st.v2Db}` : "no TEST databases yet";
}
async function stage(name, fn) {
  const li = document.createElement("li");
  li.textContent = `${name} ...`;
  li.dataset.result = "RUNNING";
  stagesEl.appendChild(li);
  log(`> ${name}`);
  try {
    const out = await fn();
    li.textContent = `${name}: PASS`;
    li.dataset.result = "PASS";
    return out;
  } catch (e) {
    li.textContent = `${name}: FAIL (${e?.code ? `${e.code}: ` : ""}${e?.message ?? e})`;
    li.dataset.result = "FAIL";
    throw e;
  }
}
function advance(next, msg, reload = false) {
  H.save({ ...H.load(), phase: next, last: { result: "PASS", msg } });
  setStatus("PASS", msg);
  if (reload) {
    log("reloading (the page config changes only on load)");
    location.reload();
  }
}
phase("pStart", "TEST Start: random TEST DBs + ORIGINAL 30 USDC session (SDK, 2 fixture prompts)", null, async () => {
  const tag = () => hex(crypto.getRandomValues(new Uint8Array(8)));
  const st0 = { legacyDb: `${PREFIX}legacy-${tag()}`, v2Db: `${PREFIX}v2-${tag()}`, phase: "starting" };
  H.save(st0);
  H.dbName("legacy");
  H.dbName("v2", [F2.V2_DB, F2.LEGACY_DB]);
  await call("/test/record-dbs", { names: [st0.legacyDb, st0.v2Db] });
  check((await status()).prompts.length === 0, "fresh fixture: no prompt yet");
  await tick();
  const Sx = await sdkReal();
  const ls = await legacyStore();
  const ownerStart = await usdcOf(fx, fx.owner);
  const out = await stage("original 30 USDC session opened like the site (actual SDK, real IndexedDB, explicit wildcard)", async () => {
    const { signer, record } = await Sx.newSessionKey(ls, { relay: origin, chainId: 8453, label: "client-site-browser-r1 TEST original", extractable: false });
    check(record.privateKey.extractable === false, "fresh legacy key is non-extractable");
    const t0 = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
    const grant = {
      label: "client-site-browser-r1 TEST original",
      preset: "browser",
      sessionKey: signer.keyHash,
      actions: OLD_ACTIONS,
      apps: ["*"],
      environments: ["staging", "prod"],
      budget: OLD_BUDGET,
      spendPerPeriod: 100000000n,
      periodSeconds: 86400,
      opsPerPeriod: 1e3,
      maxFeePerOp: 250000n,
      maxAppFeePerHour: 0n,
      maxRatePerHour: 5000000n,
      expiresAt: t0 + 7n * 86400n,
      measurement: `0x${"0".repeat(64)}`,
      grantNonce: `0x${hex(crypto.getRandomValues(new Uint8Array(32)))}`,
      signBefore: t0 + 900n
    };
    const usdcDom = await Sx.usdcDomain(Sx.chainClient(8453, rpcUrl), fx.usdc, 8453);
    const ownerSigner = { address: fx.owner, signTypedData: async (td) => (await call("/test/owner-sign", { address: fx.owner, payload: JSON.stringify(td, big) })).sig };
    await Sx.openSession({ relay: new Sx.RelayClient(origin), owner: ownerSigner, chainId: 8453, vault: fx.legacyVault, grant, usdc: usdcDom });
    const rec = await Sx.completeSession(ls, record, { vault: fx.legacyVault, owner: fx.owner, grant, rpc: rpcUrl });
    const back = await ls.load(lower2(rec.id));
    check(back.privateKey instanceof CryptoKey && back.privateKey.extractable === false, "original record reloaded: non-extractable CryptoKey");
    let exported = false;
    try {
      await crypto.subtle.exportKey("pkcs8", back.privateKey);
      exported = true;
    } catch {
    }
    check(!exported, "pkcs8 export refused");
    check(await usdcOf(fx, fx.owner) === ownerStart - OLD_BUDGET, "owner wallet down exactly 30 (mock USDC)");
    return { oldSid: lower2(rec.id), oldKeyHash: lower2(rec.keyHash) };
  });
  check((await status()).prompts.length === 2, "exactly 2 fixture prompts so far");
  H.save({ ...H.load(), ...out, ownerStart: ownerStart.toString(), connected: true });
  advance("original", "original open; the page now gets the TEST proposal for this sid", true);
});
phase("pPrepare", "1. Page button: Check original & prepare plan (no wallet)", "original", async () => {
  const st = H.load();
  await fresh();
  check(text("#fdMig").includes("proposed, not prepared") && text("#fdMig").includes("$24.00") && text("#fdMig").includes("$4.80") && text("#fdMig").includes("$1.20"), "page shows the proposed 24 / 4.80 / 1.20 split");
  const before = await status();
  const n = toasts.length;
  await clickPage("#fdPrepare");
  await waitToast(n, /Plan prepared/, "plan prepared");
  await settled();
  const plan = await planOf(st);
  await stage("journaled plan is exactly the TEST terms and is what the page displays", () => verifyTestTerms(plan, st));
  check(text("#fdMig").includes("Waiting for review") && q("#fdSign").disabled && q("#fdRun").disabled, "waiting for review: Sign and Send disabled");
  check(text("#fdMig").includes("$30.00") && text("#fdMig").includes("= the original, nothing added"), "page: total 30 = the original");
  const after = await status();
  check(after.prompts.length === before.prompts.length && JSON.stringify(posts(after)) === JSON.stringify(posts(before)), "no prompt, no POST");
  const keys = await (await v2()).listKeys();
  check(keys.length === 2 && keys.every((r) => r.privateKey.extractable === false && r.relay === origin), "two fresh non-extractable gas keys for THIS relay");
  advance("planned", "plan prepared and displayed; click TEST-approve");
});
phase("pApprove", "2. Harness: TEST-approve exactly the displayed TEST plan (reloads)", "planned", async () => {
  const st = H.load();
  await fresh();
  const plan = await planOf(st);
  await stage("re-check TEST terms before approving", () => verifyTestTerms(plan, st));
  const approval = { schema: "enclave-funding-migration-approval-r1", rootReviewed: true, termsHash: plan.termsHash, owner: fx.owner, chainId: 8453, oldSid: st.oldSid };
  log(`    TEST approval for termsHash ${plan.termsHash} (TEST terms only; never a production approval)`);
  H.save({ ...H.load(), approval });
  advance("approved", "TEST approval set for this exact plan", true);
});
phase("pSwitch1", "3. Page Sign with an ACCOUNT switch while the 2nd prompt is open (expect stop, nothing kept)", "approved", async () => {
  const st = H.load();
  await fresh();
  check(text("#fdMig").includes("Approved for exactly this plan.") && /\(4 steps\)/.test(text("#fdSign")) && !q("#fdSign").disabled, "approved; Sign next (4 steps) enabled");
  const before = await status();
  H.armSign(2, async () => {
    log("    (hold) switching the account to a public non-owner address while prompt 2 is open");
    walletState(OTHER, 8453);
  });
  const n = toasts.length;
  await clickPage("#fdSign");
  await waitToast(n, /context_changed/, "cancelled by the switch");
  await settled();
  await sleep(1500);
  const after = await status();
  check(after.prompts.length - before.prompts.length === 2, "exactly 2 prompts: no prompt after the switch");
  check(JSON.stringify(posts(after)) === JSON.stringify(posts(before)), "no POST of any kind");
  check(text("#fdMig").includes("another wallet"), "the page now offers nothing to the other account");
  const plan = await planOf(st);
  check(ORDER.every((k) => plan.steps[k].status === "planned"), "journal untouched: all steps planned");
  await fresh();
  check(!q("#fdSign").disabled && q("#fdRun").disabled, "owner back: nothing held (Send disabled), Sign enabled again");
  advance("switched1", "account switch stopped the signing; nothing kept or sent");
});
phase("pSignSend", "4. Page buttons: Sign next (7 prompts), then Send (first gas reply is LOST)", "switched1", async () => {
  const st = H.load();
  await fresh();
  const before = await status();
  let n = toasts.length;
  await clickPage("#fdSign");
  await waitToast(n, /Signed 4 step/, "signed");
  await settled();
  const mid = await status();
  check(
    JSON.stringify(mid.prompts.slice(before.prompts.length).map((p) => p.primaryType)) === JSON.stringify([
      "Terminate",
      "SessionGrant",
      "ReceiveWithAuthorization",
      "SessionGrant",
      "ReceiveWithAuthorization",
      "SessionGrant",
      "ReceiveWithAuthorization"
    ]),
    "7 prompts after the approval, in step order"
  );
  check(!q("#fdRun").disabled, "Send signed steps enabled");
  n = toasts.length;
  await clickPage("#fdRun");
  await waitFor(() => toasts.length > n, "the send result");
  await settled();
  const j = await planOf(st);
  check(j.steps.terminate.status === "proven" && j.steps.legacyOpen.status === "proven", "terminate + replacement proven on chain");
  check(
    j.steps["gasOpen:nucbox"].status === "admitted" && !j.steps["gasOpen:nucbox"].txHash && j.steps["gasOpen:nucbox"].observed,
    "first gas open ADMITTED, no txHash: persisted intent, never resent"
  );
  check(j.steps["gasOpen:metal"].status === "planned", "second gas part untouched");
  const s = await status();
  check((s.hits["POST /v1/sessions/funding/open"] ?? 0) === 1 && s.dropped.length === 1, "one gas open sent, its reply dropped (fixture fault)");
  check(localStorage.getItem(WALLET_SESSION_KEY) === j.steps.legacyOpen.review.sid, "the page moved the TEST active pointer to the replacement");
  check(text("#fdMig").includes("Outcome unknown") && q("#fdRun").disabled && q("#fdSign").disabled, "page: outcome unknown, only Check status offered");
  H.save({ ...H.load(), newSid: j.steps.legacyOpen.review.sid });
  advance("interrupted", "interrupted as designed: click Reload page, then phase 5");
});
phase("pReload", "Reload page (F5 equivalent)", "*", async () => {
  location.reload();
});
phase("pRecover", "5. After reload: page button Check status on chain (no resend, no signature)", "interrupted", async () => {
  const st = H.load();
  check(performance.getEntriesByType("navigation")[0]?.type === "reload", "this document was loaded by a reload");
  await fresh();
  const before = await status();
  const n = toasts.length;
  await clickPage("#fdRec");
  await waitToast(n, /^Status:/, "reconcile status");
  await settled();
  const j = await planOf(st);
  check(j.steps["gasOpen:nucbox"].status === "proven" && j.steps["gasOpen:metal"].status === "planned", "nucbox proven from chain logs; metal planned");
  const after = await status();
  check(after.prompts.length === before.prompts.length && JSON.stringify(posts(after)) === JSON.stringify(posts(before)), "no signature, no resend");
  check(/\(1 step\)/.test(text("#fdSign")) && !q("#fdSign").disabled, "page offers Sign next (1 step)");
  advance("recovered", "recovered after reload without resend");
});
phase("pSwitch2", "6. Page Sign metal (2 prompts), then Send with a CHAIN switch at its first chain read (expect no send)", "recovered", async () => {
  const st = H.load();
  await fresh();
  let n = toasts.length;
  const b0 = await status();
  await clickPage("#fdSign");
  await waitToast(n, /Signed 1 step/, "signed");
  await settled();
  const before = await status();
  check(before.prompts.length - b0.prompts.length === 2, "2 prompts for the metal part");
  H.armRpc(async () => {
    log("    (hold) switching the chain to 1 before the send's first chain read");
    walletState(fx.owner, 1);
  });
  n = toasts.length;
  await clickPage("#fdRun");
  await waitToast(n, /context_changed/, "cancelled by the switch");
  await settled();
  await sleep(1500);
  const after = await status();
  check(after.prompts.length === before.prompts.length && JSON.stringify(posts(after)) === JSON.stringify(posts(before)), "no prompt, no POST after the switch");
  const j = await planOf(st);
  check(
    j.steps["gasOpen:metal"].status === "planned" && ["terminate", "legacyOpen", "gasOpen:nucbox"].every((k) => j.steps[k].status === "proven"),
    "metal not admitted; earlier outcomes preserved"
  );
  check(text("#fdMig").includes("Switch your wallet to Base"), "page offers nothing off Base");
  await fresh();
  check(q("#fdRun").disabled && !q("#fdSign").disabled, "back on Base: the dropped bundle is not reused; Sign enabled");
  advance("switched2", "chain switch stopped the send before admission");
});
phase("pComplete", "7. Page buttons: Sign metal again + Send -> complete; conservation, same-key API, finite grants", "switched2", async () => {
  const st = H.load();
  await fresh();
  let n = toasts.length;
  await clickPage("#fdSign");
  await waitToast(n, /Signed 1 step/, "signed");
  await settled();
  n = toasts.length;
  await clickPage("#fdRun");
  await waitToast(n, /Migration complete/, "complete");
  await settled();
  const s = await status();
  check(s.prompts.length === 15, "15 owner prompts in total (2 original + 2 cancelled + 7 + 2 dropped bundle + 2)");
  check(
    s.hits["POST /v1/sessions/open"] === 2 && s.hits["POST /v1/sessions/owner"] === 1 && s.hits["POST /v1/sessions/funding/open"] === 2,
    "sends: original + replacement open, one terminate, two gas opens - none duplicated"
  );
  check(await usdcOf(fx, fx.owner) === BigInt(st.ownerStart) - OLD_BUDGET, "owner wallet down exactly 30 since Start (30 refunded, 24 + 4.8 + 1.2 out)");
  check(await usdcOf(fx, fx.legacyVault) === 24000000n && await usdcOf(fx, fx.vault) === 6000000n, "legacy vault 24, successor vault 6");
  const Sx = await sdkReal();
  const ls = await legacyStore();
  const rep = await ls.load(st.newSid), old = await ls.load(st.oldSid);
  check(rep && old && lower2(rep.keyHash) === st.oldKeyHash && lower2(old.keyHash) === st.oldKeyHash, "replacement and original records: the SAME key");
  const probe = async (rec) => call("/test/verify-api", { header: await (await Sx.sessionFromRecord(rec)).apiAuthorization("GET", fx.apiProbeUrl) });
  const ok = await probe(rep);
  check(ok.sid === st.newSid && ok.anyApp === true, "host verifyApiRequest accepts the replacement (same key, wildcard)");
  let refused = null;
  try {
    await probe(old);
  } catch (e) {
    refused = e;
  }
  check(refused?.status === 401, "the terminated original is refused (401)");
  const j = await planOf(st);
  const g1 = await call(`/test/fixture/gas-session/${j.steps["gasOpen:nucbox"].review.sid}`);
  const g2 = await call(`/test/fixture/gas-session/${j.steps["gasOpen:metal"].review.sid}`);
  check(g1.live && !g1.anyApp && g1.apps.sort().join() === [...fx.partition.nucbox].sort().join() && g1.balance6 === "4800000", "nucbox: its 8 apps, no wildcard, 4.8");
  check(g2.live && !g2.anyApp && g2.apps.sort().join() === [...fx.partition.metal].sort().join() && g2.balance6 === "1200000", "metal: its 2 apps, no wildcard, 1.2");
  check(text("#fdMig").includes("Migration complete."), "page: migration complete");
  advance("migrated", "migration complete through the page");
});
function setInputs(a) {
  const d = q("#fdDep"), e = q("#fdEth"), t = q("#fdTier");
  if (a.dep !== void 0) d.value = a.dep;
  if (a.eth !== void 0) e.value = a.eth;
  if (a.tier !== void 0) t.value = a.tier;
  for (const [el, v] of [[d, a.dep], [e, a.eth], [t, a.tier]]) if (v !== void 0) {
    el.dispatchEvent(new Event("input"));
    el.dispatchEvent(new Event("change"));
  }
  if (a.dep !== void 0) check(d.value === a.dep, `deployment input = ${a.dep.slice(0, 12)}\u2026`);
  if (a.tier !== void 0) check(t.value === a.tier, `tier input = ${a.tier}`);
}
var shownQuote = () => ({ digest: q("#fdQuoteOut")?.dataset.digest ?? "", text: text("#fdQuoteOut"), fund: q("#fdFund") });
async function quoteThroughPage(a) {
  setInputs(a);
  const n = toasts.length;
  await clickPage("#fdQuote");
  await waitToast(n, /Quote ready/, "quote ready");
  await settled();
  const s = shownQuote();
  check(/^0x[0-9a-f]{64}$/.test(s.digest), "after the re-render the quote is still displayed (call digest present)");
  check(q("#fdDep").value === a.dep && q("#fdEth").value === a.eth && q("#fdTier").value === a.tier, "controls restored to exactly the quoted inputs");
  check(s.text.includes(a.dep.slice(0, 12)) && s.text.includes(`${a.eth} wei`) && s.text.includes(`tier ${a.tier}`) && /relay fee \$/.test(s.text) && /total at most \$/.test(s.text) && /valid \d+s/.test(s.text), "quote shows deployment, amount, tier, fee, maximum and time left");
  check(!s.fund.disabled, "Fund enabled for this quote");
  return s.digest;
}
var nucDeps = () => fx.deployments.filter((d) => fx.partition.nucbox.includes(d.app)).map((d) => d.id);
phase("pQuote", "8. Quote stays visible after render; changing deployment / amount / tier clears it; stale fund refused", "migrated", async () => {
  await fresh();
  check(!!q("#fdQuote"), "gas section offers Get quote");
  const [depA, depB] = nucDeps();
  const A = { dep: depA, eth: fx.ethOut, tier: String(fx.feeTier) };
  for (const [what, change] of [["deployment", { dep: depB }], ["amount", { eth: (BigInt(fx.ethOut) / 2n).toString() }], ["tier", { tier: String(fx.altFeeTier) }]]) {
    await tick();
    await quoteThroughPage(A);
    const s0 = await status();
    setInputs(change);
    const s = shownQuote();
    check(s.digest === "" && s.fund.disabled && s.text.includes("Choices changed"), `changing the ${what} clears the quote and disables Fund`);
    const n = toasts.length;
    s.fund.disabled = false;
    s.fund.click();
    await waitToast(n, /quote_stale/, `stale fund refused after a ${what} change`);
    await settled();
    const s1 = await status();
    check((s1.hits["POST /v1/sessions/funding/execute"] ?? 0) === (s0.hits["POST /v1/sessions/funding/execute"] ?? 0), `no execute after the ${what} change`);
  }
  advance("quoted", "quote persistence and invalidation verified");
});
phase("pFund", "9. Page buttons: quote the selected inputs and Fund; canonical settlement and fixture balances", "quoted", async () => {
  const st = H.load();
  await fresh();
  const [depA] = nucDeps();
  const A = { dep: depA, eth: fx.ethOut, tier: String(fx.feeTier) };
  const digest = await quoteThroughPage(A);
  const j = await planOf(st);
  const sid = j.steps["gasOpen:nucbox"].review.sid;
  const bal0 = BigInt((await call(`/test/fixture/gas-session/${sid}`)).balance6);
  const vault0 = await usdcOf(fx, fx.vault);
  const s0 = await status();
  const n = toasts.length;
  await clickPage("#fdFund");
  const t = await waitToast(n, /^(Funded:|Sent)/, "fund result");
  check(/^Funded:/.test(t), "settled on a canonical receipt (not pending)");
  await settled();
  const e = (await (await v2()).listJournal()).find((x) => x.kind === "gas-execute" && lower2(x.call?.digest) === digest);
  check(
    e && ["observed", "settled"].includes(e.status) && e.evidence?.kind === "settlement" && lower2(e.deployment) === depA && lower2(e.sid) === lower2(sid),
    "journal: the displayed quote's exact call, for the selected deployment, canonically settled (final or NOT final yet)"
  );
  check(t.includes(e.status === "settled" ? "(final on chain)" : "NOT final yet"), "the page message matches the proof: never final when it is not");
  const debit = BigInt(e.evidence.actual.totalDebit6);
  check(debit > 0n && debit <= BigInt(e.maximum.totalMaximum6), "actual debit within the displayed maximum");
  check(bal0 - BigInt((await call(`/test/fixture/gas-session/${sid}`)).balance6) === debit, "grant balance down exactly the settled debit");
  check(vault0 - await usdcOf(fx, fx.vault) === debit, "successor vault USDC down exactly the settled debit");
  const s1 = await status();
  check(s1.hits["POST /v1/sessions/funding/execute"] - (s0.hits["POST /v1/sessions/funding/execute"] ?? 0) === 1, "exactly one execute");
  check(e.call.intent.ethOut === fx.ethOut && fx.ethOut === "200000000000000", "the settled call bought exactly 2e14 wei (the candidate maxEthPerOp)");
  advance("funded", "funded the selected inputs through the page");
});
var EXEC = "POST /v1/sessions/funding/execute";
var QUOTE = "POST /v1/sessions/funding/quote";
var hit = (s, k) => s.hits[k] ?? 0;
var execEntries = async () => (await (await v2()).listJournal()).filter((x) => x.kind === "gas-execute");
var execRow = (id) => q(`#fdExec [data-exec-row="${id}"]`);
var nucSidOf = async (st) => (await planOf(st)).steps["gasOpen:nucbox"].review.sid;
var sessionBal = async (sid) => BigInt((await call(`/test/fixture/gas-session/${sid}`)).balance6);
var secretFree = (e) => {
  const j = JSON.stringify(e);
  return !j.includes("privateKey") && !/"(r|s|sig|signature)":/.test(j);
};
var nucA = (k) => ({ dep: nucDeps()[k], eth: fx.ethOut, tier: String(fx.feeTier) });
async function checkUntilFinal(id, what) {
  for (let i = 0; i < 8; i++) {
    await tick();
    await tick();
    await fresh();
    const e0 = await (await v2()).getJournal(id);
    if (e0.status === "settled") return e0;
    check(!!execRow(id), `${what}: the page lists the unresolved payment (${e0.status})`);
    const n = toasts.length;
    await clickPage(`#fdExec [data-exec="${id}"]`);
    const t = await waitFor(() => toasts.slice(n)[0], `${what}: the check result`);
    log(`    ${what}: ${t}`);
    await settled();
    const e = await (await v2()).getJournal(id);
    if (e.status === "settled") return e;
    check(["observed", "unknown", "pending", "dispatching"].includes(e.status), `${what}: still reserved as ${e.status} (never cleared by time)`);
  }
  throw new Error(`${what}: not proven final within 8 bounded checks`);
}
async function quoteRefused(A, what) {
  const s0 = await status();
  setInputs(A);
  const n = toasts.length;
  await clickPage("#fdQuote");
  await waitToast(n, /unreconciled_execute/, `${what}: quote refused`);
  await settled();
  check(hit(await status(), QUOTE) === hit(s0, QUOTE), `${what}: no quote request reached the relay`);
}
phase("pExecFinal", "12. After the normal Fund: on-chain-not-final is shown and blocks a quote; page Check status until final", "funded", async () => {
  await fresh();
  const e0 = (await execEntries()).find((x) => x.evidence?.kind === "settlement");
  check(!!e0, "the funded payment is journaled with its chain evidence");
  if (e0.status === "observed") {
    check(!!execRow(e0.id) && text("#fdExec").includes("not final"), "page: the payment is on chain but NOT final, shown as unresolved");
    check(!!q("[data-exec-blocked]"), "the gas section says a payment is unresolved");
    await quoteRefused(nucA(0), "not final");
  } else log(`    note: the fixture had already finalized that block (${e0.status}); the not-final display was not observable in this run`);
  const s0 = await status();
  const done = await checkUntilFinal(e0.id, "normal payment");
  const s1 = await status();
  check(done.evidence.final === true && done.evidence.txHash === e0.evidence.txHash, "the same transaction, proven final");
  check(hit(s1, EXEC) === hit(s0, EXEC) && s1.prompts.length === s0.prompts.length, "checking status sent nothing and signed nothing");
  await fresh();
  check(!execRow(e0.id) && text("#fdExec").includes("No unresolved gas payment"), "no unresolved payment left");
  advance("execFinal", "normal payment shown truthfully until proven final");
});
async function lostReplyFund(mode, k) {
  const st = H.load();
  await fresh();
  const sid = await nucSidOf(st);
  const A = nucA(k);
  const digest = await quoteThroughPage(A);
  const bal0 = await sessionBal(sid), vault0 = await usdcOf(fx, fx.vault), s0 = await status();
  await call("/test/fixture/execute-fault", { mode });
  const n = toasts.length;
  await clickPage("#fdFund");
  const t = await waitFor(() => toasts.slice(n)[0], "the fund result");
  check(!/^Funded:/.test(t), `the page does not claim success (${t})`);
  await settled();
  const s1 = await status();
  check(
    hit(s1, EXEC) - hit(s0, EXEC) === 1 && s1.executeFaults.at(-1) === mode,
    `exactly one execute POST; its reply ${mode === "body" ? "body was truncated after headers" : "was replaced by a 502"} AFTER real processing`
  );
  check(s1.prompts.length === s0.prompts.length, "no owner prompt");
  const e = (await execEntries()).find((x) => lower2(x.call?.digest) === digest);
  check(e?.status === "unknown", "journal (real IndexedDB): UNKNOWN, never refused");
  check(e.schema === "enclave-funding-gas-execute-r2" && e.call.nonce === e.nonce && /^0x[0-9a-f]+$/.test(e.call.args) && !!e.anchor?.hash && lower2(e.sid) === lower2(sid) && lower2(e.deployment) === A.dep && e.relay === origin, "the exact public intent is persisted: call, nonce, anchor, sid, deployment, relay");
  check(secretFree(e), "no key or signature in the journal");
  check(execRow(e.id)?.dataset.execStatus === "unknown", "page: the payment is listed as unknown with a read-only Check button");
  await waitFor(async () => await sessionBal(sid) < bal0, "the really processed execute to be mined", 3e4);
  const drop = bal0 - await sessionBal(sid);
  await quoteRefused(A, `${mode}: unknown`);
  return { id: e.id, sid, bal0: bal0.toString(), vault0: vault0.toString(), drop: drop.toString(), exec: hit(s1, EXEC), prompts: s1.prompts.length };
}
async function provenOnce(L, what) {
  const done = await checkUntilFinal(L.id, what);
  const s = await status();
  check(hit(s, EXEC) === L.exec, `${what}: no execute resent`);
  check(s.prompts.length === L.prompts, `${what}: no signature`);
  const debit = BigInt(done.evidence.actual.totalDebit6);
  check(debit === BigInt(L.drop) && BigInt(L.bal0) - await sessionBal(L.sid) === debit, `${what}: the proven debit is the single on-chain balance drop`);
  check(BigInt(L.vault0) - await usdcOf(fx, fx.vault) === debit, `${what}: successor vault USDC down exactly that debit`);
  check(done.evidence.final === true && /^0x[0-9a-f]{64}$/.test(done.evidence.txHash), `${what}: exact canonical settlement, proven final`);
  return done;
}
phase("pExecLost", "13. Page Fund with the reply body LOST after headers: persisted UNKNOWN with the exact intent (then Reload)", "execFinal", async () => {
  const L = await lostReplyFund("body", 1);
  H.save({ ...H.load(), lostBody: L });
  advance("execUnknown", "UNKNOWN persisted; click Reload page, then phase 14");
});
phase("pExecReload", "14. After reload: the UNKNOWN row is still there; page Check status proves it once, read-only", "execUnknown", async () => {
  const L = H.load().lostBody;
  check(performance.getEntriesByType("navigation")[0]?.type === "reload", "this document was loaded by a reload");
  await fresh();
  check(!!execRow(L.id), "after reload the recovery row is still listed (real IndexedDB)");
  check((await (await v2()).getJournal(L.id)).status === "unknown", "still UNKNOWN after reload");
  await stage("store-level, NOT page: two concurrent IndexedDB compare-and-set creates of one id - exactly one commits", async () => {
    const id = `harness-cas-probe:${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
    const mk = (who) => (cur) => {
      if (cur) throw Object.assign(new Error("exists"), { code: "exists" });
      return { id, kind: "harness-cas-probe", who };
    };
    const r = await Promise.allSettled([v2().casJournal(id, mk("a")), v2().casJournal(id, mk("b"))]);
    check(r.filter((x) => x.status === "fulfilled").length === 1 && r.filter((x) => x.status === "rejected").length === 1, "exactly one create committed");
  });
  await provenOnce(L, "lost-body payment");
  advance("execRecovered", "lost-body payment recovered read-only after reload");
});
phase("pExec502", "15. Page Fund answered by a gateway 502 AFTER real processing: UNKNOWN, then page Check status proves it once", "execRecovered", async () => {
  const L = await lostReplyFund("gateway502", 2);
  await provenOnce(L, "502 payment");
  advance("exec502Done", "gateway-502 payment recovered read-only");
});
phase("pExecSwitch", "16. Page Fund with an ACCOUNT switch, then a CHAIN switch, at the payment's first chain read: nothing admitted or sent", "exec502Done", async () => {
  const sid = await nucSidOf(H.load());
  for (const [what, to] of [["account", () => walletState(OTHER, 8453)], ["chain", () => walletState(fx.owner, 1)]]) {
    await fresh();
    await quoteThroughPage(nucA(3));
    const s0 = await status(), n0 = (await execEntries()).length, bal0 = await sessionBal(sid);
    H.armRpc(async () => {
      log(`    (hold) ${what} switch at the payment's first chain read`);
      to();
    });
    const n = toasts.length;
    await clickPage("#fdFund");
    await waitToast(n, /context_changed/, `${what} switch cancelled the payment`);
    await settled();
    await sleep(1500);
    check(hit(await status(), EXEC) === hit(s0, EXEC), `${what}: no execute POST`);
    check((await execEntries()).length === n0, `${what}: no execution admitted (the guarded store refused the new entry)`);
    check(await sessionBal(sid) === bal0, `${what}: no debit`);
  }
  await fresh();
  advance("execDone", "account and chain switches cannot dispatch a payment");
});
phase("pControls", "10. Intake OFF, then config/catalog unavailable: owner controls still render; page Terminate works", "execDone", async () => {
  const st = H.load();
  const j = await planOf(st);
  const metal = j.steps["gasOpen:metal"].review;
  const term = `#fdControls [data-term="${metal.recordId}"]`;
  try {
    await call("/test/fixture/intake", { off: true });
    await fresh();
    check(text("#fdGas").includes("New gas funding is paused"), "intake off: new gas funding paused");
    check(q(term) && !q(term).disabled, "intake off: owner Terminate still enabled");
    H.configUnavailable = true;
    await fresh();
    check(text("#fdMig").includes("Unavailable right now") && text("#fdGas").includes("Not available here"), "config/catalog unavailable: migration and gas unavailable");
    check(q("#fdControls [data-end]") && q(term) && !q(term).disabled, "controls still list this browser's grants with enabled buttons");
    const s0 = await status();
    const n = toasts.length;
    await clickPage(term);
    await waitToast(n, /Terminate sent/, "terminate sent");
    const s1 = await status();
    check(
      s1.prompts.length - s0.prompts.length === 1 && s1.prompts.at(-1).primaryType === "Terminate" && lower2(s1.prompts.at(-1).verifyingContract) === lower2(fx.vault),
      "one owner prompt: Terminate on the successor vault"
    );
    check(s1.hits["POST /v1/sessions/funding/owner"] - (s0.hits["POST /v1/sessions/funding/owner"] ?? 0) === 1, "one /funding/owner POST");
    check(s1.intakeOffReplies > 0, "the relay config really answered intake-off during this phase");
    await waitFor(async () => !(await call(`/test/fixture/gas-session/${metal.sid}`)).live, "the metal grant to end on chain", 6e4);
    log("    ok  metal grant ended on chain");
  } finally {
    H.configUnavailable = false;
    await call("/test/fixture/intake", { off: false });
  }
  advance("controls", "owner controls independent of intake and config");
});
phase("pNull", "11. Null runtime (reloads): zero signing offered", "controls", async () => {
  H.save({ ...H.load(), nullRuntime: true, nullBase: await status() });
  advance("nullRuntime", "runtime set to null for the next load", true);
});
phase("pNullCheck", "11b. Check the null-runtime page: nothing to sign or send", "nullRuntime", async () => {
  const st = H.load();
  await fresh();
  await sleep(3e3);
  check(
    text("#fdControls").includes("not set up") && text("#fdMig").includes("no deployed successor") && text("#fdGas").includes("Not available"),
    "page: not set up / not available"
  );
  check(document.querySelectorAll("#fdBody button:not([disabled])").length === 0, "no enabled button anywhere on the page");
  const s = await status();
  check(s.prompts.length === st.nullBase.prompts.length && JSON.stringify(posts(s)) === JSON.stringify(posts(st.nullBase)), "no prompt, no POST");
  advance("done", "ALL PHASES PASS (TEST fixture only)");
});
phase("pCleanup", "Delete this run's TEST databases", "*", async () => {
  const st = H.load();
  if (st?.legacyDb) {
    for (const n of [H.dbName("legacy"), H.dbName("v2", [F2.V2_DB, F2.LEGACY_DB])]) {
      await new Promise((ok, bad) => {
        const r = indexedDB.deleteDatabase(n);
        r.onsuccess = ok;
        r.onerror = () => bad(r.error);
        r.onblocked = ok;
      });
      log(`deleted ${n}`);
    }
  }
  localStorage.removeItem(WALLET_SESSION_KEY);
  sessionStorage.clear();
  setStatus("PASS", "this run's TEST databases deleted; reload for a fresh run");
});
var panel = $2("hbuttons");
for (const p of PHASES) {
  const b = document.createElement("button");
  b.id = p.id;
  b.type = "button";
  b.textContent = p.label;
  b.disabled = true;
  b.addEventListener("click", async () => {
    if (busy2) return;
    busy2 = true;
    refresh();
    logEl.textContent = "";
    stagesEl.textContent = "";
    setStatus("RUNNING", p.label);
    try {
      await p.fn();
    } catch (e) {
      log(`FAIL ${e?.code ? `${e.code}: ` : ""}${e?.message ?? e}`);
      setStatus("FAIL", e?.message ?? String(e));
      H.save({ ...H.load() || {}, last: { result: "FAIL", msg: e?.message } });
    } finally {
      busy2 = false;
      refresh();
    }
  });
  panel.appendChild(b);
  panel.appendChild(document.createElement("br"));
}
try {
  fx = await call("/test/fixture/config");
  const st = H.load();
  H.setPageConfig({ runtime: st?.nullRuntime ? null : fx.pins, proposal: st?.oldSid ? proposalOf(fx, st.oldSid) : null, approval: st?.approval ?? null });
  if (st?.connected) Object.assign(Enclave, { address: fx.owner, chainId: 8453, provider: fixtureProvider, base: `${origin}/v1` });
  const page = await Promise.resolve().then(() => (init_funding(), funding_exports));
  page.boot();
  refresh();
  setStatus(st?.last?.result ?? "IDLE", st?.last?.msg ?? "click TEST Start");
} catch (e) {
  setStatus("FAIL", `boot: ${e?.message ?? e}`);
}
