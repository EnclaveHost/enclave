/* ============================================================
   The Enclave administrator's PLATFORM HOST POLICY in the
   independent dashboard: the platform-wide host ban (and optional
   exclusive admission) that the Nan relay used to enforce, without
   any server. The format, the EIP-712/ERC-1271 signature check, the
   two-key AddressBook anchor, the policy loader (rollback and
   equivocation refusal) and the judgement are the FROZEN shared core
   (network/platform-host-policy.mjs, network/host-policy-mirrors.mjs;
   work/platform-host-policy-interface.txt), bundled unmodified in
   /vendor/host-policy.js. The node-runtime adapters are not used
   here (the interface says so); this file applies the same rule with
   what a page has: its quorum reader and bounded fetches.

   EVERY DECISION IS SAME-BLOCK (core v2). At ONE majority-agreed
   block no older than MAX_SNAPSHOT_AGE_SEC: the selected AddressBook's
   anchor (hostPolicyDigestHi/Lo), its CURRENT owner(), whether that
   owner is a contract and its ERC-1271 answer for the accepted policy
   (readPolicyFacts check1271 = gate.currentAuthorityChecks()), its
   registry, and each host's registry operator/active and ACCEPTED
   owner on the host-ownership extension. The core's decideHost then
   admits only while the current owner signs the anchored policy at
   that block: an owner rotation or a withdrawn ERC-1271 approval
   refuses (status "authority") from the first block it is visible
   at; the current owner re-signing the SAME document (same digest,
   no anchor write) restores admission after one refresh.

   ADMISSION, NOT LIVENESS: a host is offered, priced, selected or
   managed only on an explicit admit. An unavailable, torn, withheld,
   unverifiable or stale policy admits nobody - no client grace
   (positive grace belongs to a host's own measured gate, not to a
   reader). An explicit refusal seen in this tab - a ban, an
   allowlist miss, an inactive host, a CONFIRMED authority failure -
   is kept and block-monotonic: an admit judged at an OLDER block
   never lifts it (a slow older read cannot resurrect a host), and an
   RPC or mirror failure never does; only an admit at a newer block
   does (an anchored unban, a re-activation, a valid re-signature).

   WHEN IT APPLIES (the runtime activation rule of
   network/platform-host-policy-config.mjs, mirrored here; the site
   does not import it):
     production  the profile is on the Enclave platform network (its
                 AddressBook, or for a fixed profile its registry, is
                 the platform's): ON by default with the production
                 host-ownership extension and mirrors, plus any the
                 profile adds - no profile field needed, no bypass
     profile     profile.hostPolicy = { book, hostOwnership, mirrors,
                 activation? } (another platform, or a test network)
     off         another network that configures none
   ACTIVATION: "anchor" (default) - while the book anchors no policy
   (both keys zero at an agreed block) enforcement is NOT ACTIVATED
   and hosts are admitted as today; the admin's anchor activates it.
   "required" - unanchored refuses. A torn anchor always refuses.
   ============================================================ */
import { INDEPENDENT } from "./config.js";
import { keccak256Utf8 } from "./keccak.js";

/* the Enclave platform network: its AddressBook (config.js hosted default) and registry (production contract pins) */
export const PLATFORM_BOOK = "0xab214342d5a490150a4a977063a2f88e21f80907";
export const PLATFORM_REGISTRY = "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac";
/* network/platform-host-policy-config.mjs PRODUCTION_HOST_OWNERSHIP / PRODUCTION_MIRRORS (pinned equal by
   test/site-host-policy.test.mjs). The mirrors are empty until root publishes them: with none, an ANCHORED policy
   cannot be loaded and every host is refused - mirrors ship in a release BEFORE the admin anchors. */
export const PLATFORM_HOST_OWNERSHIP = "0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7";
export const PLATFORM_MIRRORS = Object.freeze([]);
export const LIMITS = Object.freeze({ MAX_SNAPSHOT_AGE_SEC: 120, MIRROR_TIMEOUT_MS: 4000, REFRESH_BUDGET_MS: 12000, DECIDE_BUDGET_MS: 20000,
  MAX_HOSTS: 64, MAX_POLICY_BYTES: 256 * 1024 });
let L = LIMITS;

const lc = (s) => String(s || "").toLowerCase();
let _vendor = null, _fetch = null, _rt = null, _store, _profile, _delay = null;
const vendor = () => (_vendor ||= import("/vendor/host-policy.js").catch((e) => { _vendor = null; throw e; }));
/* tests: the bundle as a module object, a fetch, a store (null: none), limits, a profile, a read delay; a fresh tab */
export function _setForTests({ vendorModule, fetchImpl, store, limits, profile, delay } = {}){
  if (vendorModule) _vendor = Promise.resolve(vendorModule);
  if (fetchImpl) _fetch = fetchImpl;
  _store = store; _profile = profile; _delay = delay || null;
  L = Object.freeze({ ...LIMITS, ...(limits || {}) });
  _rt = null; state.clear(); maxSequence = 0;
}

export function hostPolicyMode(profile = _profile !== undefined ? _profile : INDEPENDENT.state === "on" ? INDEPENDENT.profile : null){
  if (!profile) return { mode: "off", reason: "independent mode is off: the hosted relay applies the platform host policy" };
  const platform = lc(profile.addressBook) === PLATFORM_BOOK || (!profile.addressBook && lc(profile.contracts && profile.contracts.registry) === PLATFORM_REGISTRY);
  const hp = profile.hostPolicy;
  if (hp) return { mode: "enforce", source: "profile", book: hp.book, hostOwnership: hp.hostOwnership,
    mirrors: [...new Set([...(platform ? PLATFORM_MIRRORS : []), ...hp.mirrors])], activation: hp.activation || "anchor" };
  if (platform) return { mode: "enforce", source: "production default", book: PLATFORM_BOOK, hostOwnership: PLATFORM_HOST_OWNERSHIP,
    mirrors: [...PLATFORM_MIRRORS], activation: "anchor" };
  return { mode: "off", reason: "this network profile configures no platform host policy" };
}

/* a mirror fetch: no credentials, no redirects, a deadline, at most MAX_POLICY_BYTES */
function boundedFetch(deadline){
  return async (url, init = {}) => {
    const left = deadline() - Date.now();
    if (left <= 0) throw new Error("the policy fetch budget ran out");
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), Math.min(left, L.MIRROR_TIMEOUT_MS));
    const onAbort = () => ctl.abort();
    if (init.signal) init.signal.addEventListener("abort", onAbort);
    try {
      const r = await (_fetch || globalThis.fetch)(url, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", mode: "cors",
        headers: { accept: "application/json" }, signal: ctl.signal });
      if (!r.ok) return new Response("", { status: r.status });
      const len = Number(r.headers && r.headers.get && r.headers.get("content-length"));
      if (Number.isFinite(len) && len > L.MAX_POLICY_BYTES) return new Response("", { status: 413 });
      const text = await r.text();
      return new Response(new TextEncoder().encode(text).length > L.MAX_POLICY_BYTES ? "" : text, { status: text ? 200 : 413 });
    } finally { clearTimeout(t); if (init.signal) init.signal.removeEventListener("abort", onAbort); }
  };
}
/* the accepted {document, signature, digest, sequence} survives reloads (the loader's rollback floor); it is re-verified */
function localStore(book){
  if (_store !== undefined) return _store;
  const k = "enclave_host_policy:" + book;
  try { const ls = globalThis.localStorage; if (!ls) return null; return { load: () => ls.getItem(k), save: (v) => ls.setItem(k, v) }; } catch { return null; }
}

/* the shared core's call(address, abi, fn, args) / code(address), bound to ONE agreed snapshot of the page's reader */
function at(V, reader, snap){
  const delay = _delay ? () => _delay(snap) : () => null;
  return { block: snap.number,
    call: async (address, abi, functionName, args = []) => { await delay(); return V.decodeFunctionResult({ abi, functionName,
      data: await reader.call(snap, address, V.encodeFunctionData({ abi, functionName, args })) }); },
    code: async (address) => { await delay(); return reader.code(snap, address); } };
}
function fresh(snap){
  const age = Math.floor(Date.now() / 1000) - Number(snap.timestamp);
  if (!(age <= L.MAX_SNAPSHOT_AGE_SEC)) throw Object.assign(new Error("the agreed block is " + age + " s old; the platform host policy needs a block at most " + L.MAX_SNAPSHOT_AGE_SEC + " s old"), { code: "stale_block" });
  return snap;
}

async function runtime(reader){
  const m = hostPolicyMode();
  const key = [m.book, m.hostOwnership, ...m.mirrors].join("|");
  if (_rt && _rt.key === key) return _rt;
  const V = await vendor();
  let deadline = Date.now() + L.REFRESH_BUDGET_MS, inflight = null;
  // the loader's own reads use fresh agreed snapshots; whatever it accepts is re-verified at each decision's block below
  const snapshot = async (fn) => fn(at(V, reader, fresh(await reader.snapshot())));
  const gate = V.createPlatformHostGate({ book: m.book, hostOwnership: m.hostOwnership, snapshot, store: localStore(m.book), allowUnanchored: false,
    mirrors: m.mirrors.length ? V.httpPolicyMirrors(m.mirrors, { fetch: boundedFetch(() => deadline), timeoutMs: L.MIRROR_TIMEOUT_MS }) : [] });
  // one refresh at a time (concurrent panels share it)
  const refresh = () => (inflight ||= (async () => { deadline = Date.now() + L.REFRESH_BUDGET_MS; try { return await gate.refresh(); } finally { inflight = null; } })());
  return (_rt = { key, mode: m, V, gate, refresh });
}

/**
 * The decision core: at `snap`, for registry ids `ids`. -> { block, sequence, digest, notActivated, byId: Map(id -> decision) };
 * throws (code torn_anchor, bad_anchor, unanchored, anchor_unavailable, authority, rollback, equivocation, stale_block,
 * wrong_registry, ...) when NO host can be admitted at that block.
 */
async function decideAt(reader, snap, ids, { registry = null } = {}){
  const m = hostPolicyMode(), rt = await runtime(reader), V = rt.V, a = at(V, reader, fresh(snap)), use = ids.slice(0, L.MAX_HOSTS);
  // ONE block: anchor, current owner (+ ERC-1271 answers for the accepted policy), registry, host rows
  const read = () => V.readPolicyFacts(a, { book: m.book, hostOwnership: m.hostOwnership, registryIds: use, check1271: rt.gate.currentAuthorityChecks() });
  let facts = await read();
  if (registry && facts.registry !== lc(registry))
    throw Object.assign(new Error("at block " + snap.number + " the address book names registry " + facts.registry + ", not the registry these hosts were read from"), { code: "wrong_registry" });
  const anchor = V.decodeAnchor(facts.anchorHi, facts.anchorLo);
  if (anchor.state !== "anchored"){
    if (m.activation === "required") throw Object.assign(new Error("at block " + snap.number + " the address book anchors no policy"), { code: "unanchored" });
    // not activated: the admin has not anchored a policy; today's behaviour, reported as such
    const d = { admit: true, status: "not-activated", reason: "the platform host policy is not activated (the address book anchors none)" };
    return { block: Number(snap.number), sequence: null, digest: null, notActivated: true, byId: new Map(ids.map((id) => [id, { ...d, host: facts.hosts[id] || null }])) };
  }
  const judge = () => new Map(ids.map((id) => {
    const h = facts.hosts[id];
    const d = !h ? { admit: false, status: "unchecked", reason: "more than " + L.MAX_HOSTS + " hosts: not judged in this read" }
      : !h.active ? { admit: false, status: "inactive", reason: "host registry entry is not active" }
      : rt.gate.decideHost(h, facts);
    return [id, { admit: d.admit === true, status: d.status, reason: d.reason || null, host: h || null }];
  }));
  // the gate holds another (or no) policy, or the current owner no longer signs the one it holds: load / re-validate once
  // (refresh accepts a re-signature of the SAME document, or throws authority / anchor_unavailable / rollback ...)
  let byId = (rt.gate.accepted() || {}).digest === anchor.digest ? judge() : null;
  if (!byId || [...byId.values()].some((d) => d.status === "authority" || d.status === "behind")){
    await rt.refresh();
    facts = await read();
    if (V.decodeAnchor(facts.anchorHi, facts.anchorLo).digest !== anchor.digest || (rt.gate.accepted() || {}).digest !== anchor.digest)
      throw Object.assign(new Error("the policy the book anchors at block " + snap.number + " could not be loaded"), { code: "anchor_unavailable" });
    byId = judge();
  }
  const acc = rt.gate.accepted();
  return { block: Number(snap.number), sequence: acc.policy.sequence, digest: acc.digest, notActivated: false, byId };
}

/* ---- block-monotonic, sticky refusals (this tab) ---- */
// explicit refusals CONFIRMED at a block (a ban, an allowlist miss, an inactive host, a confirmed authority failure: core v3
// "authority"); undecided states - core v3 "authority-unread", "behind", "anchor", RPC/mirror errors - are never in this list
const EXPLICIT = Object.freeze(["current", "stale-grace", "stale", "inactive", "authority"]);
export const STICKY_STATUSES = EXPLICIT;
const state = new Map();            // id -> { refusal: { reason, block, sequence } | null, admitBlock }
let maxSequence = 0;
function apply(id, d, block, sequence){
  const s = state.get(id) || { refusal: null, admitBlock: -1 };
  if (Number.isFinite(sequence) && sequence < maxSequence && d.admit)
    d = { admit: false, status: "superseded", reason: "judged under policy #" + sequence + ", but this browser has already seen #" + maxSequence };
  if (Number.isFinite(sequence)) maxSequence = Math.max(maxSequence, sequence);
  if (d.admit === true){
    if (s.refusal && !(block > s.refusal.block))
      return { admit: false, status: "refused-newer", reason: s.refusal.reason + " (refused at block " + s.refusal.block + "; an admit judged at block " + block + " does not lift it)" };
    state.set(id, { refusal: null, admitBlock: Math.max(s.admitBlock, block) });
    return d;
  }
  if (EXPLICIT.includes(d.status)){
    if (!s.refusal || block >= s.refusal.block) state.set(id, { refusal: { reason: d.reason, block, sequence }, admitBlock: s.admitBlock });
    return d;
  }
  return s.refusal ? { ...d, admit: false, reason: s.refusal.reason + " (still refused: " + (d.reason || d.status) + ")", sticky: true } : d;
}

const plain = (e) => {
  const c = e && e.code, msg = String(e && e.message || e).slice(0, 240);
  const what = { unanchored: "no policy is anchored in the platform address book", torn_anchor: "the address book's policy anchor is torn (half written)",
    bad_anchor: "the address book's policy anchor is malformed", anchor_unavailable: "the anchored policy is not available from any mirror, or does not verify against the current owner",
    authority: "the anchored policy is not signed by the address book's current owner at this block (owner rotated or ERC-1271 approval withdrawn): it must be re-signed",
    rollback: "the address book anchors an older policy than this browser already accepted", equivocation: "two different policies share one sequence",
    stale_block: "the chain endpoints only agree on an old block", wrong_registry: "the address book names another registry" }[c];
  return "platform host policy unavailable: " + (what ? what + " (" + msg + ")" : msg);
};
function withBudget(p, ms, what){
  let t; return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(Object.assign(new Error(what + " took longer than " + ms / 1000 + " s"), { code: "timeout" })), ms); })])
    .finally(() => clearTimeout(t));
}
/**
 * Decisions for the rows of ONE registry read `reg` = { snap, hosts, registry } (js/core/independent-chain.js registryHosts),
 * judged at THAT block. -> { mode, source, block, sequence, digest, notActivated, unavailable, byId: Map(registryId -> decision) }
 * (mode off: byId null)
 */
export async function policyDecisions(reader, reg, { ids = null } = {}){
  const m = hostPolicyMode();
  if (m.mode === "off") return { mode: "off", byId: null, reason: m.reason };
  const all = [...new Set((ids || reg.hosts.filter((h) => h.active === true).map((h) => keccak256Utf8(h.endpoint))).map(lc))];
  const refuseAll = (reason, block = -1, status = "unavailable") => ({ mode: m.mode, source: m.source, unavailable: reason, block: block >= 0 ? block : null,
    byId: new Map(all.map((id) => [id, apply(id, { admit: false, status, reason }, block, NaN)])) });
  try {
    const r = await withBudget(decideAt(reader, reg.snap, all, { registry: reg.registry }), L.DECIDE_BUDGET_MS, "reading the platform host policy");
    const byId = new Map([...r.byId].map(([id, d]) => [id, apply(id, d, r.block, r.sequence)]));
    // a confirmed authority failure refuses every host: say so once for the panel
    const auth = [...r.byId.values()].find((d) => d.status === "authority");
    return { mode: "enforce", source: m.source, block: r.block, sequence: r.sequence, digest: r.digest, notActivated: r.notActivated,
      unavailable: auth ? "platform host policy unavailable: " + auth.reason : null, byId };
  } catch (e){ return refuseAll(plain(e), Number(reg.snap && reg.snap.number), e && e.code === "authority" ? "authority" : "unavailable"); }
}

/* One host at a NEW agreed block (an action: pin it, deploy to it, manage it). -> decision (never throws) */
async function decideOne(reader, id, { lease = null } = {}){
  const m = hostPolicyMode();
  if (m.mode === "off") return { admit: true, status: "off", reason: null };
  let snap;
  try {
    snap = await reader.snapshot();
    const r = await withBudget(decideAt(reader, snap, [id]), L.DECIDE_BUDGET_MS, "reading the platform host policy");
    let d = r.byId.get(id);
    // a lease is managed through its runner: the lease's operator must be that host's registry operator at the policy block
    if (lease && d.admit && lease.runnerOperator && lc(d.host && d.host.operator) !== lc(lease.runnerOperator))
      d = { admit: false, status: "operator-mismatch", reason: "the lease's operator differs from the host's registry operator at block " + r.block };
    return apply(id, d, r.block, r.sequence);
  } catch (e){ return apply(id, { admit: false, status: e && e.code === "authority" ? "authority" : "unavailable", reason: plain(e) }, snap ? Number(snap.number) : -1, NaN); }
}
/* An ACTION on a host: throws with the reason unless admitted at a fresh agreed block. */
export async function assertHostAdmitted(reader, registryId){
  const d = await decideOne(reader, lc(registryId));
  if (d.admit !== true) throw Object.assign(new Error("the platform host policy refuses this host: " + (d.reason || d.status)), { policy: d });
  return d;
}
/* Managing / connecting to a lease's runner. -> decision */
export async function leaseAdmission(reader, lease){
  const id = lc(lease && lease.runner);
  if (!/^0x[0-9a-f]{64}$/.test(id)) return { admit: false, status: "no-runner", reason: "the lease has no runner host" };
  return decideOne(reader, id, { lease });
}

/* one line for a panel */
export function policyNote(p){
  if (!p || p.mode === "off") return "";
  if (p.unavailable) return p.unavailable.charAt(0).toUpperCase() + p.unavailable.slice(1) + ". No host can be selected or managed until it is.";
  if (p.notActivated) return "The platform host policy is not activated yet (the address book anchors none); hosts are admitted as before.";
  return "Platform host policy #" + p.sequence + " (anchored in the address book at block " + p.block + ").";
}
