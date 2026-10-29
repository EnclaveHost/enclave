// protected-isolation.mjs - the Windows node's client for the manager's PROTECTED routes (permit r3, SOURCE ONLY, NOT RUN).
//
// It speaks the EXISTING guestd-control/1 client (isolation/m4/guestd/control-client.mjs) unchanged: every request is
// MAC'd under one session and every answer's response MAC is verified against that same session. Nothing here is a new
// protocol or a test-only server.
//
// OUTCOMES. stage and permit change state, so they are NOT idempotent: a lost answer is outcome-UNKNOWN, never "did not
// run". stage reconciles by name (a pp instance named for the deployment IS the stage that ran) and an unknown stage is
// OWNED: the next sight of such an instance while not wanted is held. hold and DELETE only withdraw, so they are sent
// again safely (idempotent by direction).
//
// ATTACHMENT. Built ONLY from the MAC'd `protected` view (the manager's durable exact identity) plus the digest of the
// signed record and the node's own validUntil. The node never calls unsigned fields witness-signed.
//
// NOT YET WIRED into host.mjs (see REPORT-WINDOWS-PERMIT-R3.md, Stage 2).
import { GuestdControlError } from "../../isolation/m4/guestd/control-client.mjs";

export const STAGE_SCHEMA = "enclave-protected-stage/1";
export const ATTACHMENT_SCHEMA = "enclave-instance-permit-attachment/1";
const PP = /^pp[0-9a-f]{32}$/, H32 = /^0x[0-9a-f]{64}$/;

export class ProtectedIsolationClient {
  /** control: a GuestdControl for the manager's origin (pairing key from the node's owned key file) */
  constructor({ control, onError = () => {} }) {
    if (!control || typeof control.request !== "function") throw Error("a GuestdControl client is required");
    Object.assign(this, { control, onError });
    this.unknownStages = new Map();   // deployment -> reason: a stage whose outcome is unknown stays owned
  }

  async capability() {
    const r = await this.control.request("GET", "/health");
    if (r.status !== 200) return { available: false, reasons: [`health ${r.status}`] };
    const c = r.body?.permitEnforcement;
    return { available: c?.available === true && r.body?.supports?.permitEnforcement === true, reasons: c?.reasons ?? ["no permitEnforcement"],
      workloads: Array.isArray(c?.workloads) ? c.workloads : [], enforcementEpoch: c?.enforcementEpoch ?? null };
  }

  async #findStaged(deployment) {
    const r = await this.control.request("GET", "/vms");
    if (r.status !== 200 || !Array.isArray(r.body?.vms)) throw new GuestdControlError("protocol", `GET /vms answered ${r.status}: inventory unknown`);
    return r.body.vms.filter((v) => PP.test(String(v.id)) && v.name === deployment);
  }

  /** -> the manager's stage answer, or throws; an unknown outcome is recorded and owned. */
  async stage({ deployment, stagingMs, spawn }) {
    if (!H32.test(deployment)) throw Error("deployment must be a lowercase bytes32");
    try {
      const r = await this.control.request("POST", "/protected/vms", { schema: STAGE_SCHEMA, deployment, stagingMs, spawn }, {
        reconcile: async () => { const hit = await this.#findStaged(deployment); return hit.length ? { reconciled: true, instanceId: hit[0].id } : null; } });
      if (r.status === "reconciled") return { instanceId: r.body.instanceId, reconciled: true };
      if (r.status !== 202) throw Object.assign(Error(`stage refused (${r.status}): ${r.body?.error ?? ""}`), { status: r.status });
      this.unknownStages.delete(deployment);
      return r.body;
    } catch (e) {
      if (e?.mayHaveExecuted) this.unknownStages.set(deployment, e.message);
      throw e;
    }
  }

  async view(id) {
    if (!PP.test(id)) throw Error("not a protected instance id");
    const r = await this.control.request("GET", `/vms/${id}`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new GuestdControlError("protocol", `GET /vms/${id} answered ${r.status}: unknown`);
    return r.body;
  }

  /** The attachment from the MAC'd protected view only. permitDigest: hashTypedData of the signed record (node-computed). */
  static attachment(view, { permitDigest, validUntil }) {
    const p = view?.protected;
    if (!p || p.state !== "staged" && p.state !== "serving") throw Error(`instance is ${p?.state ?? "unknown"}: no attachment`);
    if (view.status !== "running" || view.recovered) throw Error("instance is not readiness-verified");
    if (!H32.test(permitDigest) || !Number.isSafeInteger(validUntil)) throw Error("permit digest and validUntil (ms) required");
    return { schema: ATTACHMENT_SCHEMA, instanceId: p.instanceId, vmId: p.vmId, managerEpoch: p.managerEpoch, launchEpoch: p.launchEpoch,
      deployment: p.deployment, generation: p.generation, appId: p.appId, runtimeId: p.runtimeId, image: p.image, permitDigest, validUntil };
  }

  /** Attach a verified serving permit; an unknown outcome is reconciled from the MAC'd view, never assumed. */
  async permit(id, envelope, attachment) {
    const r = await this.control.request("POST", `/protected/vms/${id}/permit`, { envelope, attachment }, {
      reconcile: async () => { const v = await this.view(id); return v?.protected?.permitDigest === attachment.permitDigest ? { reconciled: true, view: v.protected } : null; } });
    if (r.status === "reconciled") return { serving: true, reconciled: true, validUntil: r.body.view.validUntil };
    if (r.status !== 200) throw Object.assign(Error(`permit refused (${r.status}): ${r.body?.error ?? ""}`), { status: r.status });
    if (r.body?.permitDigest !== attachment.permitDigest || r.body?.instanceId !== id || r.body?.expiryEnforced !== true) throw Error("permit answer does not bind this instance and digest");
    return { serving: true, ...r.body };
  }

  /** Withdrawal: the manager's truthful acknowledgment, verbatim (ingress/storage/secrets/boundaries, compute pending). */
  async hold(id) {
    const r = await this.control.request("POST", `/protected/vms/${id}/hold`, undefined, { idempotent: true });
    if (r.status !== 200) throw Object.assign(Error(`hold not acknowledged (${r.status}): ${r.body?.error ?? ""}`), { status: r.status });
    return r.body;
  }
  async stop(id) {
    const r = await this.control.request("DELETE", `/vms/${id}`, undefined, { idempotent: true });
    if (r.status === 404) return { absent: true };
    if (r.status !== 200) throw Object.assign(Error(`stop not confirmed (${r.status}): ${r.body?.error ?? ""}`), { status: r.status });
    return { removed: true };
  }

  /** Owned unknown stages: any pp instance named for such a deployment that is not wanted is held now. */
  async resolveUnknown(wanted = () => false) {
    const out = [];
    for (const dep of [...this.unknownStages.keys()]) {
      try {
        const hits = await this.#findStaged(dep);
        for (const v of hits) if (!wanted(dep, v.id)) out.push(await this.hold(v.id).catch((e) => ({ error: e.message, instanceId: v.id })));
        if (hits.length || !wanted(dep, null)) this.unknownStages.delete(dep);
      } catch (e) { this.onError(e); }
    }
    return out;
  }
}
