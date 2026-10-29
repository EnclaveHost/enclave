// protected-isolation.mjs - the Windows node's client for the manager's PROTECTED routes (permit r5, SOURCE ONLY, NOT RUN).
//
// It speaks the EXISTING guestd-control/1 client (isolation/m4/guestd/control-client.mjs) unchanged: every request is
// MAC'd under one session and every answer's response MAC is verified against that same session.
//
// OUTCOMES. stage and permit change state, so they are NOT idempotent and are sent WITHOUT a `reconcile` callback:
// GuestdControl never resends them. r5: every stage carries an `operation` id that is written to the node's DURABLE
// obligation store BEFORE the request is sent. An unknown outcome (lost reply, slow queue, disconnect, restart) stays
// owned until the manager's exact authenticated outcome for that operation is known:
//   executed -> bound to that exact instance (our own request id, not a first-match adoption);
//   unseen   -> the node asks the manager to durably CANCEL the operation; only the cancellation acknowledgment
//               discharges the obligation, and the manager then refuses every later arrival of the signed request;
//   in-progress / unreadable / any other answer -> still owned.
// Elapsed wall time and an empty inventory never discharge anything (r4 root-delayed-mac finding).
//
// FENCE vs RETIREMENT (r5, root-supervisor-diagnostic churn). The r18 runtime fences on every ensureStaged pass. For the
// exact instance this node staged that is still staged and has never served, the boundary hold is the manager's
// NON-destructive staged I/O fence (/fence): compute is kept, still bounded by the absolute staging deadline the
// manager fixed at stage. Serving, held, unknown or foreign records get the destructive hold. Retirement (Stop,
// expiry, revocation-with-removal) still goes through stop()/the manager's own deadline.
//
// PERMIT. A lost permit answer is reconciled only from a strict MAC'd view carrying serving:true, the exact identity,
// the same digest, an unextended future deadline, expiryEnforced and the exact host-authority digest the manager's own
// gate bound (never the caller's assertion, never digest alone). The carried envelope is the exact signed envelope
// keyed by deployment AND typed-data digest, so concurrent renewals and late results never swap envelopes.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { hashTypedData } from "viem";
import { GuestdControlError } from "../../isolation/m4/guestd/control-client.mjs";
import { servingPermitTypedData } from "../../network/deployment-serving-permit.mjs";

export const STAGE_SCHEMA = "enclave-protected-stage/1";
export const ATTACHMENT_SCHEMA = "enclave-instance-permit-attachment/1";
export const INVENTORY_SCHEMA = "enclave-protected-inventory/1";
export const OPERATION_SCHEMA = "enclave-protected-operation/1";
export const OBLIGATION_SCHEMA = "enclave-protected-obligations/1";
const PP = /^pp[0-9a-f]{32}$/, OP = /^op[0-9a-f]{32}$/, H32 = /^0x[0-9a-f]{64}$/, GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENTITY = ["instanceId", "vmId", "managerEpoch", "launchEpoch", "deployment", "generation", "appId", "runtimeId", "image"];
const TERMINAL = new Set(["removed", "refused"]);
const fail = (kind, message, extra = {}) => Object.assign(new GuestdControlError(kind, message), extra);
/** A record is LIVE unless its state is terminal AND its compute is confirmed not present (a terminal row masks nothing). */
export const isLive = (v) => !TERMINAL.has(v?.protected?.state) || v?.computePresent === true || (v?.status !== undefined && v.status !== "absent");

/**
 * permit r6: the node's OWNED obligation store over an owned win-durable log handle (openOwnedLog, purpose
 * OBLIGATION_PURPOSE): append-only hash-chained snapshots, the handle IS the physical owner (a second owner is refused by the
 * exclusion), any write/flush error latches the handle failed. Replay: an explicitly initialized genesis-only log is the
 * empty state; otherwise the last complete snapshot. Torn, quarantined, failed, released or foreign: load/save REFUSE -
 * obligations are unknown, never fresh, never recreated here. Windows exclusion qualification remains pending (see report);
 * TEST_inProcessExclusion handles prove the logic only.
 */
export const OBLIGATION_PURPOSE = "enclave-protected-obligations/1";
export function ownedObligationStore(log) {
  if (typeof log?.append !== "function" || typeof log.rows !== "function" || typeof log.assertLive !== "function") throw Error("owned obligation store needs an owned log handle");
  const replay = () => {
    if (log.released()) throw Error("obligation owner released: obligations unknown, never fresh");
    if (log.failed()) throw Error(`obligation log failed: ${log.failed()}`);
    if (log.ambiguous() || log.quarantined()) throw Error("obligation log torn or quarantined: obligations unknown until explicit owner reconciliation");
    let last = null;
    for (const r of log.rows()) if (r.kind === "obligations") last = r.data;
    const j = last ?? { schema: OBLIGATION_SCHEMA, unknown: {}, stages: {} };
    if (j?.schema !== OBLIGATION_SCHEMA || typeof j.stages !== "object" || typeof j.unknown !== "object") throw Error("obligation log malformed: refusing to guess");
    return j;
  };
  return { label: `owned:${log.file}`, exclusion: log.exclusion, owned: true,
    load() { return structuredClone(replay()); },
    save(state) { replay(); log.append("obligations", state); },   // throws (latched) on any failure: the caller sends nothing
    assertLive() { log.assertLive(); } };
}

/** TEST/ordinary persistence only (NOT owned, NOT a crash/owner-loss qualification): one JSON file, write+fsync+rename. */
export function fileObligationStore(file) {
  if (!path.isAbsolute(String(file))) throw Error("obligation store must be an absolute file");
  return {
    label: file,
    load() {
      let raw; try { raw = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
      const j = JSON.parse(raw);
      if (j?.schema !== OBLIGATION_SCHEMA || typeof j.stages !== "object" || typeof j.unknown !== "object") throw Error("obligation store malformed: refusing to guess");
      return j;
    },
    save(state) {
      const tmp = `${file}.${process.pid}.tmp`, fd = fs.openSync(tmp, "w", 0o600);
      try { fs.writeSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
    },
  };
}

export class ProtectedIsolationClient {
  /** control: a GuestdControl for the manager's origin; store: durable obligations (fileObligationStore) or null (memory, TEST) */
  constructor({ control, onError = () => {}, now = Date.now, store = null }) {
    if (!control || typeof control.request !== "function") throw Error("a GuestdControl client is required");
    Object.assign(this, { control, onError, now, store });
    this.unknownStages = new Map();   // deployment -> { operation, reason, at } : sent, outcome not yet exactly known
    this.staged = new Map();          // deployment -> { instanceId, launchEpoch, managerEpoch, generation, operation }
    this.unknownPermits = new Map();  // instanceId -> { attachment, reason }
    const s = store?.load();          // a malformed store throws: never silently forgotten
    if (s) {
      for (const [d, u] of Object.entries(s.unknown)) this.unknownStages.set(d, u);
      for (const [d, k] of Object.entries(s.stages)) this.staged.set(d, k);
    }
  }
  #save() {
    if (!this.store) return;
    this.store.save({ schema: OBLIGATION_SCHEMA, unknown: Object.fromEntries(this.unknownStages), stages: Object.fromEntries(this.staged) });
  }

  async capability() {
    const r = await this.control.request("GET", "/health");
    if (r.status !== 200) return { available: false, reasons: [`health ${r.status}`] };
    const c = r.body?.permitEnforcement;
    return { available: c?.available === true && r.body?.supports?.permitEnforcement === true, reasons: c?.reasons ?? ["no permitEnforcement"],
      workloads: Array.isArray(c?.workloads) ? c.workloads : [], enforcementEpoch: c?.enforcementEpoch ?? null };
  }

  /** The strict authenticated reconciliation route (exact deployment, MAC'd, every protected record incl. non-terminal). */
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

  /** -> the manager's stage answer, or throws; the obligation is durable BEFORE the request leaves (never resent). */
  async stage({ deployment, stagingMs, spawn }) {
    if (!H32.test(deployment)) throw Error("deployment must be a lowercase bytes32");
    if (this.unknownStages.has(deployment)) throw fail("outcome-unknown", "an earlier stage of this deployment has an unknown outcome: not repeated", { mayHaveExecuted: true });
    const operation = "op" + crypto.randomBytes(16).toString("hex");
    this.unknownStages.set(deployment, { operation, reason: "sent; outcome not yet acknowledged", at: this.now() });
    try { this.#save(); } catch (e) { this.unknownStages.delete(deployment); throw Object.assign(Error(`obligation not durable; nothing sent: ${e.message}`), { kind: "unavailable" }); }
    let r;
    try { r = await this.control.request("POST", "/protected/vms", { schema: STAGE_SCHEMA, deployment, stagingMs, spawn, operation }, { idempotent: false }); }
    catch (e) {
      // kept even when the transport says "not sent": the cancel/outcome round trip is cheap, a wrong guess is not
      this.unknownStages.set(deployment, { operation, reason: e.message, at: this.now() }); this.#tryPersist();
      throw e;
    }
    if (r.status === 202) {
      const b = r.body;
      if (!PP.test(String(b?.instanceId)) || b.deployment !== deployment || b.serving !== false || !Number.isSafeInteger(b.generation)
          || typeof b.launchEpoch !== "string" || typeof b.managerEpoch !== "string" || !Number.isSafeInteger(b.stagingWallUntil))
        throw fail("protocol", "stage answer does not bind this deployment: resolved only from the operation outcome", { mayHaveExecuted: true });
      this.staged.set(deployment, { instanceId: b.instanceId, launchEpoch: b.launchEpoch, managerEpoch: b.managerEpoch, generation: b.generation, operation });
      this.unknownStages.delete(deployment); this.#tryPersist();
      return b;
    }
    // 400 is answered by request validation BEFORE the operation is registered: nothing executed. Any other authenticated
    // refusal may follow the durable `executed` outcome (e.g. guard registration), so it is resolved from that outcome.
    if (r.status === 400) { this.unknownStages.delete(deployment); this.#tryPersist(); }
    throw Object.assign(Error(`stage refused (${r.status}): ${r.body?.error ?? ""}`), { status: r.status, kind: r.status >= 400 && r.status < 500 ? "refused" : "unavailable" });
  }
  #tryPersist() { try { this.#save(); } catch (e) { this.onError(e); } }

  async operation(op) {
    const r = await this.control.request("GET", `/protected/operations/${op}`);
    if (r.status !== 200 || r.body?.schema !== OPERATION_SCHEMA || r.body.operation !== op) throw new GuestdControlError("protocol", `operation ${op} answered ${r.status}: unknown`);
    return r.body;
  }
  async cancel(op, deployment) {
    const r = await this.control.request("POST", `/protected/operations/${op}/cancel`, { deployment }, { idempotent: true });
    if (r.status !== 200 || r.body?.schema !== OPERATION_SCHEMA || r.body.operation !== op || r.body.deployment !== deployment)
      throw new GuestdControlError("protocol", `cancel of ${op} answered ${r.status}: unknown`);
    return r.body;
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

  /** A positive serving observation: exact identity, digest, state serving, unextended future deadline, enforced expiry, exact authority. */
  static servingMatches(view, attachment, now, hostAuthority) {
    const p = view?.protected;
    if (!p || p.serving !== true || p.state !== "serving" || view.status !== "running" || view.recovered || p.expiryEnforced !== true) return false;
    for (const k of IDENTITY) if ((k === "vmId" ? String(p[k]).toLowerCase() : p[k]) !== (k === "vmId" ? String(attachment[k]).toLowerCase() : attachment[k])) return false;
    if (!H32.test(String(hostAuthority)) || p.hostAuthority !== hostAuthority) return false;
    return p.permitDigest === attachment.permitDigest && Number.isSafeInteger(p.validUntil) && p.validUntil <= attachment.validUntil && p.validUntil > now;
  }

  /** Attach a verified serving permit. Never resent; an unknown outcome is reconciled from a strict MAC'd view only. */
  async permit(id, envelope, attachment, { hostAuthority = null } = {}) {
    let r;
    try { r = await this.control.request("POST", `/protected/vms/${id}/permit`, { envelope, attachment }, { idempotent: false }); }
    catch (e) {
      if (!e?.mayHaveExecuted) throw e;
      this.unknownPermits.set(id, { attachment, reason: e.message });
      const v = await this.view(id).catch(() => null);
      if (v && ProtectedIsolationClient.servingMatches(v, attachment, this.now(), hostAuthority)) {
        this.unknownPermits.delete(id);
        const p = v.protected;   // every field below is the manager's MAC'd enforced state, checked equal above
        return { serving: true, reconciled: true, deployment: p.deployment, generation: p.generation, validUntil: p.validUntil,
          instanceId: id, permitDigest: p.permitDigest, expiryEnforced: p.expiryEnforced === true, hostAuthority: p.hostAuthority };
      }
      throw e;   // still unknown: unknownPermits keeps it owned; the runtime fences
    }
    if (r.status !== 200) throw Object.assign(Error(`permit refused (${r.status}): ${r.body?.error ?? ""}`), { status: r.status });
    const b = r.body;
    if (b?.permitDigest !== attachment.permitDigest || b.instanceId !== id || b.expiryEnforced !== true || b.deployment !== attachment.deployment
        || b.generation !== attachment.generation || !Number.isSafeInteger(b.validUntil) || b.validUntil > attachment.validUntil
        || String(b.vmId).toLowerCase() !== String(attachment.vmId).toLowerCase() || b.appId !== attachment.appId || b.runtimeId !== attachment.runtimeId
        || (b.image ?? null) !== (attachment.image ?? null) || !H32.test(String(b.hostAuthority)) || (hostAuthority !== null && b.hostAuthority !== hostAuthority))
      throw Error("permit answer does not bind this instance, digest, identity, authority and deadline");
    this.unknownPermits.delete(id);
    return { serving: true, ...b };
  }

  /** Destructive withdrawal: the manager's truthful acknowledgment, verbatim (compute removal pending until surveyed). */
  async hold(id) {
    const r = await this.control.request("POST", `/protected/vms/${id}/hold`, undefined, { idempotent: true });
    if (r.status !== 200 || r.body?.instanceId !== id || typeof r.body?.deployment !== "string")
      throw Object.assign(Error(`hold not acknowledged (${r.status}): ${r.body?.error ?? ""}`), { status: r.status });
    return r.body;
  }
  /** r5: non-destructive staged I/O fence (the manager answers a destructive hold itself if the instance is not staged). */
  async fence(id) {
    const r = await this.control.request("POST", `/protected/vms/${id}/fence`, undefined, { idempotent: true });
    if (r.status !== 200 || r.body?.instanceId !== id || typeof r.body?.deployment !== "string")
      throw Object.assign(Error(`fence not acknowledged (${r.status}): ${r.body?.error ?? ""}`), { status: r.status });
    return r.body;
  }
  async stop(id) {
    const r = await this.control.request("DELETE", `/vms/${id}`, undefined, { idempotent: true });
    if (r.status === 404) return { absent: true };
    if (r.status !== 200 || r.body?.ok !== true) throw Object.assign(Error(`stop not confirmed (${r.status}): ${r.body?.error ?? ""}`), { status: r.status });
    return { removed: true };
  }

  /**
   * Owned unknown stages, resolved ONLY from the exact authenticated operation outcome. Records of the deployment that
   * are not this node's exact bound instance are held (destructively). Returns the hold/cancel acknowledgments.
   */
  async resolveUnknown() {
    const out = [];
    for (const [dep, u] of [...this.unknownStages]) {
      try {
        if (!OP.test(String(u?.operation))) { out.push({ deployment: dep, kept: "obligation without an operation id: never discharged automatically" }); continue; }
        let o = await this.operation(u.operation);
        if (o.state === "unseen") o = await this.cancel(u.operation, dep);       // durable: the late signed request is refused forever
        if (o.deployment !== dep && o.deployment !== null) throw new GuestdControlError("protocol", "operation outcome names another deployment");
        if (o.state === "cancelled") { this.unknownStages.delete(dep); this.#save(); out.push({ deployment: dep, operation: u.operation, discharged: "cancelled before execution" }); continue; }
        if (o.state !== "executed" || !PP.test(String(o.instanceId))) { out.push({ deployment: dep, operation: u.operation, kept: o.state }); continue; }
        // executed: our own request created exactly this instance; bind it only with its MAC'd identity
        const v = await this.view(o.instanceId), p = v?.protected;
        if (v && p?.deployment === dep && p.instanceId === o.instanceId && !TERMINAL.has(p.state)) {
          this.staged.set(dep, { instanceId: o.instanceId, launchEpoch: p.launchEpoch, managerEpoch: p.managerEpoch, generation: p.generation, operation: u.operation });
          this.unknownStages.delete(dep); this.#save(); out.push({ deployment: dep, operation: u.operation, bound: o.instanceId });
        } else {
          const inv = await this.inventory(dep), rec = inv.instances.find((x) => x.id === o.instanceId);
          if (!rec || !isLive(rec)) { this.unknownStages.delete(dep); this.#save(); out.push({ deployment: dep, operation: u.operation, discharged: `executed instance ${o.instanceId} confirmed terminal and absent` }); }
          else out.push({ deployment: dep, operation: u.operation, kept: `executed instance ${o.instanceId} not yet confirmed absent` });
        }
      } catch (e) { this.onError(e); out.push({ deployment: dep, kept: e.message }); }
    }
    return out;
  }

  /**
   * The adapters R18 createIsolationLifecycleRuntime requires, bound to THIS client.
   * gate: the supervisor's own DeploymentPermitGate (the runtime's gate); collect: the owner-selected collector;
   * planOf(id) -> { body, stagingMs } from the node's isolation plan.
   */
  runtimeAdapters({ host, pins, gate, collect, planOf, startupDeadlineMs = 180_000 }) {
    if (!H32.test(host) || typeof collect !== "function" || typeof planOf !== "function" || !gate?.entries) throw Error("runtime adapters need host, gate, collector and plan source");
    const self = this, instanceOf = this.staged, carried = new Map();   // carried: deployment -> Map(digest -> exact signed envelope)
    const liveOf = async (id) => (await self.inventory(id)).instances.filter(isLive);
    const exactOne = async (id) => {
      if (self.unknownStages.has(id)) {
        await self.resolveUnknown();
        if (self.unknownStages.has(id)) throw fail("outcome-unknown", `an unknown stage of ${id} is still owned: absence is not established`);
      }
      const live = await liveOf(id);
      if (live.length > 1) throw fail("protocol", `${live.length} protected records for ${id}: ambiguous, nothing adopted`);
      const v = live[0] ?? null, known = instanceOf.get(id);
      if (v && known && known.instanceId !== v.id) throw fail("protocol", `protected record ${v.id} is not the instance this supervisor staged (${known.instanceId})`);
      if (v && !known) throw fail("protocol", `protected record ${v.id} was not staged by this supervisor: held, never adopted`);
      if (v && (v.protected.launchEpoch !== known.launchEpoch || v.protected.managerEpoch !== known.managerEpoch || v.protected.generation !== known.generation))
        throw fail("protocol", `protected record ${v.id} no longer carries the staged epochs/generation`);
      return v;
    };
    const client = {
      async findByName(id) {
        const v = await exactOne(id);
        if (!v && instanceOf.has(id)) { instanceOf.delete(id); self.#tryPersist(); }   // confirmed absent in a complete inventory
        return v ? { id: v.id, name: id, status: v.status, recovered: v.recovered === true, protected: v.protected } : null;
      },
      async spawn(body) {
        const id = body?.name, plan = planOf(id);
        const r = await self.stage({ deployment: id, stagingMs: plan.stagingMs, spawn: body });
        return { view: { id: r.instanceId, name: id, status: "starting", recovered: false } };
      },
      async remove(instance) {
        if (!PP.test(String(instance))) throw Error("protected runtime removes only exact protected ids");
        return self.stop(instance);   // the binding is dropped only when a complete inventory confirms absence (findByName)
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
      if (!carried.has(record.deployment)) carried.set(record.deployment, new Map());
      carried.get(record.deployment).set(digest, { envelope: structuredClone(envelope), digest, generation: record.generation, sequence: record.sequence,
        validUntilMs: record.validUntil * 1000, hostAuthority: record.hostAuthority?.digest ?? null });
      return envelope;
    }
    const boundaries = {
      async allow(id, grant) {
        const entry = gate.entries.get(id), byDigest = carried.get(id), c = entry ? byDigest?.get(entry.digest) : null, k = instanceOf.get(id);
        if (c) byDigest.delete(c.digest);                                   // consumed once; other renewals keep their own envelope
        if (!c || grant.generation !== c.generation || (grant.hostAuthority ?? null) !== c.hostAuthority || !(grant.validUntil <= c.validUntilMs) || !k)
          throw Error("no carried signed envelope bound to this verified grant");
        const v = await self.view(k.instanceId);
        const attachment = ProtectedIsolationClient.attachment(v, { permitDigest: c.digest, validUntil: grant.validUntil });
        if (attachment.launchEpoch !== k.launchEpoch || attachment.managerEpoch !== k.managerEpoch) throw Error("instance epoch changed since stage");
        const r = await self.permit(k.instanceId, c.envelope, attachment, { hostAuthority: c.hostAuthority });
        return { deployment: r.deployment, generation: r.generation, validUntil: r.validUntil, expiryEnforced: r.expiryEnforced === true,
          hostAuthority: r.hostAuthority, instanceId: k.instanceId, permitDigest: r.permitDigest };
      },
      async hold(id) {
        const k = instanceOf.get(id), live = await liveOf(id);
        if (!live.length && !self.unknownStages.has(id)) return { deployment: id, ingress: true, storage: true, secrets: true, basis: "no protected record for this deployment" };
        const acks = [];
        for (const v of live) {
          // r5: the exact never-served staged instance this node owns is FENCED (compute kept, absolute staging deadline);
          // the manager itself escalates to the destructive hold if it is not exactly that. Everything else is held.
          const own = k && v.id === k.instanceId && v.protected.serving !== true && ["staging", "staged"].includes(v.protected.state)
            && v.protected.launchEpoch === k.launchEpoch && v.protected.managerEpoch === k.managerEpoch;
          acks.push(own ? await self.fence(v.id) : await self.hold(v.id));
        }
        const all = (f) => acks.length > 0 && acks.every((a) => a[f] === true);
        return { deployment: id, ingress: all("ingress"), storage: all("storage"), secrets: all("secrets") && !self.unknownStages.has(id),
          instances: acks, staged: k?.instanceId ?? null };
      },
    };
    return { client, plans, readiness, collectPermit, boundaries, instanceOf };
  }
}
