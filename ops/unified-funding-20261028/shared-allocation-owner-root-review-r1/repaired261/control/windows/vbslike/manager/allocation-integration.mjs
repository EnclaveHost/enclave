/* ============================================================
   Shared allocation r1: IN-PLACE integration with a running Manager (SOURCE ONLY - authored, not run).

   It keeps the SAME Manager, epoch, domains Map and every record/handle, judging promises, relay pipes, data-plane
   sessions, journal owners and stop/survey/teardown methods. Nothing here stops, recovers, pauses, reclaims or closes
   anything. It only:
     1. captures the baseline (every existing record, including already-entered starts) and, in the SAME synchronous
        segment, interposes the backend's actual dispatch (backend.interposeAllocation: this.launch, which the
        constructor bound to the original launcher, and this instance's stop) and installs the gate on every WMI
        launcher's final define (New-CustomVM) and start (Start-VM) boundaries;
     2. registers that baseline with the shared owner. Until registration completes, and while the owner reports any
        coverage gap, NEW admissions are refused; existing serving domains, readers and explicit Stop are untouched;
     3. per new launch: acquire the shared reservation, re-check the exact local record/epoch after that await, pass the
        token to the ORIGINAL launch, enter each WMI boundary through the owner, and settle only on exact evidence
        (launch result, exact cleanup/stop removal by VM Id, a successful identity survey); otherwise the reservation is
        retained as uncertain. Every settlement that cannot be delivered is retried by reconcile(), never dropped.
   Direct POST /vms (8091/8095), ProtectedManager.spawnProtectedInternal and the native wrapper all reach
   Manager.spawn -> backend.start -> backend.launch, i.e. this path; a launcher used directly meets the WMI gate.
   Configured but unavailable owner = closed admission. There is no fallback to unowned admission.
   ============================================================ */
import { type1VmMemMiB, parseNotes } from "./wmi-launcher.mjs";
import { desktopVmMemMiB } from "./desktop-memory.mjs";
import { DESKTOP_DERIVATION } from "./desktop-derive.mjs";
import { MAX_ACTIVE } from "./allocation-owner.mjs";

const refused = (msg, status = 503) => Object.assign(new Error(msg), { status, code: "allocation_refused" });
const lc = (s) => String(s ?? "").toLowerCase();

/** Every existing record, as the owner's baseline. Unknown physical size stays null (the owner then holds admissions). */
export function baselineOf(manager) {
  const out = [];
  for (const r of manager.domains.values()) {
    const known = !r.recovered && !r.unattributed;
    const p = known && Number.isSafeInteger(r.physicalMemoryMiB) && r.physicalMemoryMiB > 0 ? r.physicalMemoryMiB
      : known && Number.isSafeInteger(r.handle?.memory?.vmMiB) && r.handle.memory.vmMiB > 0 ? r.handle.memory.vmMiB : null;
    out.push({ id: String(r.id), name: r.name ?? null, vmInstanceId: r.instanceId ?? null, appId: r.appId ?? null,
      vmId: typeof r.handle?.vmId === "string" ? r.handle.vmId : null, physicalMiB: p, launching: r.launching === true, status: r.status ?? null });
  }
  return out;
}

/** The partition size the WMI launcher will define for this launch (the Manager's reservation when it made one). */
export function physicalFor(rec, mapping, opts = {}) {
  if (Number.isSafeInteger(rec.physicalMemoryMiB) && rec.physicalMemoryMiB > 0) return rec.physicalMemoryMiB;
  const app = opts.appMemoryMiB ?? mapping?.record?.policy?.memMiB;
  const native = mapping?.record?.derivation === DESKTOP_DERIVATION || mapping?.record?.desktop != null;
  return native ? desktopVmMemMiB(app) : type1VmMemMiB(app, { name: opts.identity?.name, appId: mapping?.appId });
}

/**
 * installSharedAllocation(manager, { client, role, wmiLaunchers, ttlMs, closedReason }) -> api
 *   client: AllocationClient (allocation-service.mjs) or null (configured but unavailable: admissions closed)
 *   wmiLaunchers: every WmiHyperVLauncher behind this manager's backend (each gets the boundary gate)
 */
export async function installSharedAllocation(manager, { client = null, role, wmiLaunchers = [], ttlMs = 600_000, closedReason = null } = {}) {
  const backend = manager?.backend;
  if (!backend || typeof backend.interposeAllocation !== "function") throw Error("shared allocation needs the manager's HyperVPartitionBackend");
  if (manager.sharedAllocation) throw Error("shared allocation is already installed on this manager");
  if (!["general", "native"].includes(role)) throw Error("shared allocation role must be general or native");
  if (wmiLaunchers.some((l) => typeof l?.installAllocationGate !== "function")) throw Error("every gated launcher must be a WmiHyperVLauncher");
  const st = {
    closed: !client ? (closedReason || "the shared allocation owner is configured but no client could be composed: new admissions are closed")
      : !wmiLaunchers.length ? "no WMI launcher boundary is gated: new admissions are closed" : null,
    registered: false, gaps: [], lastError: null,
    tokens: new Map(),          // instance id -> the live token of an in-progress launch
    live: new Map(),            // rid -> { token, rec, entered[], vmId, name, defineNotInvoked }
    held: new Map(),            // rid -> { id, vmId } unresolved reservations this manager knows about
    byVm: new Map(),            // lower-case VM Id -> rid
    baselineLaunching: new Set(),
    pending: [], inflight: new Set(),
  };

  function settle(rid, outcome, evidence, reason) {
    const p = client.observe({ rid, outcome, evidence, reason: String(reason ?? "").slice(0, 400) }).then(() => {
      if (outcome === "absent" || outcome === "never-entered") {
        const h = st.held.get(rid); st.held.delete(rid);
        if (h?.vmId) st.byVm.delete(lc(h.vmId));
      }
    }, (e) => { st.pending.push({ rid, outcome, evidence, reason }); st.lastError = e.message; });
    st.inflight.add(p); p.finally(() => st.inflight.delete(p));
    return p;
  }

  async function guardedLaunch(original, mapping, opts = {}) {
    const ident = opts.identity, id = ident?.id;
    if (st.closed) throw refused(`shared allocation closed: ${st.closed}`);
    if (!st.registered) throw refused(`coverage incomplete: this manager's baseline is not registered with the shared owner${st.lastError ? ` (${st.lastError})` : ""}`);
    const rec = id ? manager.domains.get(id) : null;
    if (!rec || rec.launching !== true || rec.name !== ident.name || rec.instanceId !== opts.instanceId) throw refused("launch does not match its exact manager record", 409);
    if (st.tokens.has(id)) throw refused("a shared reservation for this instance is already live", 409);
    let physicalMiB;
    try { physicalMiB = physicalFor(rec, mapping, opts); } catch (e) { throw refused(e.message, 400); }
    const request = Object.freeze({ id, name: ident.name, vmInstanceId: opts.instanceId, appId: mapping.appId });
    const epoch = manager.epoch;
    let grant;
    try { grant = await client.acquire({ kind: "vm", request, physicalMiB, ttlMs }); }
    catch (e) { st.lastError = e.message; throw refused(`shared allocation refused: ${e.message}`, e.status === 507 ? 507 : 503); }
    const token = Object.freeze({ rid: grant.rid, ownerIncarnation: grant.ownerIncarnation, request, physicalMiB });
    st.held.set(token.rid, { id, vmId: null });
    // AFTER THE AWAIT: the exact record, epoch and admission state must still hold before the token becomes usable
    if (manager.epoch !== epoch || manager.domains.get(id) !== rec || rec.launching !== true || st.closed || st.tokens.has(id)) {
      settle(token.rid, "never-entered", null, "local identity changed while the shared reservation was acquired");
      throw refused("local identity changed while the shared reservation was acquired", 409);
    }
    const live = { token, rec, entered: [], vmId: null, name: null, defineNotInvoked: false };
    st.tokens.set(id, token); st.live.set(token.rid, live);
    let h;
    try { h = await original(mapping, { ...opts, allocation: token }); }
    catch (e) { st.tokens.delete(id); st.live.delete(token.rid); settleFailure(live, e); throw e; }
    st.tokens.delete(id); st.live.delete(token.rid);
    settleSuccess(live, h);
    return h;
  }

  function settleSuccess(live, h) {
    const t = live.token;
    if (live.entered.includes("start") && typeof h?.vmId === "string" && lc(h.vmId) === lc(live.vmId) && h.state === "Running" && h.memory?.vmMiB === t.physicalMiB) {
      st.held.set(t.rid, { id: t.request.id, vmId: h.vmId }); st.byVm.set(lc(h.vmId), t.rid);
      return settle(t.rid, "reflected", { kind: "launch-returned", vmId: h.vmId, state: h.state, vmMiB: h.memory.vmMiB }, "launch returned Running at the reserved size");
    }
    if (typeof h?.vmId === "string") { st.held.set(t.rid, { id: t.request.id, vmId: h.vmId }); st.byVm.set(lc(h.vmId), t.rid); }
    return settle(t.rid, "uncertain", null, "the launch returned without exact reflection evidence at the reserved size");
  }

  function settleFailure(live, e) {
    const t = live.token;
    if (live.vmId) { st.held.set(t.rid, { id: t.request.id, vmId: live.vmId }); st.byVm.set(lc(live.vmId), t.rid); }
    if (!live.entered.length) return settle(t.rid, "never-entered", null, e.message);
    if (live.defineNotInvoked) return settle(t.rid, "absent", { kind: "define-not-invoked" }, e.message);
    const c = e.cleanup;
    if (c && c.found !== null && c.found !== undefined && (c.removed === true || c.found === false))
      return settle(t.rid, "absent", { kind: "cleanup-removed", vmId: live.vmId, name: live.name, found: c.found, removed: c.removed === true }, e.message);
    return settle(t.rid, "uncertain", null, `launch failed and its cleanup is not proven: ${e.message}`);
  }

  async function gate(stage, ctx) {
    const id = ctx.identity?.id;
    if (!ctx.allocation) {
      // an already-entered start, accounted in full in the baseline, continues; nothing else crosses without a token
      if (id && st.baselineLaunching.has(id) && manager.domains.get(id)?.launching === true) return;
      throw refused(`no shared reservation reached the WMI ${stage} boundary: refused before ${stage === "define" ? "New-CustomVM" : "Start-VM"}`, 409);
    }
    const t = st.tokens.get(id), live = t && st.live.get(t.rid);
    if (!t || t !== ctx.allocation || !live) throw refused("the token is not this manager's live reservation for this identity", 409);
    if (stage === "define" && ctx.memMiB !== t.physicalMiB) throw refused("partition memory differs from the reservation", 409);
    if (st.closed) { if (stage === "define") throw refused(`shared allocation closed: ${st.closed}`); }
    live.name = ctx.name;
    try { await client.enter({ rid: t.rid, boundary: stage, request: t.request, memMiB: ctx.memMiB, vmId: ctx.vmId ?? null }); }
    catch (e) {
      if (e.mayHaveExecuted) { live.entered.push(stage); if (stage === "define") live.defineNotInvoked = true; }
      throw refused(`shared allocation refused the ${stage} boundary: ${e.message}`, e.status === 507 ? 507 : 409);
    }
    live.entered.push(stage);
    if (stage === "start") live.vmId = ctx.vmId;
    // AFTER THE AWAIT: same token, same record, still launching
    if (st.tokens.get(id) !== t || manager.domains.get(id) !== live.rec || live.rec.launching !== true) {
      if (stage === "define") live.defineNotInvoked = true;
      throw refused(`local identity changed at the ${stage} boundary`, 409);
    }
  }

  function settleStop(handle, r) {
    if (!(r?.stopped === true && typeof r.vmId === "string" && handle?.vmId && lc(r.vmId) === lc(handle.vmId) && (r.removed === true || r.note === "already gone"))) return;
    const rid = st.byVm.get(lc(r.vmId));
    if (rid && client) settle(rid, "absent", { kind: "stop-confirmed", vmId: r.vmId, removed: r.removed === true, found: r.removed === true }, "stopped and removed by VM Id");
  }

  async function registerNow() {
    const baseline = baselineOf(manager);
    if (baseline.length > MAX_ACTIVE) { st.registered = false; st.lastError = "baseline exceeds the ledger bound"; return; }
    for (const b of baseline) if (b.launching) st.baselineLaunching.add(b.id);
    try {
      const r = await client.register({ epoch: manager.epoch, baseline });
      for (const b of r.baseline) {
        const vmId = baseline.find((x) => x.id === b.id)?.vmId ?? null;
        st.held.set(b.rid, { id: b.id, vmId, baseline: true });
        if (vmId) st.byVm.set(lc(vmId), b.rid);
      }
      st.gaps = r.coverageGaps; st.registered = true; st.lastError = null;
    } catch (e) { st.registered = false; st.lastError = e.message; }
  }

  /** Retry undelivered settlements, follow an owner restart, and settle baseline/uncertain records on exact evidence. */
  async function reconcile() {
    if (!client) return api.status();
    for (const p of st.pending.splice(0)) settle(p.rid, p.outcome, p.evidence, p.reason);
    await Promise.allSettled([...st.inflight]);
    let s = null;
    try { s = await client.status(); } catch (e) { st.lastError = e.message; }
    if (s && (s.ownerIncarnation !== client.ownerIncarnation || !st.registered)) await registerNow();
    if (s) st.gaps = s.coverageGaps || [];
    // baseline launches that have since completed: the exact launch result is the reflection evidence
    for (const [rid, h] of st.held) {
      if (!h.baseline || h.reflected) continue;
      const rec = manager.domains.get(h.id);
      if (rec && rec.launching !== true && typeof rec.handle?.vmId === "string" && rec.handle.state === "Running" && rec.status !== "failed" && Number.isSafeInteger(rec.handle.memory?.vmMiB)) {
        h.vmId = rec.handle.vmId; h.reflected = true; st.byVm.set(lc(h.vmId), rid);
        settle(rid, "reflected", { kind: "launch-returned", vmId: rec.handle.vmId, state: rec.handle.state, vmMiB: rec.handle.memory.vmMiB }, "baseline launch completed");
      }
    }
    // records no longer launching whose VM a successful survey does not show (and no unattributed VM exists)
    const candidates = [...st.held].filter(([, h]) => !h.reflected && !(manager.domains.get(h.id)?.launching === true) && !manager.domains.get(h.id)?.handle?.vmId);
    if (candidates.length && backend.canSurvey) {
      let inv = null;
      try { inv = await backend.survey(); } catch (e) { st.lastError = `survey failed (nothing settled): ${e.message}`; }
      if (inv && Array.isArray(inv.vms)) {
        const ids = new Set(), unattributed = inv.vms.filter((v) => { const p = parseNotes(v.notes); if (p.identity) ids.add(p.identity.id); return !p.identity; }).length;
        for (const [rid, h] of candidates)
          if (!ids.has(h.id) && unattributed === 0 && !(manager.domains.get(h.id)?.launching === true))
            settle(rid, "absent", { kind: "survey-absent", id: h.id, launchSettled: true, unattributed }, "absent from a successful survey after its launch settled");
      }
    }
    await Promise.allSettled([...st.inflight]);
    return api.status();
  }

  const api = Object.freeze({
    role,
    reconcile,
    settled: () => Promise.allSettled([...st.inflight]),
    /** a qualification hold consumes real capacity; it is released only by its holder's explicit end */
    holdQualification: async ({ request, physicalMiB, commitMiB, ttlMs: ttl = ttlMs }) => {
      if (st.closed || !st.registered) throw refused(`shared allocation unavailable: ${st.closed || "not registered"}`);
      const g = await client.acquire({ kind: "qualification", request, physicalMiB, commitMiB, ttlMs: ttl });
      st.held.set(g.rid, { id: request.id, vmId: null, qualification: true });
      return g;
    },
    endQualification: (grant, request) => settle(grant.rid, "absent", { kind: "qualification-ended", request }, "qualification ended by its holder"),
    status: () => ({ shared: true, role, registered: st.registered, closed: st.closed, ownerIncarnation: client?.ownerIncarnation ?? null,
      managerIncarnation: client?.managerIncarnation ?? null, held: st.held.size, pendingSettlements: st.pending.length, coverageGaps: st.gaps, lastError: st.lastError,
      gatedBoundaries: wmiLaunchers.length,
      scope: "VM partition physical+commit through the shared owner; request buffering, fetches, PowerShell, relay and kernel/worker work are owner-declared coverage terms, not measured",
      nativeQualified: false }),
  });

  // ONE synchronous segment: baseline capture, dispatch interposition, boundary gates, health. No start can slip between.
  for (const b of baselineOf(manager)) if (b.launching) st.baselineLaunching.add(b.id);
  backend.interposeAllocation({
    launch: (original) => (mapping, opts) => guardedLaunch(original, mapping, opts),
    stop: (originalStop) => async (handle) => { const r = await originalStop(handle); try { settleStop(handle, r); } catch { /* the stop result stands */ } return r; },
  });
  for (const l of wmiLaunchers) l.installAllocationGate(gate);
  const health = manager.health.bind(manager);
  manager.health = () => ({ ...health(), allocation: api.status() });
  Object.defineProperty(manager, "sharedAllocation", { value: api, enumerable: false, writable: false, configurable: false });
  if (client && !st.closed) await registerNow();
  return api;
}
