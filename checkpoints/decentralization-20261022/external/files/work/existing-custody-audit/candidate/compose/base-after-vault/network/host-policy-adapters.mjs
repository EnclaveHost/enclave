// Enforcement adapters for the platform host policy gate (network/platform-host-policy.mjs createPlatformHostGate).
// Each enforcement point gets a narrow function with ONE failure rule: anything but an explicit admit refuses. A refresh
// is attempted when this node is behind the book's anchor, then the decision is re-made once. Nothing here caches an
// admit longer than `ttlMs` (default 30 s): a new ban reaches hot paths within that bound plus the admin's anchor write.
// These are service refusals. The deployed ledger has no per-host admin ban: a banned host can still claim leases on
// chain; it gets no relay route/attach, no custody secrets, no discovery listing, no management traffic, and a measured
// guest on it stops serving.
import { keccak256, toBytes } from "viem";
const lc = (s) => String(s).toLowerCase();
async function decided(gate, fn) {
  let r = await fn();
  const behind = Object.values(r.decisions || r).some((d) => d && d.status === "behind");
  if (behind && typeof gate.refresh === "function") { try { await gate.refresh(); } catch {} r = await fn(); }
  return r;
}
function cache(ttlMs, now) {
  const m = new Map();
  return { get: (k) => { const v = m.get(k); return v && v.until > now() ? v.d : null; },
           put: (k, d) => { if (d.admit === true) m.set(k, { d, until: now() + ttlMs }); else m.delete(k); if (m.size > 4096) m.delete(m.keys().next().value); } };
}
/** route-record.mjs verifyRoute hostAdmission: the lease runner (a registry id) */
export const leaseHostAdmission = (gate) => async (lease) => {
  const id = lc(lease?.runner || "");
  if (!/^0x[0-9a-f]{64}$/.test(id)) return { admit: false, reason: "lease has no runner host" };
  const r = await decided(gate, () => gate.decide({ registryIds: [id] }));
  const d = r.decisions[id];
  if (d?.admit && lease.runnerOperator && d.host?.operator !== lc(lease.runnerOperator)) return { admit: false, reason: "lease operator differs from the host's registry operator at the policy block" };
  return d || { admit: false, reason: "no decision" };
};
/** service-index.mjs applyHostPolicy decide(operators) */
export const operatorDecider = (gate) => async (operators) => (await decided(gate, () => gate.decideOperators(operators)));
/**
 * Host-id decisions for hot paths (relay listing/dial, tunnel attach, management client, CLI/browser host choice):
 * admits(registryIds) -> { [id]: decision }, cached admits for ttlMs, refusals never cached.
 */
export function hostAdmissions(gate, { ttlMs = 30_000, now = () => Date.now() } = {}) {
  const c = cache(ttlMs, now);
  // a cached admit is bound to the policy digest it was judged under: once this node accepts a newer anchored policy
  // (a refresh by any path - the hot-ban sweep, a periodic refresh, another caller), every earlier admit is void
  const digest = () => (typeof gate.accepted === "function" && gate.accepted()?.digest) || "none";
  return async (registryIds) => {
    const ids = [...new Set(registryIds.map(lc))], out = {}, ask = [];
    for (const id of ids) { const d = c.get(`${digest()}:${id}`); if (d) out[id] = d; else ask.push(id); }
    if (ask.length) {
      const r = await decided(gate, () => gate.decide({ registryIds: ask }));
      for (const id of ask) { const d = r.decisions[id] || { admit: false, reason: "no decision" }; c.put(`${digest()}:${id}`, d); out[id] = d; }
    }
    return out;
  };
}
/**
 * The MEASURED host gate: a guest, supervisor or Windows host checks its OWN host id at agreed blocks.
 *   serving:true   only after an authenticated admit (the anchored policy admits this host at a fresh block), and then
 *                  through TRANSIENT loss (RPC/mirror failure, node behind the anchor) for at most graceMs after it;
 *   serving:false  on any explicit refusal (ban, allowlist miss, inactive/deregistered host). An explicit refusal is
 *                  STICKY: it erases the earlier admission, so later undecided/unreadable checks can never resurrect
 *                  service through the old grace. Only a NEW authenticated admit (e.g. the admin's unban) resumes.
 * onChange(state, previous) fires on every serving/banned transition (hosts stop new work and service at once).
 * persist { load() -> string|null, save(string) } keeps { lastAdmit, knownRefusal } across restarts: a host restarted
 * during an outage keeps its bounded grace from the last authenticated admit, and a KNOWN refusal survives the restart.
 */
export function measuredHostGate({ gate, hostId, graceMs = 15 * 60_000, now = () => Date.now(), log = () => {}, onChange = null, persist = null }) {
  if (!/^0x[0-9a-f]{64}$/.test(lc(hostId))) throw Error("measured host gate: this host's registry id is required");
  let lastAdmit = 0, knownRefusal = null, state = { serving: false, reason: "not yet checked", status: "unchecked" };
  if (persist) {
    try {
      const p = JSON.parse(persist.load() || "null");
      if (p && p.hostId === lc(hostId)) {
        if (p.knownRefusal && typeof p.knownRefusal.status === "string") knownRefusal = p.knownRefusal;
        else if (Number.isSafeInteger(p.lastAdmit) && p.lastAdmit <= now()) lastAdmit = p.lastAdmit;
      }
    } catch { /* unreadable state: start unchecked (never admitted) */ }
  }
  const save = () => { if (persist) { try { persist.save(JSON.stringify({ hostId: lc(hostId), lastAdmit, knownRefusal })); } catch {} } };
  const EXPLICIT = ["current", "stale-grace", "stale", "inactive"];
  const graceServing = () => knownRefusal === null && lastAdmit > 0 && now() - lastAdmit < graceMs;
  async function check() {
    const previous = state;
    try {
      const r = await decided(gate, () => gate.decide({ registryIds: [lc(hostId)] }));
      const d = r.decisions[lc(hostId)];
      if (d?.admit === true) { lastAdmit = now(); knownRefusal = null; save(); state = { serving: true, reason: d.reason, status: d.status }; }
      else if (EXPLICIT.includes(d?.status)) {
        lastAdmit = 0; knownRefusal = { status: d.status, reason: d.reason, at: now() }; save();
        state = { serving: false, banned: d.status !== "inactive", reason: d.reason, status: d.status };
      } else state = knownRefusal ? { serving: false, banned: knownRefusal.status !== "inactive", reason: `${knownRefusal.reason} (still refused: ${d?.reason || "undecided"})`, status: "refused-undecided" }
                                  : { serving: graceServing(), reason: d?.reason || "undecided", status: d?.status || "undecided" };
    } catch (e) {
      state = knownRefusal ? { serving: false, banned: knownRefusal.status !== "inactive", reason: `${knownRefusal.reason} (still refused: policy unreadable)`, status: "refused-unreadable" }
                           : { serving: graceServing(), reason: `policy unreadable: ${e.message}`, status: "unreadable" };
    }
    if (!state.serving) log(`[host-policy] this host is not serving: ${state.reason}`);
    if (onChange && (previous.serving !== state.serving || !!previous.banned !== !!state.banned)) { try { onChange(state, previous); } catch {} }
    return state;
  }
  return { check, state: () => state };
}

/**
 * Endpoint-keyed admissions for code that knows hosts by their registered endpoint (relay/fleet.mjs, the DNS relay):
 * admissions(registryIds) -> (endpoints) -> { [endpoint without trailing slash]: decision }. The registry id is
 * keccak256(endpoint), the same id the registry and the policy use.
 */
export const endpointAdmissions = (admissions) => async (endpoints) => {
  const eps = [...new Set(endpoints.map((e) => String(e || "").replace(/\/+$/, "")).filter(Boolean))];
  const idOf = new Map(eps.map((e) => [e, keccak256(toBytes(e)).toLowerCase()]));
  const d = eps.length ? await admissions([...idOf.values()]) : {};
  return Object.fromEntries(eps.map((e) => [e, d[idOf.get(e)] || { admit: false, reason: "no decision" }]));
};

/** Uncached decisions (the hot-ban sweep of attached tunnels; any re-check that must see a new ban at once):
 *  freshAdmissions(gate)(registryIds) -> { [id]: decision }, refreshing once when this node is behind the anchor. */
export const freshAdmissions = (gate) => async (registryIds) => {
  const ids = [...new Set(registryIds.map(lc))];
  return (await decided(gate, () => gate.decide({ registryIds: ids }))).decisions;
};
