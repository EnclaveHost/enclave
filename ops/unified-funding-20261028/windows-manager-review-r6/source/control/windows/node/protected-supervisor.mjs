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
// Its genuine derived-finality inputs are not qualified on Windows: in that case openRuntime is absent and every
// enrolled deployment is held "protected authority unavailable" - never served, never downgraded.
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
    this.client = new ProtectedIsolationClient({ control, onError, now, store });
    this.openRuntime = openRuntime; this.collect = collect;
    this.plans = new Map();            // deployment -> { body, stagingMs } from the host's isolation plan
    this.owned = null;                 // { runtime, gate, pins, snapshot, adapters }
  }
  enrolled(id) { return this.policy.deployments.includes(String(id)); }

  async #runtime() {
    if (this.owned) return this.owned;
    if (typeof this.openRuntime !== "function" || typeof this.collect !== "function") return null;
    // adapters need the runtime's gate, so the opener receives a binder and returns the owned runtime pieces
    let adapters = null;
    const owned = await this.openRuntime({ host: this.policy.host,
      bind: ({ gate, pins }) => (adapters = this.client.runtimeAdapters({ host: this.policy.host, pins, gate, collect: this.collect,
        planOf: (id) => this.plans.get(id) ?? null })) });
    if (!owned?.runtime || !adapters) throw Error("owned r18 runtime did not bind the protected adapters");
    this.owned = { ...owned, adapters };
    return this.owned;
  }

  /** isolation-lifecycle vocabulary: { action, instance, reason, leaseFree } */
  async reconcile({ id, body }) {
    const held = (why, instance = null) => ({ action: "held", instance, leaseFree: false, reason: `protected: ${why}` });
    if (!this.enrolled(id)) throw Error("not an enrolled protected deployment");
    this.plans.set(id, { body: { ...structuredClone(body), name: id }, stagingMs: this.policy.stagingMs });
    let cap;
    try { cap = await this.client.capability(); } catch (e) { return held(`manager capability unknown (${e.message})`); }
    if (!cap.available) return held(`manager enforcement unavailable: ${cap.reasons.join("; ")}`);
    let owned;
    try { owned = await this.#runtime(); } catch (e) { return held(`owned runtime unavailable: ${e.message}`); }
    if (!owned) return held("protected authority unavailable (no qualified owned r18 runtime/collector on this host)");
    await this.client.resolveUnknown().catch((e) => this.onError(e));
    let snap;
    try { snap = await owned.snapshot(id); } catch (e) { return held(`authority snapshot unavailable: ${e.message}`); }
    const state = snap?.assignment?.state;
    try {
      if (state === "queued") {
        const r = await owned.runtime.ensureStaged(id, snap);
        if (r.ended) return { action: "failed", instance: null, leaseFree: false, ended: true, reason: `protected: staging ended (${r.instance ?? "no instance"}); lease follows owner policy` };
        return held(r.ready ? "staged and readiness-verified; waiting for the owner's Running assignment" : (r.reason || "staging not yet ready"),
          r.instance ? { id: r.instance, name: id, status: "starting" } : null);
      }
      if (state === "running") {
        const h = await owned.runtime.health(id, snap.assignment.generation);
        if (!h.ready) return held(h.ended ? "the staged instance ended" : "the staged instance is not readiness-verified", h.instance ? { id: h.instance, name: id } : null);
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
let enrollment;   // undefined: not read yet; null: no policy (legacy everywhere)
let supervisor = null;   // Promise<ProtectedSupervisor>
/** TEST/entry hook: owned runtime opener, collector, actual host id and obligation store the node entry composes. */
export const composition = { openRuntime: null, collect: null, controlFor: null, hostId: null, store: null };

/** -> the enrolled supervisor (for any client), null without a policy, or a supervisor that holds with the reason. */
export async function protectedSupervisorFor(client, env = process.env) {
  if (enrollment === undefined) {
    const file = String(env.ENCLAVE_PROTECTED_ENROLLMENT || "").trim(), sha = String(env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256 || "").trim().toLowerCase();
    enrollment = file || sha ? loadEnrollment(file, sha) : null;      // a broken policy throws: never silently legacy
  }
  if (!enrollment) return null;
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
  if (enrollment === undefined) {
    const file = String(env.ENCLAVE_PROTECTED_ENROLLMENT || "").trim(), sha = String(env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256 || "").trim().toLowerCase();
    try { enrollment = file || sha ? loadEnrollment(file, sha) : null; } catch { return undefined; }   // broken: protectedSupervisorFor reports it
  }
  return enrollment ?enrollment.deployments.includes(String(id)) : enrollment === null ? false : undefined; }
/** TEST-only reset (the tests compose several hosts in one process). */
export function TEST_resetProtectedComposition() { supervisor = null; enrollment = undefined; Object.assign(composition, { openRuntime: null, collect: null, controlFor: null, hostId: null, store: null }); }
