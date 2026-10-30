// protected-isolation.mjs - the Windows node's client for the manager's PROTECTED routes (permit r4, SOURCE ONLY, NOT RUN).
//
// It speaks the EXISTING guestd-control/1 client (isolation/m4/guestd/control-client.mjs) unchanged: every request is
// MAC'd under one session and every answer's response MAC is verified against that same session.
//
// r4 OUTCOMES. stage and permit change state, so they are NOT idempotent and are sent WITHOUT a `reconcile` callback:
// GuestdControl then never resends them after an unsigned 401 (its null-reconcile path resent; r3 root finding). An
// unknown stage outcome is an OWNED OBLIGATION: findByName refuses to answer "absent" for that deployment (so the r18
// runtime cannot start a second stage), every exact pp instance seen for it is held, and the obligation is discharged
// only by confirmed absence of every protected record for the deployment AFTER the late-completion horizon
// (stagingMs + replay window). A failed hold never discharges it. An unknown permit outcome is reconciled only from a
// strict MAC'd view: serving:true, state serving, the exact attached identity/epochs/generation, the same digest and a
// validUntil that is not later than the attachment's (never digest alone).
//
// r4 RUNTIME ADAPTERS. runtimeAdapters() returns the exact objects R18 network/deployment-isolation-runtime.mjs requires
// (client.findByName/spawn/remove, plans.read, readiness.verify, collectPermit, boundaries.allow/hold). The signed
// envelope is CARRIED, not reconstructed: collectPermit wraps the owner-selected collector and records the envelope it
// returned, bound to deployment + generation + sequence + host-authority digest + typed-data digest; boundaries.allow
// (which only receives the verified grant) uses that carried envelope ONLY if the supervisor gate's current entry for
// the deployment has exactly that digest and the grant's generation/hostAuthority/validUntil fit it. Consumed once.
import { hashTypedData } from "viem";
import { GuestdControlError } from "../../isolation/m4/guestd/control-client.mjs";
import { servingPermitTypedData } from "../../network/deployment-serving-permit.mjs";

export const STAGE_SCHEMA = "enclave-protected-stage/1";
export const ATTACHMENT_SCHEMA = "enclave-instance-permit-attachment/1";
export const INVENTORY_SCHEMA = "enclave-protected-inventory/1";
const PP = /^pp[0-9a-f]{32}$/, H32 = /^0x[0-9a-f]{64}$/, GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENTITY = ["instanceId", "vmId", "managerEpoch", "launchEpoch", "deployment", "generation", "appId", "runtimeId", "image"];
const TERMINAL = new Set(["removed", "refused"]);
const fail = (kind, message, extra = {}) => Object.assign(new GuestdControlError(kind, message), extra);

export class ProtectedIsolationClient {
  /** control: a GuestdControl for the manager's origin; replayWindowMs bounds a delayed request after a lost answer */
  constructor({ control, onError = () => {}, now = Date.now, replayWindowMs = 120_000 }) {
    if (!control || typeof control.request !== "function") throw Error("a GuestdControl client is required");
    Object.assign(this, { control, onError, now, replayWindowMs });
    this.unknownStages = new Map();   // deployment -> { reason, at, horizon } : a stage whose outcome is unknown stays owned
    this.unknownPermits = new Map();  // instanceId -> { attachment, reason }
  }

  async capability() {
    const r = await this.control.request("GET", "/health");
    if (r.status !== 200) return { available: false, reasons: [`health ${r.status}`] };
    const c = r.body?.permitEnforcement;
    return { available: c?.available === true && r.body?.supports?.permitEnforcement === true, reasons: c?.reasons ?? ["no permitEnforcement"],
      workloads: Array.isArray(c?.workloads) ? c.workloads : [], enforcementEpoch: c?.enforcementEpoch ?? null };
  }

  /** r4: the strict authenticated reconciliation route (exact deployment, MAC'd, every protected record incl. non-terminal). */
  async inventory(deployment) {
    if (!H32.test(deployment)) throw Error("deployment must be a lowercase bytes32");
    const r = await this.control.request("GET", `/protected/deployments/${deployment}/instances`);
    const b = r.body;
    if (r.status !== 200 || b?.schema !== INVENTORY_SCHEMA || b.deployment !== deployment || b.complete !== true || !Array.isArray(b.instances)
        || typeof b.managerEpoch !== "string")
      throw new GuestdControlError("protocol", `protected inventory answered ${r.status}: unknown (not absence)`);
    for (const v of b.instances) {
      if (!PP.test(String(v?.id)) || v.protected?.deployment !== deployment || v.protected?.instanceId !== v.id)
        throw new GuestdControlError("protocol", "protected inventory carries a record that is not exactly this deployment's");
    }
    return b;
  }

  /** -> the manager's stage answer, or throws; an unknown outcome is recorded and OWNED (never resent here). */
  async stage({ deployment, stagingMs, spawn }) {
    if (!H32.test(deployment)) throw Error("deployment must be a lowercase bytes32");
    if (this.unknownStages.has(deployment)) throw fail("outcome-unknown", "an earlier stage of this deployment has an unknown outcome: not repeated", { mayHaveExecuted: true });
    let r;
    try { r = await this.control.request("POST", "/protected/vms", { schema: STAGE_SCHEMA, deployment, stagingMs, spawn }, { idempotent: false }); }
    catch (e) {
      if (e?.mayHaveExecuted) this.unknownStages.set(deployment, { reason: e.message, at: this.now(), horizon: this.now() + stagingMs + this.replayWindowMs });
      throw e;
    }
    if (r.status === 202) {
      const b = r.body;
      if (!PP.test(String(b?.instanceId)) || b.deployment !== deployment || b.serving !== false || !Number.isSafeInteger(b.generation)
          || typeof b.launchEpoch !== "string" || typeof b.managerEpoch !== "string" || !Number.isSafeInteger(b.stagingWallUntil)) {
        // an authenticated 202 that does not bind this request: something may be staged; owned, not assumed
        this.unknownStages.set(deployment, { reason: "stage answer does not bind this request", at: this.now(), horizon: this.now() + stagingMs + this.replayWindowMs });
        throw fail("protocol", "stage answer does not bind this deployment", { mayHaveExecuted: true });
      }
      return b;
    }
    throw Object.assign(Error(`stage refused (${r.status}): ${r.body?.error ?? ""}`), { status: r.status, kind: r.status >= 400 && r.status < 500 ? "refused" : "unavailable" });
  }

  async view(id) {
    if (!PP.test(id)) throw Error("not a protected instance id");
    const r = await this.control.request("GET", `/vms/${id}`);
    if (r.status === 404) return null;
    if (r.status !== 200 || r.body?.id !== id) throw new GuestdControlError("protocol", `GET /vms/${id} answered ${r.status}: unknown`);
    return r.body;
  }

  /** The attachment from the MAC'd protected view only. permitDigest: hashTypedData of the signed record (node-computed). */
  static attachment(view, { permitDigest, validUntil }) {
    const p = view?.protected;
    if (!p || p.state !== "staged" && p.state !== "serving") throw Error(`instance is ${p?.state ?? "unknown"}: no attachment`);
    if (view.status !== "running" || view.recovered) throw Error("instance is not readiness-verified");
    if (!H32.test(permitDigest) || !Number.isSafeInteger(validUntil)) throw Error("permit digest and validUntil (ms) required");
    if (!GUID.test(String(p.vmId || ""))) throw Error("instance has no bound VM GUID");
    return { schema: ATTACHMENT_SCHEMA, instanceId: p.instanceId, vmId: p.vmId, managerEpoch: p.managerEpoch, launchEpoch: p.launchEpoch,
      deployment: p.deployment, generation: p.generation, appId: p.appId, runtimeId: p.runtimeId, image: p.image, permitDigest, validUntil };
  }

  /** r4: a positive serving observation needs the exact identity, the digest, state serving and an unextended deadline. */
  static servingMatches(view, attachment, now) {
    const p = view?.protected;
    if (!p || p.serving !== true || p.state !== "serving" || view.status !== "running" || view.recovered) return false;
    for (const k of IDENTITY) if ((k === "vmId" ? String(p[k]).toLowerCase() : p[k]) !== (k === "vmId" ? String(attachment[k]).toLowerCase() : attachment[k])) return false;
    return p.permitDigest === attachment.permitDigest && Number.isSafeInteger(p.validUntil) && p.validUntil <= attachment.validUntil && p.validUntil > now;
  }

  /** Attach a verified serving permit. Never resent; an unknown outcome is reconciled from a strict MAC'd view only. */
  async permit(id, envelope, attachment) {
    let r;
    try { r = await this.control.request("POST", `/protected/vms/${id}/permit`, { envelope, attachment }, { idempotent: false }); }
    catch (e) {
      if (!e?.mayHaveExecuted) throw e;
      this.unknownPermits.set(id, { attachment, reason: e.message });
      const v = await this.view(id).catch(() => null);
      if (v && ProtectedIsolationClient.servingMatches(v, attachment, this.now())) {
        this.unknownPermits.delete(id);
        return { serving: true, reconciled: true, deployment: v.protected.deployment, generation: v.protected.generation, validUntil: v.protected.validUntil,
          instanceId: id, permitDigest: v.protected.permitDigest, expiryEnforced: true, hostAuthority: null };
      }
      throw e;
    }
    if (r.status !== 200) throw Object.assign(Error(`permit refused (${r.status}): ${r.body?.error ?? ""}`), { status: r.status });
    const b = r.body;
    if (b?.permitDigest !== attachment.permitDigest || b.instanceId !== id || b.expiryEnforced !== true || b.deployment !== attachment.deployment
        || b.generation !== attachment.generation || !Number.isSafeInteger(b.validUntil) || b.validUntil > attachment.validUntil
        || String(b.vmId).toLowerCase() !== String(attachment.vmId).toLowerCase() || b.appId !== attachment.appId || b.runtimeId !== attachment.runtimeId
        || (b.image ?? null) !== (attachment.image ?? null) || !H32.test(String(b.hostAuthority)))
      throw Error("permit answer does not bind this instance, digest, identity and deadline");
    this.unknownPermits.delete(id);
    return { serving: true, ...b };
  }

  /** Withdrawal: the manager's truthful acknowledgment, verbatim (ingress/storage/secrets/boundaries, compute pending). */
  async hold(id) {
    const r = await this.control.request("POST", `/protected/vms/${id}/hold`, undefined, { idempotent: true });
    if (r.status !== 200 || r.body?.instanceId !== id || typeof r.body?.deployment !== "string")
      throw Object.assign(Error(`hold not acknowledged (${r.status}): ${r.body?.error ?? ""}`), { status: r.status });
    return r.body;
  }
  async stop(id) {
    const r = await this.control.request("DELETE", `/vms/${id}`, undefined, { idempotent: true });
    if (r.status === 404) return { absent: true };
    if (r.status !== 200 || r.body?.ok !== true) throw Object.assign(Error(`stop not confirmed (${r.status}): ${r.body?.error ?? ""}`), { status: r.status });
    return { removed: true };
  }

  /**
   * Owned unknown stages. Every exact protected instance seen for such a deployment that is not wanted is held; the
   * obligation is discharged ONLY when the strict inventory shows no non-terminal protected record for the deployment
   * after the late-completion horizon. A failed hold, an unreadable inventory or an early empty answer keep it.
   */
  async resolveUnknown(wanted = () => false) {
    const out = [];
    for (const [dep, u] of [...this.unknownStages]) {
      try {
        const inv = await this.inventory(dep);
        const live = inv.instances.filter((v) => !TERMINAL.has(v.protected?.state));
        let failed = false;
        for (const v of live) if (!wanted(dep, v.id)) {
          const r = await this.hold(v.id).catch((e) => ({ error: e.message, instanceId: v.id }));
          if (r.error) failed = true;
          out.push(r);
        }
        if (!failed && live.length === 0 && this.now() >= u.horizon) this.unknownStages.delete(dep);
      } catch (e) { this.onError(e); }
    }
    return out;
  }

  /**
   * r4: the adapters R18 createIsolationLifecycleRuntime requires, bound to THIS client and one deployment plan source.
   * gate: the supervisor's own DeploymentPermitGate (the runtime's gate); collect: the owner-selected collector;
   * planOf(id) -> { body, stagingMs } from the node's isolation plan; capabilityOk() -> current manager capability.
   */
  runtimeAdapters({ host, pins, gate, collect, planOf, startupDeadlineMs = 180_000 }) {
    if (!H32.test(host) || typeof collect !== "function" || typeof planOf !== "function" || !gate?.entries) throw Error("runtime adapters need host, gate, collector and plan source");
    const self = this, instanceOf = new Map(), carried = new Map();
    const exactOne = async (id) => {
      if (this.unknownStages.has(id)) {
        await this.resolveUnknown();
        if (this.unknownStages.has(id)) throw fail("outcome-unknown", `an unknown stage of ${id} is still owned: absence is not established`);
      }
      const live = (await this.inventory(id)).instances.filter((v) => !TERMINAL.has(v.protected?.state));
      if (live.length > 1) throw fail("protocol", `${live.length} protected records for ${id}: ambiguous, nothing adopted`);
      const v = live[0] ?? null, known = instanceOf.get(id);
      if (v && known && known.instanceId !== v.id) throw fail("protocol", `protected record ${v.id} is not the instance this supervisor staged (${known.instanceId})`);
      if (v && !known) throw fail("protocol", `protected record ${v.id} was not staged by this supervisor: held, never adopted`);
      return v;
    };
    const client = {
      async findByName(id) {
        const v = await exactOne(id);
        return v ? { id: v.id, name: id, status: v.status, recovered: v.recovered === true, protected: v.protected } : null;
      },
      async spawn(body) {
        const id = body?.name, plan = planOf(id);
        const r = await self.stage({ deployment: id, stagingMs: plan.stagingMs, spawn: body });
        instanceOf.set(id, { instanceId: r.instanceId, launchEpoch: r.launchEpoch, managerEpoch: r.managerEpoch, generation: r.generation });
        return { view: { id: r.instanceId, name: id, status: "starting", recovered: false } };
      },
      async remove(instance) {
        if (!PP.test(String(instance))) throw Error("protected runtime removes only exact protected ids");
        const r = await self.stop(instance);
        for (const [d, k] of instanceOf) if (k.instanceId === instance) instanceOf.delete(d);
        return r;
      },
    };
    const plans = {
      async read(id) {
        const plan = planOf(id), cap = await self.capability();
        return { verified: cap.available === true && plan?.body?.name === id, host, body: plan?.body, stagingEnforced: cap.available === true, startupDeadlineMs };
      },
    };
    const readiness = {
      async verify({ deployment, generation, view }) {
        const v = await self.view(view.id), p = v?.protected, k = instanceOf.get(deployment);
        const ok = !!v && !!k && v.status === "running" && !v.recovered && ["staged", "serving"].includes(p?.state) && p.deployment === deployment
          && p.instanceId === view.id && p.generation === generation && p.launchEpoch === k.launchEpoch && p.managerEpoch === k.managerEpoch && GUID.test(String(p.vmId || ""));
        return { verified: ok, ready: ok, deployment, host, generation, instance: view.id, validUntil: ok ? (p.validUntil ?? p.stagingWallUntil) : 0 };
      },
    };
    async function collectPermit(record, policy) {
      const envelope = await collect(record, policy);
      if (!envelope || JSON.stringify(envelope.record) !== JSON.stringify(record)) throw Error("collector returned an envelope for another record");
      const digest = hashTypedData(servingPermitTypedData(pins, record));
      carried.set(record.deployment, { envelope: structuredClone(envelope), digest, generation: record.generation, sequence: record.sequence,
        validUntilMs: record.validUntil * 1000, hostAuthority: record.hostAuthority?.digest ?? null });
      return envelope;
    }
    const boundaries = {
      async allow(id, grant) {
        const c = carried.get(id); carried.delete(id);                // consumed once, never a mutable "last envelope"
        const entry = gate.entries.get(id), k = instanceOf.get(id);
        if (!c || !entry || entry.digest !== c.digest || grant.generation !== c.generation || (grant.hostAuthority ?? null) !== c.hostAuthority
            || !(grant.validUntil <= c.validUntilMs) || !k) throw Error("no carried signed envelope bound to this verified grant");
        const v = await self.view(k.instanceId);
        const attachment = ProtectedIsolationClient.attachment(v, { permitDigest: c.digest, validUntil: grant.validUntil });
        if (attachment.launchEpoch !== k.launchEpoch || attachment.managerEpoch !== k.managerEpoch) throw Error("instance epoch changed since stage");
        const r = await self.permit(k.instanceId, c.envelope, attachment);
        return { deployment: r.deployment, generation: r.generation, validUntil: r.validUntil, expiryEnforced: r.expiryEnforced === true,
          hostAuthority: r.hostAuthority, instanceId: k.instanceId, permitDigest: r.permitDigest };
      },
      async hold(id) {
        const k = instanceOf.get(id);
        const inv = await self.inventory(id);
        const live = inv.instances.filter((v) => !TERMINAL.has(v.protected?.state));
        if (!live.length && !self.unknownStages.has(id)) return { deployment: id, ingress: true, storage: true, secrets: true, basis: "no protected record for this deployment" };
        const acks = [];
        for (const v of live) acks.push(await self.hold(v.id));
        const all = (f) => acks.length > 0 && acks.every((a) => a[f] === true);
        return { deployment: id, ingress: all("ingress"), storage: all("storage"), secrets: all("secrets") && !self.unknownStages.has(id),
          instances: acks, staged: k?.instanceId ?? null };
      },
    };
    return { client, plans, readiness, collectPermit, boundaries, instanceOf };
  }
}
