// protected-supervisor.mjs - the Windows node's PROTECTED per-app lifecycle (permit r4, SOURCE ONLY, NOT RUN).
//
// CONSUMED BY THE REAL HOST PATH: host.mjs #isolationReconcile -> isolation-lifecycle.mjs reconcile()/retire() ->
// protectedSupervisorFor(client) here. A deployment is enrolled ONLY by the host's pinned enrollment policy (absolute
// file + sha256, ENCLAVE_PROTECTED_ENROLLMENT[_SHA256]); there is no request field, envelope boolean or downgrade path.
// An enrolled deployment NEVER falls back to the legacy spawn: if the protected capability, the owned r18 runtime or the
// authority snapshot is unavailable, the answer is `held` with the reason (lease kept, nothing started).
// Unenrolled deployments, and every host without the policy, keep the legacy path byte-for-byte (null is returned).
//
// The lifecycle itself is R18 network/deployment-isolation-runtime.mjs (createIsolationLifecycleRuntime), driven with
// the adapters ProtectedIsolationClient.runtimeAdapters() returns: ensureStaged (fence, verified plan, fresh-queued
// host-authority handoff, ONE owned stage) and serve (owner-selected witness collection, the supervisor gate's install,
// then boundaries.allow carrying that exact envelope to the manager). The runtime, its gate and its owned lifecycle
// journal come from `openRuntime`, which is the owned r18 authority (openOwnedHostRegistryLifecycle) in production.
// permit r8: production sets composition.{hostId, openRuntime, collect} in protected-authority-factory.mjs, called by the node
// entry (agent.mjs) with the Host's verified enclaveId and the owner's pinned authority config. Without that config (or if the
// pinned r18 modules/owned locks are unavailable) every enrolled deployment is still held - never served, never downgraded.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ProtectedIsolationClient, ownedObligationStore, OBLIGATION_PURPOSE, isLive } from "./protected-isolation.mjs";

export const ENROLLMENT_SCHEMA = "enclave-protected-enrollment/1";
const H32 = /^0x[0-9a-f]{64}$/;
const exact = (o, keys) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/** The host's pinned enrollment policy: exact keys, this host, explicit deployments, the manager's control key file. */
export function loadEnrollment(file, sha256) {
  if (!path.isAbsolute(String(file)) || !/^[0-9a-f]{64}$/.test(String(sha256))) throw Error("protected enrollment must be an absolute file with its sha256");
  const bytes = fs.readFileSync(file);
  if (bytes.length > 65536 || createHash("sha256").update(bytes).digest("hex") !== sha256) throw Error("protected enrollment hash differs");
  const p = JSON.parse(bytes);
  if (!exact(p, ["schema", "host", "manager", "controlKeyFile", "deployments", "stagingMs"]) || p.schema !== ENROLLMENT_SCHEMA) throw Error("protected enrollment has unknown or missing fields");
  if (!H32.test(p.host) || !Array.isArray(p.deployments) || p.deployments.some((d) => !H32.test(d)) || new Set(p.deployments).size !== p.deployments.length)
    throw Error("protected enrollment needs this host and distinct lowercase deployments");
  if (!Number.isSafeInteger(p.stagingMs) || p.stagingMs < 1000 || p.stagingMs > 600_000) throw Error("protected enrollment stagingMs must be 1000..600000");
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/.test(p.manager) || !path.isAbsolute(p.controlKeyFile)) throw Error("protected enrollment manager must be a loopback origin and an absolute key file");
  return Object.freeze({ ...p, deployments: Object.freeze([...p.deployments]) });
}

export class ProtectedSupervisor {
  /**
   * policy: loadEnrollment(); control: GuestdControl to policy.manager; openRuntime(adapters) -> { runtime, gate, pins,
   * snapshot(id) } (the owned r18 authority) or null; collect(record, policy) the owner-selected collector.
   */
  constructor({ policy, control, openRuntime = null, collect = null, store = null, now = Date.now, onError = () => {} }) {
    Object.assign(this, { policy, now, onError });
    // permit r7: a physical obligation-owner loss (released/lost descriptor, failed write/flush) is latched by the client and closes the
    // owned gate here: no new serving, staged/tracked compute retired by gate.close(), raw accepted operations kept owned by the client.
    this.client = new ProtectedIsolationClient({ control, onError, now, store, onOwnerLost: (e) => this.#ownerLost(e) });
    this.openRuntime = openRuntime; this.collect = collect;
    this.plans = new Map();            // deployment -> { body, stagingMs } from the host's isolation plan
    this.owned = null;                 // { runtime, gate, pins, snapshot, adapters }
    this.ownerClosing = null;          // permit r7: gate.close() completion after an obligation-owner loss
  }
  #ownerLost(e) {
    if (this.ownerClosing) return;
    this.onError(e);
    this.ownerClosing = this.owned ? this.owned.gate.close(`protected obligation owner lost: ${e.message}`) : Promise.resolve(true);
    this.ownerClosing.catch((err) => this.onError(err));
  }

  /**
   * permit r7: what an authenticated owned snapshot says about EXISTING authority, decided before (and independently of) the manager
   * capability and new-work admission. -> null (no withdrawal: queued/running here), { offline } (canonical host Offline, proof-verified,
   * this host) or { reason } (authenticated Stop/revocation/other assignment state, or the assignment moved to another host).
   * A snapshot without this exact deployment and a verified assignment proof is NOT authority: the caller fences (unknown), never
   * inventing a Stop. A verified Online for this host is never a veto on its own.
   */
  #withdrawalOf(id, snap) {
    const a = snap?.assignment, e = snap?.hostAuthorityEvidence ?? snap?.hostAuthority;
    if (e?.proofVerified === true && e.status === "offline" && e.context?.hostId === this.policy.host) return { offline: e };
    if (!a || a.deployment !== id || a.proofVerified !== true || typeof a.state !== "string") return { unknown: "snapshot carries no verified assignment for this deployment" };
    if (a.host !== this.policy.host) return { reason: `assignment moved to host ${a.host}` };
    if (a.state === "queued" || a.state === "running") return null;
    return { reason: `assignment is ${a.state}` };
  }
  enrolled(id) { return this.policy.deployments.includes(String(id)); }

  async #runtime() {
    if (this.owned) return this.owned;
    if (typeof this.openRuntime !== "function" || typeof this.collect !== "function") return null;
    // adapters need the runtime's gate, so the opener receives a binder and returns the owned runtime pieces
    let adapters = null;
    const owned = await this.openRuntime({ host: this.policy.host, deployments: [...this.policy.deployments],
      bind: ({ gate, pins }) => (adapters = this.client.runtimeAdapters({ host: this.policy.host, pins, gate, collect: this.collect,
        planOf: (id) => this.plans.get(id) ?? null })) });
    if (!owned?.runtime || !adapters) throw Error("owned r18 runtime did not bind the protected adapters");
    // permit r9: no owned runtime without the explicit route handoff (the real dispatch's activation); never a default-allow
    if (["owns", "activated", "why", "activate", "newWorkRefusal"].some((f) => typeof owned.handoff?.[f] !== "function")) {
      await owned.release?.("owned runtime without a lifecycle route handoff").catch(() => {});
      throw Error("owned r18 runtime has no lifecycle route handoff");
    }
    this.owned = { ...owned, adapters };
    return this.owned;
  }

  /**
   * permit r10: EXISTING authority only - no plan, body, catalog, manager capability or legacy ledger/book input. Runs owner-loss raw
   * cleanup, the authenticated snapshot, canonical Stop/Offline/revocation and unknown-authority fencing, then local capacity observation
   * of this route (real dispatch inventory/journal + authenticated shares). -> { done: result } (decided here, isolation-lifecycle
   * vocabulary) or { snap, owned } (authority is queued/running here: the caller may plan NEW work). The Host calls this for every
   * enrolled route BEFORE any new-work planning; reconcile() repeats it at the start effect so a plan never outlives a withdrawal.
   */
  /** r11: one lane per route: a call queues behind that route's previous pass (each makes its own FRESH read), never another route's. */
  authority(id) {
    const prev = this.#authorityLane.get(id) ?? Promise.resolve();
    const p = prev.then(() => this.#authorityOnce(id), () => this.#authorityOnce(id));
    const tail = p.catch(() => {}).finally(() => { if (this.#authorityLane.get(id) === tail) this.#authorityLane.delete(id); });
    this.#authorityLane.set(id, tail);
    return p;
  }
  #authorityLane = new Map();
  #resolving = null;
  /** r11: routes now run concurrently; the client-wide unknown-operation resolution stays single-flight (joined, never doubled). */
  #resolveUnknown() {
    this.#resolving ??= Promise.resolve().then(() => this.client.resolveUnknown()).finally(() => { this.#resolving = null; });
    return this.#resolving;
  }
  async #authorityOnce(id) {
    const held = (why, instance = null) => ({ done: { action: "held", instance, leaseFree: false, reason: `protected: ${why}` } });
    if (!this.enrolled(id)) throw Error("not an enrolled protected deployment");
    if (this.client.ownerLost) {
      await this.client.reconcileOrphans().catch((e) => this.onError(e));
      const closing = await Promise.race([(this.ownerClosing ?? Promise.resolve(true)).then(() => "owned compute withdrawn", (e) => `withdrawal incomplete (${e.message})`),
        new Promise((r) => { const t = setTimeout(() => r("gate withdrawal still in progress"), 1000); t.unref?.(); })]);
      const o = this.client.outstanding();
      const h = held(`obligation owner lost (${this.client.ownerLost.message}): no new work; ${closing}; ${o.retiring.length} instance(s) not yet confirmed absent; `
        + `${o.unresolved.length} unknown raw operation(s) without terminal proof; ${o.durableUndischarged.length} durable pre-send record(s) await a cold owner`);
      return { done: { ...h.done, outstanding: o } };
    }
    let owned;
    try { owned = await this.#runtime(); } catch (e) { return held(`owned runtime unavailable: ${e.message}`); }
    if (!owned) return held("protected authority unavailable (no qualified owned r18 runtime/collector on this host)");
    const fence = async (why) => {
      const f = await owned.runtime.fence(id).then(() => "fenced", (err) => `fence not acknowledged (${err.message})`);
      return held(`${why}; ${f}`);
    };
    let snap;
    try { snap = await owned.snapshot(id); }
    catch (e) { return fence(`authority snapshot unavailable: ${e.message}`); }
    const w = this.#withdrawalOf(id, snap);
    if (w?.unknown) return fence(`authority unknown: ${w.unknown}`);
    if (w) {
      try {
        let proof = w.offline ? await owned.runtime.revokeHostAuthority(id, { hostAuthorityEvidence: w.offline })
          : await owned.runtime.revokeAuthority(id, `protected: ${w.reason}`);
        if (proof === false) proof = (await owned.runtime.stop(id)) === true ? { absent: true, held: true } : null;   // v1 runtime
        if (proof?.absent !== true || proof.held !== true) return held(`authority withdrawn (${w.offline ? "canonical host Offline" : w.reason}); absence not confirmed`);
        return { done: { action: "held", instance: null, leaseFree: false, withdrawn: true,
          reason: `protected: authority withdrawn (${w.offline ? "canonical host Offline" : w.reason}); compute confirmed absent and boundary acknowledged` } };
      } catch (e) { return held(`authority withdrawal incomplete (${e.message}): the owner stays fenced and retries`); }
    }
    // unknown raw stages are cleanup, not new work: resolved before (and independently of) the manager capability gate
    await this.#resolveUnknown().catch((e) => this.onError(e));
    // r10: local capacity recovery of this route (real dispatch observe + learnShares). A failure leaves the allocation unresolved,
    // which the dispatch's own admission refuses at the start effect; it never fabricates zero.
    if (typeof owned.handoff.observe === "function") await owned.handoff.observe(id, snap).catch((e) => this.onError(e));
    return { snap, owned };
  }

  /** isolation-lifecycle vocabulary: { action, instance, reason, leaseFree } */
  async reconcile({ id, body }) {
    const held = (why, instance = null) => ({ action: "held", instance, leaseFree: false, reason: `protected: ${why}` });
    if (!this.enrolled(id)) throw Error("not an enrolled protected deployment");
    this.plans.set(id, { body: { ...structuredClone(body), name: id }, stagingMs: this.policy.stagingMs });
    // permit r7/r8/r10: EXISTING authority first (owner-loss raw cleanup, Stop/revocation/Offline, unknown fence) - before and
    // independently of the plan, manager capability and new-work admission.
    const a = await this.authority(id);
    if (a.done) return a.done;
    return this.#newWork(id, a.owned, a.snap, held);
  }

  async #newWork(id, owned, snap, held) {
    // permit r9: NEW work only after the explicit route handoff. Decided AFTER the withdrawal above (Stop/Offline never wait for it).
    // Unrouted, not-yet-activated (legacy work/lease still here, quiescence unproven) or owner-restricted: fence serving, keep compute
    // and every obligation, and say why. Activation is retried by asking the real dispatch (no cadence, no chain submission).
    const fenced = async (why) => {
      const f = await owned.runtime.fence(id).then(() => "fenced", (err) => `fence not acknowledged (${err.message})`);
      return held(`${why}; ${f}`);
    };
    // r11: the established policy must still be the CURRENT valid one for new work (rechecked again at each start/serve effect below)
    { const p = policyNewWorkRefusal(); if (p) return fenced(`no new work: ${p}`); }
    if (!owned.handoff.owns(id)) return fenced("no explicit lifecycle route for this enrolled deployment: no new work");
    if (!owned.handoff.activated(id)) {
      try { await owned.handoff.activate(); } catch (e) { this.onError(e); }
      if (!owned.handoff.activated(id)) return fenced(`lifecycle route handoff not activated (${owned.handoff.why(id) ?? "unknown"})`);
    }
    { const r = owned.handoff.newWorkRefusal(id); if (r) return fenced(`host owner restriction: ${r}`); }
    // NEW work only: the manager capability gates staging and serving, never the withdrawal above
    let cap;
    try { cap = await this.client.capability(); } catch (e) { return held(`manager capability unknown (${e.message})`); }
    if (!cap.available) return held(`manager enforcement unavailable: ${cap.reasons.join("; ")}`);
    const state = snap.assignment.state;
    { const p = policyNewWorkRefusal(); if (p) return fenced(`no new work: ${p}`); }   // r11: after the capability await
    try {
      if (state === "queued") {
        // r11: the client's unknown raw stages decide whether a thrown stage may discharge its reservation (unknown never releases)
        const r = await owned.runtime.ensureStaged(id, snap, { rawUnknown: (x) => this.client.unknownStages?.has?.(x) !== false });
        if (r.ended) return { action: "failed", instance: null, leaseFree: false, ended: true, reason: `protected: staging ended (${r.instance ?? "no instance"}); lease follows owner policy` };
        return held(r.ready ? "staged and readiness-verified; waiting for the owner's Running assignment" : (r.reason || "staging not yet ready"),
          r.instance ? { id: r.instance, name: id, status: "starting" } : null);
      }
      if (state === "running") {
        const h = await owned.runtime.health(id, snap.assignment.generation);
        if (!h.ready) return held(h.ended ? "the staged instance ended" : "the staged instance is not readiness-verified", h.instance ? { id: h.instance, name: id } : null);
        { const p = policyNewWorkRefusal(); if (p) return fenced(`no serving: ${p}`); }   // r11: after the health await, before serving
        await owned.runtime.serve(id, snap);
        const k = owned.adapters.instanceOf.get(id), v = k ? await this.client.view(k.instanceId) : null;
        if (!v || v.protected?.serving !== true) return held("serve did not leave a serving view", v);
        return { action: "adopted", instance: v, reason: null, leaseFree: false };
      }
      return held(`assignment is ${state ?? "unknown"}: nothing started`);
    } catch (e) { return held(e.message); }
  }

  /** Explicit owner Stop through the runtime (fence + exact removal + confirmed absence). */
  async stop(id) {
    const owned = await this.#runtime().catch(() => null);
    if (owned) { const ok = await owned.runtime.stop(id); return { removed: ok === true, leaseFree: false, reason: ok ? null : "protected: absence not confirmed" }; }
    const inv = await this.client.inventory(id);
    for (const v of inv.instances) if (isLive(v)) await this.client.stop(v.id);
    const after = await this.client.inventory(id);
    const left = after.instances.filter(isLive);
    return { removed: left.length === 0 && !this.client.unknownStages.has(id), leaseFree: false, reason: left.length ? "protected: records remain" : null };
  }
}

// ---- the host process's composition: ONE supervisor for the pinned policy, whatever client origin asks ----
// r5 (root-supervisor-diagnostic): an enrolled deployment is fenced INDEPENDENTLY of the selected manager origin. The
// supervisor always speaks to the POLICY's manager over guestd-control/1; a caller's client with another origin (direct,
// composite or changed) never selects the legacy path for an enrolled deployment. The policy host must equal the
// node's ACTUAL host identity (composition.hostId, set by the node entry from its verified identity); otherwise every
// enrolled deployment is held. The supervisor is created once (promise-cached), so concurrent first calls cannot split
// unknown-stage ownership across overwritten instances.
let enrollment;   // the ESTABLISHED policy epoch: undefined: not established yet; null: established with no policy (legacy everywhere)
let enrollmentKey = null, enrollmentEnv = null;   // r11: the configured file/sha pair (and env) it was established under
let supervisor = null;   // Promise<ProtectedSupervisor>
/**
 * r11: the CURRENT validity of the configured policy, re-read on every call (a small pinned file; no mtime trust). The first
 * observation establishes the epoch. Afterwards a changed file/sha configuration (including none -> configured), a missing,
 * corrupt or hash-mismatched file is "unknown": no new legacy or protected effect, while the ESTABLISHED policy stays the
 * supervisor's for withdrawal and cold recovery (never erased, never a second owner). -> { state, policy?, why? }
 */
function observeEnrollment(env = process.env) {
  const file = String(env.ENCLAVE_PROTECTED_ENROLLMENT || "").trim(), sha = String(env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256 || "").trim().toLowerCase();
  const key = `${file}\n${sha}`;
  if (enrollment !== undefined && key !== enrollmentKey) return { state: "unknown", why: "the configured protected enrollment changed after it was established (restart to adopt a new policy)" };
  if (!file && !sha) {
    if (enrollment === undefined) { enrollment = null; enrollmentKey = key; enrollmentEnv = env; }
    return { state: "none" };
  }
  let p;
  try { p = loadEnrollment(file, sha); } catch (e) { return { state: "unknown", why: `protected enrollment unreadable: ${e.message}` }; }
  if (enrollment === undefined) { enrollment = p; enrollmentKey = key; enrollmentEnv = env; }
  return { state: "valid", policy: enrollment };   // same file + same sha: byte-identical to the established policy
}
/** r11: why NEW protected work must not start now (the established policy is no longer the current valid one), or null. */
export function policyNewWorkRefusal(env = enrollmentEnv ?? process.env) {
  const o = observeEnrollment(env);
  return o.state === "valid" ? null : o.state === "none" ? "no protected enrollment is configured now" : o.why;
}
/** TEST/entry hook: owned runtime opener, collector, actual host id and obligation store the node entry composes. */
export const composition = { openRuntime: null, collect: null, controlFor: null, hostId: null, store: null };

/** -> the enrolled supervisor (for any client), null without a policy, or a supervisor that holds with the reason. */
export async function protectedSupervisorFor(client, env = process.env) {
  const o = observeEnrollment(env);
  // r11: an established policy keeps its ONE supervisor even when the current file became unknown (withdrawal and cold recovery
  // continue; #newWork refuses through policyNewWorkRefusal). Never established, or established as none: unknown is held, never legacy.
  if (!enrollment) {
    if (o.state === "none") return null;
    throw Error(o.why || "protected enrollment unknown");
  }
  supervisor ??= (async () => {
    if (!H32.test(String(composition.hostId)) || composition.hostId !== enrollment.host)
      throw Error(`protected enrollment names host ${enrollment.host} but this node's verified host identity is ${composition.hostId ?? "not composed"}`);
    const control = composition.controlFor ? composition.controlFor(enrollment)
      : await (async () => { const { GuestdControl, parseKey } = await import("../../isolation/m4/guestd/control-client.mjs");
          return new GuestdControl(enrollment.manager, parseKey(fs.readFileSync(enrollment.controlKeyFile, "utf8"))); })();
    // permit r6: the OWNED obligation log (explicitly installed beside the node-owned control key; never created here). A
    // missing/torn/foreign log or an unavailable owner exclusion rejects creation -> every enrolled deployment is held.
    const store = composition.store ?? await (async () => {
      const { openOwnedLog } = await import("../vbslike/manager/win-durable.mjs");
      return ownedObligationStore(openOwnedLog(path.join(path.dirname(enrollment.controlKeyFile), "protected-obligations.log"), { purpose: OBLIGATION_PURPOSE }));
    })();
    if (store.owned !== true && !composition.store) throw Error("protected obligations require an owned store");
    return new ProtectedSupervisor({ policy: enrollment, control, openRuntime: composition.openRuntime, collect: composition.collect, store });
  })();
  return supervisor;   // a rejected creation stays rejected (held by the caller), never replaced by a second owner
}
/** r5: true/false once a valid policy is loaded (unenrolled neighbours stay legacy even if the supervisor is held); undefined otherwise. */
export function enrolledByPolicy(id, env = process.env) {
  const o = observeEnrollment(env);   // r11: revalidated at every call, so every final Host gate sees a policy that changed since its decision
  return o.state === "valid" ? o.policy.deployments.includes(String(id)) : o.state === "none" ? false : undefined;
}
/**
 * r10: "valid" | "none" (no policy configured: legacy everywhere) | "unknown" (configured but unreadable/hash-mismatched/malformed).
 * UNKNOWN is never "not enrolled": the Host refuses every legacy claim/renew/release (any deployment may be enrolled) while keeping
 * local Stop/withdrawal and every retained obligation.
 */
export function enrollmentState(env = process.env) {
  return observeEnrollment(env).state;
}
/**
 * r10: the INDEPENDENT configuration of an enrolled deployment, taken ONLY from the authenticated new-ledger snapshot (the derived reader's
 * one verified block: deployment row resources/envelope/owner/access + catalog content pin). No retired book/ledger row, no publisher
 * listing, no request field. Publisher yank/delist is carried as `listing` for the HOST OWNER's elected policy (already applied by the
 * adapter's host-scoped admission); it is never a veto here. Integrity stays: the content CID and the envelope's configCid are the pinned
 * identities the plan's strict config fetch verifies. Throws (-> held, nothing new started) when any field is absent or unverified.
 */
export function protectedConfigOf(snap) {
  const a = snap?.assignment, r = snap?.resources, c = snap?.content, e = snap?.envelope;
  if (a?.proofVerified !== true || a.deployment !== snap.id) throw Error("snapshot is not a verified assignment of this deployment");
  const milli = (x) => Number.isInteger(x) && x >= 0 && x <= 1000;
  if (!r || !milli(r.cpuMilli) || !milli(r.gpuMilli) || !r.version || typeof r.version !== "object") throw Error("no authenticated resources");
  if (!c || typeof c.appRef !== "string" || !/^catalog:\/\/0x[0-9a-f]{64}\/[0-9]{1,9}$/.test(c.appRef) || typeof c.cid !== "string" || !c.cid) throw Error("no authenticated content pin");
  if (!e || typeof e.configCid !== "string" || !/^0x[0-9a-f]{40}$/.test(String(e.owner))) throw Error("no authenticated owner configuration");
  const v = r.version;
  return Object.freeze({
    deployment: Object.freeze({ id: snap.id, appRef: c.appRef, configCid: e.configCid, cpuMilli: r.cpuMilli, gpuMilli: r.gpuMilli,
      owner: e.owner, isPublic: snap.forPrivate !== true, active: true }),
    version: Object.freeze({ cid: c.cid, createdAt: c.createdAt, memMb: v.memMb, cpuGflops: v.cpuGflops, vramMb: v.vramMb, gpuGflops: v.gpuGflops,
      config: v.config }),
    listing: snap.listing ?? null,
  });
}
/** r9: the pinned policy's enrolled deployments (the host's event-driven launch list); [] without a valid policy. */
export function enrolledDeployments(env = process.env) {
  const o = observeEnrollment(env);
  return o.state === "valid" ? [...o.policy.deployments] : [];
}
/** r11: the ESTABLISHED enrolled deployments, whatever the current file says: withdrawal/Offline/cold recovery must still reach them. */
export function establishedEnrolledDeployments() { return enrollment ? [...enrollment.deployments] : []; }
/**
 * r9 GRACEFUL SHUTDOWN, in order: (1) the supervisor admits no new work (owner-closing latch, as on an obligation-owner loss);
 * (2) exact owner release of the owned lifecycle, whose withdrawal closes the gate (fence + retire tracked compute) BEFORE the flocks
 * go; (3) the client's honest outstanding counts. Raw unknown operations and durable pre-send records are KEPT (never a blind new empty
 * owner state); the next owner recovers them. -> { released, outstanding }
 */
export async function protectedShutdown(why = "node shutdown") {
  const s = supervisor ? await supervisor.catch(() => null) : null;
  if (!s) return { released: true, outstanding: null };
  s.closing = why;
  if (!s.client.ownerLost) s.client.ownerLost = Error(`graceful shutdown: ${why}`);
  const r = s.owned?.release ? await s.owned.release(why).catch((e) => ({ released: false, fenced: true, error: e })) : { released: true };
  await s.client.reconcileOrphans().catch((e) => s.onError(e));
  return { released: r?.released === true, outstanding: s.client.outstanding() };
}
/** TEST-only reset (the tests compose several hosts in one process). */
export function TEST_resetProtectedComposition() { supervisor = null; enrollment = undefined; enrollmentKey = null; enrollmentEnv = null; Object.assign(composition, { openRuntime: null, collect: null, controlFor: null, hostId: null, store: null }); }
