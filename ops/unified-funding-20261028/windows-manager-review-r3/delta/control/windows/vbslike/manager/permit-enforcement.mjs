/* ============================================================
   CONTINUING PER-APP AUTHORIZATION for the Windows manager (permit r3, SOURCE ONLY - authored, not run).

   OPT-IN IS NEVER A REQUEST FIELD. A legacy POST /vms keeps its installed semantics (and is refused if it carries
   any enforcement-shaped field or a protected-namespace id: protected-manager.mjs). A protected instance exists
   only through POST /protected/vms over guestd-control/1 (MAC'd request AND response, this manager's instance,
   replay window), and only when this manager's OWN authenticated authority reader says, at a qualified block:
   the deployment is QUEUED for exactly this pinned host, the host is admitted, and its canonical host authority
   is Online. That read is the owner/operator authority; the control channel is only who may ask.

   ENFORCEMENT OWNER. Each serving permit is verified HERE by the real r18 DeploymentPermitGate (typed v2
   signatures, owner-selected witness quorum, generation/sequence/denial floors in this manager's durable journal,
   exact host authority incl. host generation/owner revision/digest, wall AND monotonic deadlines). The signed v2
   bytes name no VM, so they are bound to one instance by a SEPARATE attachment (ATTACHMENT_SCHEMA) whose every
   field must equal this manager's durable mapping: instance id, VM GUID, manager epoch, launch epoch, deployment,
   generation, app id, runtime id, image, and the digest of exactly the signed record. Nothing unsigned is called
   witness-signed: the attachment is authenticated by the control channel and checked against durable state AND
   against the trusted in-memory mapping recorded at stage/bind (r3).
   App generation (the permit's), host generation (inside its host authority) and manager/launch epochs are
   separate fields and are never compared with each other.

   DEADLINES. The gate's effective deadline is min(permit validUntil - skew, authority window) in WALL ms plus a
   MONOTONIC deadline set at acceptance; the attachment may only shorten it (validUntil from the caller's own
   gate). Seconds: the signed record (issuedAt/validUntil). Milliseconds: everything here and on the wire to
   the guard. Re-sending the same envelope cannot extend (the gate keeps the old monotonic deadline; the guard
   refuses a renew with the same digest).
   r3: both absolute deadlines are fixed BEFORE every durable write and guard call and re-checked after each
   await and immediately before acknowledging (stage and permit): a slow flush or a slow guard reply consumes
   the lifetime, it never resets it, and an already-passed deadline is never acknowledged.

   WITHDRAWAL ORDER on expiry/revocation/Offline/owner loss/guard loss: synchronously drop the serving entry, close
   the instance's data-plane splices and every registered workload boundary (new streams are refused because the
   data-plane lookup re-asserts the gate on every admission), ask the guard's independent exact removal, THEN
   start the manager's own exact compute removal. Removal is "done" only when a real backend survey no longer
   lists the exact identity AND that is durably recorded; failures stay recorded and are retried.
   r3 (root race 3, executed FAIL in r2): the guard request, the ingress/boundary close and the retry ownership no
   longer depend on the journal: a journal read/write/flush fault is recorded as UNKNOWN (never as absence), the
   trusted in-memory exact mapping (instance id -> deployment, VM GUID) recorded at stage/bind time is used, and
   nothing is invented or broadened. If the guard is unavailable AND the installed removal or raw launch is hung,
   an INDEPENDENT exact compute remover (the launcher's CMD.removeById by exact GUID whose Notes identity is this
   instance) is used; polling the same hung promise is not removal. Late raw operations stay owned.

   WORKLOAD BOUNDARIES (r3). Every protected workload path (desktop/graphics, GPU, worker transport, egress, V6/V7
   secret release, storage/volumes, published ports, command socket) obtains access ONLY through boundary(), which
   asserts the instance's CURRENT grant (or, for a declared staging boot need, the finite authenticated staging
   window) and registers a close callback. Withdrawal closes every boundary synchronously first and reports per
   boundary what happened (closed / failed / pending); a disclosed secret is reported as disclosed, never "erased".
   A workload kind is admitted at stage() only when its adapter has been composed by the entry (adapters map);
   otherwise it is REFUSED (safe interim, UNFINISHED migration - see REPORT-WINDOWS-PERMIT-R3.md).
   ============================================================ */
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { hashTypedData } from "viem";
import { DeploymentPermitGate } from "../../../network/deployment-permit-gate.mjs";
import { servingPermitTypedData, MAX_AUTHORITY_AGE_SEC, CLOCK_SKEW_SEC } from "../../../network/deployment-serving-permit.mjs";
import { isHostAuthorityPermit, validateHostAuthorityContext } from "../../../network/deployment-host-authority.mjs";
import { parseNotes } from "./wmi-launcher.mjs";
import { PROTECTED_ID } from "./permit-journal.mjs";

export const CONFIG_SCHEMA = "enclave-permit-enforcement/1";
export const STAGE_SCHEMA = "enclave-protected-stage/1";
export const ATTACHMENT_SCHEMA = "enclave-instance-permit-attachment/1";
export const PRODUCTION_AUTHORITY = "production-derived-finality";
export const TEST_QUALIFICATION = "TEST-ONLY-NOT-WINDOWS";
/** r3: every protected workload boundary kind; each needs a composed adapter before stage() admits it. */
export const WORKLOAD_KINDS = Object.freeze(["ingress", "desktop", "gpu", "worker", "egress", "secrets", "volumes", "ports", "command"]);
/** boundaries a desktop boot may need BEFORE its Running permit (finite, authenticated staging only) */
const STAGING_BOUNDARIES = new Set(["desktop", "gpu", "worker"]);
const H32 = /^0x[0-9a-f]{64}$/, A20 = /^0x[0-9a-f]{40}$/, GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROTECTED_DERIVATIONS = new Set(["enclave-catalog-bundle/1", "enclave-catalog-bundle/5"]);
const TERMINAL = new Set(["removed", "refused"]);
const exact = (o, keys) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const fail = (status, message) => Object.assign(new Error(message), { status });
const hex = (n) => crypto.randomBytes(n).toString("hex");
const PENDING = Symbol("pending");
const JOURNAL_UNKNOWN = Symbol("journal-unknown");

/** The reviewed configuration: exact keys, v2 pins only, this host, bounded staging. r3: optional `workloads`. */
export function validateEnforcementConfig(c) {
  const keys = ["schema", "pins", "host", "maxStagingMs", "derivations", "qualification", "retryMs"];
  if (!(exact(c, keys) || exact(c, [...keys, "workloads"])) || c.schema !== CONFIG_SCHEMA) throw Error("permit enforcement config has unknown or missing fields");
  if (!isHostAuthorityPermit(c.pins) || !A20.test(String(c.pins.lifecycle).toLowerCase())) throw Error("permit enforcement requires exact v2 host-authority pins");
  if (!H32.test(c.host)) throw Error("permit enforcement host must be a lowercase bytes32");
  if (!Number.isSafeInteger(c.maxStagingMs) || c.maxStagingMs < 1000 || c.maxStagingMs > 600_000) throw Error("maxStagingMs must be 1000..600000");
  if (!Array.isArray(c.derivations) || !c.derivations.length || c.derivations.some((d) => !PROTECTED_DERIVATIONS.has(d))) throw Error("protected derivations are limited to /1 and /5 in r1");
  if (!["production", TEST_QUALIFICATION].includes(c.qualification)) throw Error("unknown qualification");
  if (!Number.isSafeInteger(c.retryMs) || c.retryMs < 100 || c.retryMs > 60_000) throw Error("retryMs must be 100..60000");
  if (Object.hasOwn(c, "workloads") && (!Array.isArray(c.workloads) || new Set(c.workloads).size !== c.workloads.length
      || c.workloads.some((w) => !WORKLOAD_KINDS.includes(w) || w === "ingress"))) throw Error("workloads must be distinct non-ingress WORKLOAD_KINDS");
  return Object.freeze(structuredClone({ workloads: [], ...c }));
}

/** The workload kinds a stage request needs (derived from the exact launch spec, never from a request flag). */
export function workloadsOf(spawn) {
  const need = new Set();
  if (spawn.hasSecrets !== false) need.add("secrets");
  if (Number(spawn.gpuShare) > 0 || Number(spawn.gpuMilli) > 0) need.add("gpu");
  if ((spawn.volumes || []).length) need.add("volumes");
  if ((spawn.firewall || []).length || (spawn.ports || []).length) need.add("ports");
  if (spawn.derive?.http) need.add("command");
  if (spawn.desktop || spawn.derive?.desktop) { need.add("desktop"); need.add("worker"); }
  if (spawn.egress || spawn.derive?.egress) need.add("egress");
  return [...need];
}

export class PermitEnforcement {
  /**
   * manager: ProtectedManager; journal: openPermitJournal(owned log); guard: GuardClient | null;
   * authority: { qualification, read(deployment) -> servingContextOf(...) shape } | null
   * dataPlane: { closeInstance(id, why) } | null
   * computeRemover (r3): { survey(), removeById(vmId) -> {found, removed} } independent of the manager's installed
   *   removal (production: guard-main windowsBackend over its own bounded PowerShell runner) | null
   * adapters (r3): { [kind]: { admit(instanceId, spawn) -> void } } composed workload boundary adapters
   */
  constructor({ config, manager, journal, guard = null, authority = null, dataPlane = null, computeRemover = null, adapters = {},
                now = Date.now, monotonic = () => performance.now(), timers = { set: setTimeout, clear: clearTimeout }, onError = () => {} }) {
    this.config = validateEnforcementConfig(config);
    Object.assign(this, { manager, journal, guard, authority, dataPlane, computeRemover, adapters, now, monotonic, timers, onError });
    this.gate = new DeploymentPermitGate({ pins: this.config.pins, journal, now, monotonic, timers, onError, hostAuthority: journal.hostAuthority });
    this.serving = new Map();       // instanceId -> { deployment, generation, hostAuthority, until, monoDeadline, digest, release, timer }
    this.spawns = new Map();        // instanceId -> the raw spawn promise (owned until settled, beyond any HTTP call)
    this.removals = new Map();      // instanceId -> in-flight removal
    this.removeCalls = new Map();   // instanceId -> the installed removeRecord() promise (owned until settled, r2)
    this.ingress = new Map();       // instanceId -> { closed: boolean, error } of the LAST data-plane close (r2)
    this.staging = new Map();       // instanceId -> { timer, wallUntil, monoDeadline }
    this.tails = new Map();         // deployment -> serialization tail
    this.known = new Map();         // r3: instanceId -> { deployment, vmId, terminal, workloads } trusted exact mapping (outlives a journal fault)
    this.boundaries = new Map();    // r3: instanceId -> Map(handle -> { kind, close })
    this.acks = new Map();          // r3: instanceId -> [{ kind, state, error }] of the LAST withdrawal
    this.guardReady = false; this.guardLost = guard ? null : "no guard configured";
    if (guard) guard.onLost((why) => this.#guardLost(why));
  }

  // ---- capability: true only when the whole selected path is present ----
  capability() {
    const reasons = [];
    try { this.journal.assertLive(); } catch (e) { reasons.push(`journal: ${e.message}`); }
    if (this.config.qualification === "production" && this.journal.exclusion !== "windows-exlock") reasons.push("journal exclusion is not the Windows share-mode-0 handle");
    if (!this.authority) reasons.push("no authenticated authority reader is composed (see authority-chain-reader.mjs for the exact missing inputs)");
    else if (this.config.qualification === "production" && this.authority.qualification !== PRODUCTION_AUTHORITY) reasons.push(`authority reader is ${this.authority.qualification}, not ${PRODUCTION_AUTHORITY}`);
    else if (this.config.qualification !== "production" && this.authority.qualification !== "TEST") reasons.push("TEST configuration requires a TEST-labelled authority");
    if (this.guardLost) reasons.push(`guard unavailable: ${this.guardLost}`);
    else if (!this.guardReady) reasons.push("guard readiness not verified");
    if (!this.dataPlane) reasons.push("no data plane to withdraw");
    if (this.gate.closed) reasons.push("permit gate closed");
    if (this.gate.withdrawalFailures().length) reasons.push("a previous withdrawal is unconfirmed");
    try { if (this.journal.instances().some((r) => ["unknown", "remove-failed", "removing"].includes(r.state))) reasons.push("a protected instance's removal is not yet confirmed"); }
    catch (e) { reasons.push(`journal unreadable: ${e.message}`); }
    for (const w of this.config.workloads) if (typeof this.adapters?.[w]?.admit !== "function") reasons.push(`workload ${w} configured without its composed boundary adapter`);
    return { available: reasons.length === 0, reasons, qualification: this.config.qualification,
      workloads: this.config.workloads.filter((w) => typeof this.adapters?.[w]?.admit === "function"),
      ...(reasons.length === 0 ? { enforcementEpoch: this.#epoch() } : {}) };
  }
  #epoch() { return { managerEpoch: this.manager.epoch, journalOwner: this.journal.ownerId, guard: this.guard?.guard ?? null }; }
  #require() { const c = this.capability(); if (!c.available) throw fail(503, `protected enforcement unavailable: ${c.reasons.join("; ")}`); }

  /** Verify the guard's own readiness (journal owned, started) - a connected pipe is not readiness. */
  async verifyGuard() {
    if (!this.guard || this.guardLost) { this.guardReady = false; return false; }
    try {
      const s = await this.guard.call("status");
      const want = this.config.qualification === "production" ? "windows-exlock" : "TEST-in-process";
      this.guardReady = s?.ready === true && s.exclusion === want && typeof s.owner === "string" && Array.isArray(s.failures) && s.failures.length === 0
        && (!Array.isArray(s.unguarded) || s.unguarded.length === 0);
    } catch { this.guardReady = false; }
    return this.guardReady;
  }
  #guardLost(why) {
    this.guardLost = why; this.guardReady = false;
    for (const id of this.#activeIds()) this.withdraw(id, `guard unavailable: ${why}`);
  }
  /** r3: active ids from the journal AND the trusted in-memory mapping (a journal fault never hides a live instance). */
  #activeIds() {
    const ids = new Set([...this.serving.keys(), ...this.staging.keys(), ...this.spawns.keys()]);
    for (const [id, k] of this.known) if (!k.terminal) ids.add(id);
    try { for (const r of this.journal.instances()) if (!TERMINAL.has(r.state)) ids.add(r.instanceId); } catch (e) { this.onError(e); }
    return [...ids];
  }
  #readInst(id) { try { return this.journal.instance(id); } catch (e) { this.onError(e); return JOURNAL_UNKNOWN; } }
  #left(wallUntil, monoDeadline) { return Math.min(wallUntil - this.now(), monoDeadline - this.monotonic()); }
  async #serial(key, fn) {
    const prev = this.tails.get(key) ?? Promise.resolve(); let done;
    const tail = new Promise((r) => { done = r; }); this.tails.set(key, tail);
    await prev.catch(() => {});
    try { return await fn(); } finally { done(); if (this.tails.get(key) === tail) this.tails.delete(key); }
  }

  // ---- staging: authenticated, bounded, owned before any spawn ----
  async stage(req) {
    if (!exact(req, ["schema", "deployment", "stagingMs", "spawn"]) || req.schema !== STAGE_SCHEMA) throw fail(400, "protected stage request has unknown or missing fields");
    const { deployment, stagingMs, spawn } = req;
    if (!H32.test(deployment || "")) throw fail(400, "deployment must be a lowercase bytes32");
    if (!Number.isSafeInteger(stagingMs) || stagingMs < 1000) throw fail(400, "stagingMs must be an explicit integer >= 1000");
    if (!spawn || typeof spawn !== "object" || Array.isArray(spawn) || spawn.name !== deployment || "id" in spawn) throw fail(400, "protected spawn must name the deployment and carry no id");
    if (!this.config.derivations.includes(spawn.derive?.derivation)) throw fail(400, "derivation is not admitted for protected enforcement in r1");
    // r3: a workload is admitted only through its COMPOSED boundary adapter; anything else stays refused (unfinished, not accepted)
    const workloads = workloadsOf(spawn);
    const missing = workloads.filter((w) => !this.config.workloads.includes(w) || typeof this.adapters?.[w]?.admit !== "function");
    if (missing.length) throw fail(400, `protected r1 admits no secrets, GPU, volumes, ports or command sockets without composed boundaries: ${missing.join(", ")} (refused; migration unfinished)`);
    return this.#serial(deployment, async () => {
      this.#require();
      if (this.journal.activeFor(deployment).length) throw fail(409, "a protected instance for this deployment is already live or unconfirmed");
      const ctx = await this.authority.read(deployment);
      this.#require();                                                  // nothing changed while the reader answered
      const a = ctx?.assignment, nowSec = Math.floor(this.now() / 1000);
      if (!a || a.deployment?.toLowerCase() !== deployment || a.host?.toLowerCase() !== this.config.host || a.state !== "queued")
        throw fail(403, "authority does not show this deployment queued for this host");
      if (a.proofVerified !== true || !["safe", "finalized", "l1-finalized-derived"].includes(a.authorityTier) || a.admitted !== true || a.funded !== true)
        throw fail(403, "unqualified, unadmitted or unfunded assignment authority");
      if (!Number.isSafeInteger(a.observedAt) || a.observedAt > nowSec + CLOCK_SKEW_SEC || nowSec - a.observedAt > MAX_AUTHORITY_AGE_SEC) throw fail(403, "stale assignment authority");
      const e = ctx.hostAuthority;
      if (ctx.hostAdmitted !== true || e?.proofVerified !== true || e.status !== "online" || String(e.blockHash) !== String(a.blockHash || "").toLowerCase())
        throw fail(403, "host is not admitted with Online canonical authority at the assignment's block");
      const hc = validateHostAuthorityContext(e.context);
      if (hc.hostId !== this.config.host) throw fail(403, "host authority names another host");
      // the durable fresh-queued handoff to the CURRENT host authority (r18 gate), before anything is started
      try { this.gate.handoffHostAuthority(deployment, hc, { kind: "fresh-queued-start" }); } catch (x) { throw fail(409, `host authority handoff refused: ${x.message}`); }
      for (const w of workloads) this.adapters[w].admit(null, spawn);    // adapter pre-check (throws to refuse) before anything durable
      const ms = Math.min(this.config.maxStagingMs, stagingMs);
      // r3: the ABSOLUTE staging deadlines are fixed here, before the durable intent and the guard registration
      const instanceId = "pp" + hex(16), launchEpoch = hex(16), wallUntil = this.now() + ms, monoDeadline = this.monotonic() + ms;
      const rec = { instanceId, deployment, generation: a.generation + 1, launchEpoch, managerEpoch: this.manager.epoch, state: "staging",
        stagingWallUntil: wallUntil, vmId: null, appId: null, runtimeId: null, image: null, recordSha256: null, permit: null,
        reason: null, error: null, at: this.now() };
      this.known.set(instanceId, { deployment, vmId: null, terminal: false, workloads });
      try { this.journal.putInstance(rec, { admission: true }); }       // durable intent BEFORE the guard and the spawn
      catch (x) { this.known.get(instanceId).terminal = true; throw fail(503, `durable staging intent refused; nothing was started: ${x.message}`); }
      const refuse = (why) => {
        // r2: a registration reply lost/refused is NOT proof that nothing is armed at the guard; nothing was spawned,
        // so `refused` is accurate for compute here, and the guard owns any record it may have written.
        this.guard.call("withdraw", { instanceId, reason: why }).catch(() => {});
        try { this.journal.putInstance({ ...rec, state: "refused", reason: why, at: this.now() }); } catch (j) { this.onError(j); }
        const k = this.known.get(instanceId); if (k) k.terminal = true;
      };
      try { await this.guard.call("register", { instanceId, deployment, appId: null, launchEpoch, wallUntil, remainingMs: Math.floor(this.#left(wallUntil, monoDeadline)), kind: "staging" }); }
      catch (x) { refuse(`guard registration failed before any spawn: ${x.message}`); throw fail(503, `guard registration failed; nothing was started: ${x.message}`); }
      if (!(this.#left(wallUntil, monoDeadline) > 0)) { refuse("staging deadline passed during guard registration"); throw fail(503, "staging deadline passed during registration; nothing was started"); }
      this.gate.stage(deployment, () => this.withdraw(instanceId, "permit owner closed while staged"));
      const st = { timer: null, wallUntil, monoDeadline };
      const timer = () => {
        if (this.staging.get(instanceId) !== st) return;
        const left = this.#left(wallUntil, monoDeadline);
        if (left > 0) { st.timer = this.timers.set(timer, Math.ceil(left)); st.timer?.unref?.(); return; }
        const cur = this.#readInst(instanceId);
        if (cur === JOURNAL_UNKNOWN || (cur && ["staging", "staged"].includes(cur.state))) this.withdraw(instanceId, "staging deadline passed without a verified serving permit");
      };
      st.timer = this.timers.set(timer, Math.ceil(this.#left(wallUntil, monoDeadline))); st.timer?.unref?.(); this.staging.set(instanceId, st);
      // The raw spawn is OWNED here, beyond this HTTP call: its late completion is bound or removed, never forgotten.
      let p;
      try { p = Promise.resolve(this.manager.spawnProtectedInternal({ ...structuredClone(spawn), id: instanceId })); } catch (x) { p = Promise.reject(x); }
      this.spawns.set(instanceId, p);
      p.then((view) => this.#spawned(instanceId, view), (x) => this.#spawnThrew(instanceId, x)).catch((x) => this.onError(x));
      return { instanceId, deployment, generation: rec.generation, launchEpoch, managerEpoch: this.manager.epoch,
        stagingWallUntil: wallUntil, serving: false, workloads, enforcementEpoch: this.#epoch() };
    });
  }
  async #spawned(id, view) {
    this.spawns.delete(id);
    const cur = this.#readInst(id), mrec = this.manager.domains.get(id);
    const vmId = String(mrec?.handle?.vmId || "").toLowerCase();
    if (GUID.test(vmId) && this.known.has(id) && !this.known.get(id).vmId) this.known.get(id).vmId = vmId;   // trusted exact mapping, before any journal write
    if (cur === JOURNAL_UNKNOWN) return this.withdraw(id, "journal unreadable when the launch completed");
    if (!cur || cur.state !== "staging" || !mrec || view?.status === "failed" || !GUID.test(vmId)) {
      return this.withdraw(id, cur?.state !== "staging" ? "withdrawn before the launch completed (late completion removed)" : `launch did not stage: ${view?.reason || "no VM GUID"}`);
    }
    const st = this.staging.get(id);
    if (!st || !(this.#left(st.wallUntil, st.monoDeadline) > 0)) return this.withdraw(id, "staging deadline passed before the launch completed");
    try { this.journal.putInstance({ ...cur, state: "staged", vmId, appId: mrec.appId, runtimeId: mrec.runtimeId, image: mrec.image ?? null, recordSha256: mrec.recordSha256 ?? null, at: this.now() }); }
    catch (x) { return this.withdraw(id, `staged mapping not durable: ${x.message}`); }
    try { await this.guard.call("bindVm", { instanceId: id, vmId }); }
    catch (x) { return this.withdraw(id, `guard could not bind the VM GUID: ${x.message}`); }
  }
  #spawnThrew(id, x) {
    this.spawns.delete(id);
    // Manager.spawn throws only before it records a domain; a record that exists still owns cleanup.
    return this.withdraw(id, `spawn refused: ${x?.message ?? x}`);
  }

  // ---- serving permit: verified here, bound to this exact instance ----
  async permit(instanceId, req) {
    if (!PROTECTED_ID.test(instanceId)) throw fail(404, "not a protected instance id");
    if (!exact(req, ["envelope", "attachment"]) || !exact(req.envelope, ["record", "signatures"])) throw fail(400, "permit request has unknown or missing fields");
    const at = req.attachment, keys = ["schema", "instanceId", "vmId", "managerEpoch", "launchEpoch", "deployment", "generation", "appId", "runtimeId", "image", "permitDigest", "validUntil"];
    if (!exact(at, keys) || at.schema !== ATTACHMENT_SCHEMA) throw fail(400, "attachment has unknown or missing fields");
    let digest;
    try { digest = hashTypedData(servingPermitTypedData(this.config.pins, req.envelope.record)); } catch (x) { throw fail(400, `invalid permit record: ${x.message}`); }
    const rec0 = this.journal.instance(instanceId);
    if (!rec0) throw fail(404, "unknown protected instance");
    return this.#serial(rec0.deployment, async () => {
      this.#require();
      const rec = this.journal.instance(instanceId), m = this.manager.domains.get(instanceId), r = req.envelope.record;
      if (!rec || !["staged", "serving"].includes(rec.state)) throw fail(409, `protected instance is ${rec?.state ?? "unknown"}`);
      if (!m || m.launching || m.status !== "running" || m.recovered) throw fail(409, "instance is not readiness-verified under this manager");
      const want = { instanceId, vmId: rec.vmId, managerEpoch: this.manager.epoch, launchEpoch: rec.launchEpoch, deployment: rec.deployment,
        generation: rec.generation, appId: m.appId, runtimeId: m.runtimeId, image: m.image ?? null, permitDigest: digest };
      for (const [k, v] of Object.entries(want)) if ((k === "vmId" ? String(at[k]).toLowerCase() : at[k]) !== v) throw fail(403, `attachment ${k} does not match this instance`);
      if (rec.appId !== m.appId || rec.runtimeId !== m.runtimeId || String(m.handle?.vmId || "").toLowerCase() !== rec.vmId || (rec.image ?? null) !== (m.image ?? null))
        throw fail(409, "durable mapping differs from the live record");
      const k = this.known.get(instanceId);
      if (!k || k.terminal || k.deployment !== rec.deployment || k.vmId !== rec.vmId) throw fail(409, "durable mapping differs from the trusted mapping recorded at stage/bind");
      if (r.deployment !== rec.deployment || r.generation !== rec.generation || r.host !== this.config.host) throw fail(403, "permit is for another deployment, generation or host");
      if (!Number.isSafeInteger(at.validUntil)) throw fail(400, "attachment validUntil (ms) required");
      if (rec.permit && Number.isSafeInteger(r.sequence) && r.sequence < rec.permit.sequence) throw fail(403, "permit sequence below this instance's accepted permit");
      const ctx = await this.authority.read(rec.deployment);           // this manager's OWN authenticated reader
      let grant;
      try { grant = await this.gate.install(req.envelope, ctx); } catch (x) { if (rec.state === "serving") this.withdraw(instanceId, `newer permit refused: ${x.message}`); throw fail(403, `serving permit refused: ${x.message}`); }
      const entry = this.gate.entries.get(rec.deployment);
      const after = this.journal.instance(instanceId);
      if (!entry || entry.digest !== digest || !after || !["staged", "serving"].includes(after.state) || this.manager.domains.get(instanceId) !== m || this.guardLost) {
        this.gate.hold(rec.deployment, "instance changed while its permit was verified");
        throw fail(409, "instance changed while its permit was verified");
      }
      const old = this.serving.get(instanceId);
      // r3: ABSOLUTE wall and monotonic deadlines fixed here, BEFORE the durable write and the guard renewal
      const until = Math.min(entry.until, at.validUntil, old?.digest === digest ? old.until : Infinity);
      const monoDeadline = Math.min(entry.deadline, this.monotonic() + (until - this.now()), old?.digest === digest ? old.monoDeadline : Infinity);
      const expired = (why) => { this.gate.hold(rec.deployment, why); return fail(403, why); };
      if (!(this.#left(until, monoDeadline) > 0)) throw expired("effective deadline already passed");
      if (old?.digest !== digest) {
        try { this.journal.putInstance({ ...after, state: "serving", permit: { digest, sequence: r.sequence, wallUntil: until }, at: this.now() }); }
        catch (x) { this.gate.hold(rec.deployment, "serving record not durable"); this.withdraw(instanceId, `serving record not durable: ${x.message}`); throw fail(503, `serving record not durable: ${x.message}`); }
        if (!(this.#left(until, monoDeadline) > 0)) { this.withdraw(instanceId, "effective deadline passed during the durable write"); throw expired("effective deadline passed during the durable write"); }
        try { await this.guard.call("renew", { instanceId, permitDigest: digest, wallUntil: until, remainingMs: Math.floor(this.#left(until, monoDeadline)) }); }
        catch (x) { this.gate.hold(rec.deployment, "guard did not accept the deadline"); this.withdraw(instanceId, `guard did not accept the deadline: ${x.message}`); throw fail(503, `guard did not accept the deadline: ${x.message}`); }
        const cur = this.#readInst(instanceId);
        if (cur === JOURNAL_UNKNOWN || cur?.state !== "serving") throw fail(409, "withdrawn (or journal unknown) while the guard was renewed");
      }
      if (!(this.#left(until, monoDeadline) > 0) || this.gate.entries.get(rec.deployment) !== entry || this.guardLost) {
        this.withdraw(instanceId, "effective deadline passed or grant changed before acknowledgment");
        throw expired("effective deadline passed or grant changed before acknowledgment");
      }
      const binding = { host: this.config.host, generation: grant.generation, hostAuthority: grant.hostAuthority };
      if (old) { this.timers.clear(old.timer); old.release?.(); }
      const s = { deployment: rec.deployment, binding, until, monoDeadline, digest, release: null, timer: null };
      s.release = this.gate.track(rec.deployment, binding, (why) => this.withdraw(instanceId, why));
      const tick = () => {
        if (this.serving.get(instanceId) !== s) return;
        const left = this.#left(s.until, s.monoDeadline);
        if (left > 0) { s.timer = this.timers.set(tick, Math.ceil(left)); s.timer?.unref?.(); } else this.gate.hold(rec.deployment, "effective deadline passed");
      };
      s.timer = this.timers.set(tick, Math.ceil(this.#left(until, monoDeadline))); s.timer?.unref?.();
      this.serving.set(instanceId, s);
      this.gate.unstage(rec.deployment);
      const st = this.staging.get(instanceId); if (st) { this.timers.clear(st.timer); this.staging.delete(instanceId); }
      return { deployment: rec.deployment, generation: grant.generation, validUntil: until, hostAuthority: grant.hostAuthority, expiryEnforced: true,
        instanceId, vmId: rec.vmId, appId: m.appId, runtimeId: m.runtimeId, image: m.image ?? null, permitDigest: digest,
        qualification: this.config.qualification, enforcementEpoch: this.#epoch() };
    });
  }

  /** Data-plane admission: legacy ids unchanged; a protected id is admitted only under a current, asserted grant. */
  dataView(id, view) {
    if (!PROTECTED_ID.test(String(id))) return view;
    const s = this.serving.get(id);
    if (!s || !view || this.guardLost) return null;
    try { this.gate.assert(s.deployment, s.binding); } catch { return null; }
    if (!(this.#left(s.until, s.monoDeadline) > 0)) { this.gate.hold(s.deployment, "effective deadline passed"); return null; }
    return view;
  }

  /**
   * r3 WORKLOAD BOUNDARY. The ONLY way a protected instance obtains desktop/GPU/worker/egress/secret/volume/port/command
   * access. Asserts the CURRENT grant (or, for a desktop boot need, the finite authenticated staging window) and
   * registers `close` so withdrawal closes it synchronously. Returns { release() } for a normal close by the caller.
   * Legacy ids never reach here (their callers keep installed semantics).
   */
  boundary(instanceId, kind, close) {
    if (!PROTECTED_ID.test(String(instanceId))) throw fail(400, "boundary() is for protected instances only");
    if (!WORKLOAD_KINDS.includes(kind) || typeof close !== "function") throw fail(400, "unknown boundary kind or no close callback");
    const k = this.known.get(instanceId);
    if (!k || k.terminal || (kind !== "ingress" && !k.workloads.includes(kind))) throw fail(403, `boundary ${kind} was not admitted for this instance at stage`);
    if (this.guardLost) throw fail(503, "guard unavailable: no protected access");
    const s = this.serving.get(instanceId);
    let until;
    if (s) {
      try { this.gate.assert(s.deployment, s.binding); } catch { throw fail(403, "no current serving permit"); }
      if (!(this.#left(s.until, s.monoDeadline) > 0)) { this.gate.hold(s.deployment, "effective deadline passed"); throw fail(403, "effective deadline passed"); }
      until = s.until;
    } else {
      const st = this.staging.get(instanceId);
      if (!st || !STAGING_BOUNDARIES.has(kind) || !(this.#left(st.wallUntil, st.monoDeadline) > 0)) throw fail(403, `boundary ${kind} requires a verified Running permit`);
      until = st.wallUntil;
    }
    const map = this.boundaries.get(instanceId) ?? new Map(); this.boundaries.set(instanceId, map);
    const h = {}; map.set(h, { kind, close });
    return { release: () => { map.delete(h); }, until };
  }
  /** r3: closes every registered boundary NOW; records closed / failed / pending (a returned promise) per boundary. */
  #closeBoundaries(id, why) {
    const map = this.boundaries.get(id); this.boundaries.delete(id);
    const out = [];
    for (const b of map?.values() ?? []) {
      try {
        const r = b.close(why);
        if (r && typeof r.then === "function") {
          const ack = { kind: b.kind, state: "pending", error: null }; out.push(ack);
          r.then(() => { ack.state = "closed"; }, (e) => { ack.state = "failed"; ack.error = String(e?.message ?? e); this.onError(e); });
        } else out.push({ kind: b.kind, state: "closed", error: null });
      } catch (e) { out.push({ kind: b.kind, state: "failed", error: String(e?.message ?? e) }); this.onError(e); }
    }
    if (out.length || !this.acks.has(id)) this.acks.set(id, [...(this.acks.get(id) ?? []).filter((a) => a.state !== "closed"), ...out]);
    return out;
  }

  /** The MAC'd protected view: durable state plus the exact identity a controller binds its attachment to (r3). */
  viewOf(id) {
    const r = this.#readInst(id);
    const s = this.serving.get(id);
    if (r === JOURNAL_UNKNOWN) return { state: "unknown", serving: false, reason: "journal unreadable: state unknown (not absence)" };
    return r ? { state: r.state, serving: !!s, instanceId: r.instanceId, deployment: r.deployment, generation: r.generation, launchEpoch: r.launchEpoch,
      managerEpoch: r.managerEpoch, vmId: r.vmId, appId: r.appId, runtimeId: r.runtimeId, image: r.image,
      stagingWallUntil: r.stagingWallUntil, validUntil: s?.until ?? null, permitDigest: s?.digest ?? null, reason: r.reason, error: r.error }
      : { state: "unknown", serving: false, reason: "no durable protected record: not adopted, not served" };
  }

  /** Authenticated controller hold (or Stop): withdraw access now, then remove compute. Reports what actually happened. */
  async hold(instanceId, why = "controller hold") {
    const rec = this.#readInst(instanceId), k = this.known.get(instanceId);
    if (!rec && !k) throw fail(404, "unknown protected instance");
    const removal = this.withdraw(instanceId, why);
    const ing = this.ingress.get(instanceId) ?? { closed: false, error: "no data-plane close was attempted" };
    const acks = this.acks.get(instanceId) ?? [];
    const kinds = k?.workloads ?? [];
    const settled = (kind) => !kinds.includes(kind) || acks.filter((a) => a.kind === kind).every((a) => a.state === "closed");
    return { deployment: rec && rec !== JOURNAL_UNKNOWN ? rec.deployment : k.deployment, instanceId,
      ingress: ing.closed === true,
      storage: settled("volumes"),
      // a secret release boundary can stop NEW releases; material already released is not retroactively withdrawn
      secrets: !kinds.includes("secrets"),
      boundaries: acks.map((a) => ({ ...a })),
      basis: { ingress: ing.closed ? "data-plane splices closed and admission refused" : `data-plane close FAILED (${ing.error}); admission refused, live streams unconfirmed`,
        storage: kinds.includes("volumes") ? "volume boundary close outcome per `boundaries` (pending/failed is not withdrawn)" : "never admitted for this instance (stage refuses volumes without a composed boundary)",
        secrets: kinds.includes("secrets") ? "new secret releases refused; material already released to the guest is DISCLOSED and cannot be retroactively erased" : "never admitted for this instance (stage refuses secrets without a composed boundary)" },
      journal: rec === JOURNAL_UNKNOWN ? "unreadable: durable state unknown (not absence)" : "readable",
      compute: "removal started (guard asked independently); confirmed only by a backend survey", removal: "pending", removalTracked: removal instanceof Promise };
  }

  /**
   * THE withdrawal. Synchronous part (never depends on the journal): no serving entry, splices and boundaries closed,
   * independent guard removal asked, gate entry held. Then exact removal, retried until a survey confirms absence
   * AND that is durably recorded. Returns the first attempt's promise (rejects if unconfirmed).
   */
  withdraw(instanceId, why) {
    const s = this.serving.get(instanceId);
    if (s) { this.serving.delete(instanceId); this.timers.clear(s.timer); }
    try { this.dataPlane?.closeInstance(instanceId, why); this.ingress.set(instanceId, { closed: !!this.dataPlane, error: this.dataPlane ? null : "no data plane" }); }
    catch (e) { this.ingress.set(instanceId, { closed: false, error: String(e?.message ?? e) }); this.onError(e); }
    this.#closeBoundaries(instanceId, why);
    // r3: the guard's exact removal is asked FIRST and independently of the journal and of the manager's own cleanup
    if (this.guard && !this.guardLost) { try { this.guard.call("withdraw", { instanceId, reason: why }).catch(() => {}); } catch (e) { this.onError(e); } }
    const rec = this.#readInst(instanceId), k = this.known.get(instanceId);
    const dep = (rec && rec !== JOURNAL_UNKNOWN ? rec.deployment : null) ?? s?.deployment ?? k?.deployment ?? null;
    if (dep) try { if (this.gate.entries.has(dep)) this.gate.hold(dep, why); } catch (e) { this.onError(e); }
    const st = this.staging.get(instanceId); if (st) { this.timers.clear(st.timer); this.staging.delete(instanceId); }
    if (this.removals.has(instanceId)) return this.removals.get(instanceId);
    if (rec && rec !== JOURNAL_UNKNOWN && TERMINAL.has(rec.state) && !this.manager.domains?.has(instanceId) && !this.spawns.has(instanceId)) return Promise.resolve(rec.state);
    const p = this.#remove(instanceId, why).finally(() => this.removals.delete(instanceId));
    this.removals.set(instanceId, p);
    p.catch(() => {});
    return p;
  }
  /** Bounded wait on an OWNED promise: resolves its outcome, or PENDING (the promise stays owned and is awaited again). */
  #bounded(p) {
    let t;
    const limit = new Promise((ok) => { t = this.timers.set(() => ok(PENDING), this.config.retryMs); t?.unref?.(); });
    return Promise.race([p.then(() => "settled", () => "settled"), limit]).finally(() => this.timers.clear(t));
  }
  /**
   * r3: exact compute removal that does NOT go through the (possibly hung) installed removal or raw launch: the
   * independent remover's survey, filtered to this exact instance (Notes identity id, or the trusted bound GUID whose
   * Notes also name this id). A GUID match with another identity is never touched.
   */
  async #independentRemove(id, vmId) {
    if (!this.computeRemover) throw Error("no independent compute remover composed");
    const inv = await this.computeRemover.survey();
    if (!inv || !Array.isArray(inv.vms)) throw Error("independent survey unavailable: absence is unknown");
    for (const v of inv.vms.filter((v) => (vmId && String(v.vmId || "").toLowerCase() === vmId) || parseNotes(v.notes).identity?.id === id)) {
      if (parseNotes(v.notes).identity?.id !== id) throw Error(`VM ${v.vmId} has the bound GUID but another identity: not touched`);
      const out = await this.computeRemover.removeById(String(v.vmId));
      if (!(out?.found === true && out.removed === true) && !(out?.found === false && out.removed === false)) throw Error(`independent removal of ${v.vmId} not confirmed`);
    }
  }
  async #independentNote(guardDown, id, vmId) {
    if (!guardDown) return " (the guard's independent exact removal was asked)";
    try { await this.#independentRemove(id, vmId); return " (independent exact removal requested)"; }
    catch (x) { return ` (guard unavailable; independent exact removal failed: ${x.message})`; }
  }
  async #remove(id, why) {
    const k = this.known.get(id);
    let rec = this.#readInst(id), journalFault = rec === JOURNAL_UNKNOWN ? "journal unreadable" : null;
    try {
      if (!journalFault && rec && !["removing", "remove-failed", "unknown"].includes(rec.state) && !TERMINAL.has(rec.state)) {
        try { rec = this.journal.putInstance({ ...rec, state: "removing", reason: why, at: this.now() }); }
        catch (e) { journalFault = `removing record not durable: ${e.message}`; }
      }
      const vmId = (rec && rec !== JOURNAL_UNKNOWN ? rec.vmId : null) ?? k?.vmId ?? null;
      const guardDown = !this.guard || !!this.guardLost;
      let hung = null;
      const pending = this.spawns.get(id);
      if (pending && await this.#bounded(pending) === PENDING) hung = "raw launch still in flight (launch stays owned)";
      if (!hung && this.manager.domains.has(id) && !this.removeCalls.has(id)) {
        const call = Promise.resolve().then(() => this.manager.removeRecord(id));
        this.removeCalls.set(id, call);
        call.then(() => this.removeCalls.delete(id), (e) => { this.removeCalls.delete(id); this.onError(e); });
      }
      const rc = this.removeCalls.get(id);
      if (!hung && rc) {
        if (await this.#bounded(rc) === PENDING) hung = "installed removal still running (call stays owned)";
        else await rc;                                                // a rejected removal is this attempt's failure
      }
      // r3: polling the same hung promise is not removal: with the guard down, the independent exact remover acts
      if (hung) throw Error(`${hung}: absence cannot be confirmed yet${await this.#independentNote(guardDown, id, vmId)}`);
      const inv = await this.manager.backend.survey();
      if (!inv || !Array.isArray(inv.vms)) throw Error("backend survey unavailable: absence is unknown");
      const left = inv.vms.filter((v) => (vmId && String(v.vmId || "").toLowerCase() === vmId) || parseNotes(v.notes).identity?.id === id);
      if (left.length) throw Error(`exact identity still present (${left.map((v) => v.vmId).join(", ")})${await this.#independentNote(guardDown, id, vmId)}`);
      if (this.spawns.has(id)) throw Error("raw launch began after the survey: absence not confirmed");
      if (journalFault) throw Error(`survey shows absence but the ${journalFault}: removal is not durably recorded (unknown is not absence)`);
      if (rec) {
        const cur = this.journal.instance(id);
        if (!TERMINAL.has(cur.state)) {
          const from = ["unknown", "removing", "remove-failed"].includes(cur.state) ? cur : this.journal.putInstance({ ...cur, state: "removing", reason: why, at: this.now() });
          this.journal.putInstance({ ...from, state: "removed", error: null, at: this.now(), confirmed: { by: "survey", at: this.now(), vmId: from.vmId } });
        }
      }
      if (k) k.terminal = true;
      return "removed";
    } catch (e) {
      try { const cur = this.journal.instance(id); if (cur && !TERMINAL.has(cur.state)) this.journal.putInstance({ ...cur, state: "remove-failed", error: e.message, at: this.now() }); } catch (j) { this.onError(j); }
      this.#retry(id, why);
      throw e;
    }
  }
  #retry(id, why) {
    try { const t = this.timers.set(() => { if (!this.removals.has(id)) this.withdraw(id, why); }, this.config.retryMs); t?.unref?.(); }
    catch (e) { this.onError(e); }
  }

  /**
   * r3 retryable owner release. The r18 gate memoizes close()'s completion (a rejected one stays rejected). Each
   * failed withdrawal is cleared ONLY through the gate's own withdrawalProven() with the proof it demands: a durably
   * recorded survey-confirmed `removed` record AND an acknowledged ingress/boundary hold. Then (gate still closed,
   * admissions still revoked) a fresh completion is computed and the journal retries exactly its failed listeners;
   * the physical handle closes only when that succeeds.
   */
  async retryRelease(reason = "release retry") {
    for (const { id } of this.gate.withdrawalFailures()) {
      const ids = [...this.known].filter(([, k]) => k.deployment === id).map(([i]) => i);
      let proven = ids.length > 0;
      for (const iid of ids) {
        try { await this.withdraw(iid, reason); } catch { proven = false; continue; }
        const r = this.#readInst(iid), ing = this.ingress.get(iid);
        const acked = (this.acks.get(iid) ?? []).every((a) => a.state === "closed");
        if (r === JOURNAL_UNKNOWN || !r || r.state !== "removed" || ing?.closed !== true || !acked) proven = false;
      }
      if (proven) this.gate.withdrawalProven(id, { absent: true, held: true });
    }
    if (this.gate.withdrawalFailures().length) return { released: false, retryable: true, failures: this.gate.withdrawalFailures().map((f) => f.id) };
    if (this.gate.closing) this.gate.closing.catch(() => {});
    this.gate.closing = undefined;                    // drops ONLY the memoized rejected completion; the gate stays closed
    await this.gate.close(reason);
    return this.journal.release(reason);
  }

  /** Startup: nothing protected is continued; every non-terminal record and every unjournaled protected VM is removed. */
  async recoverAtStartup() {
    const out = [];
    const jr = this.journal.quarantined() ? "journal tail was quarantined: state unknown" : "manager restarted: no lifetime is continued";
    const all = this.journal.instances();                             // unreadable at startup: throws (no capability)
    for (const r of all) this.known.set(r.instanceId, { deployment: r.deployment, vmId: r.vmId, terminal: TERMINAL.has(r.state), workloads: [] });
    for (const r of all.filter((r) => !TERMINAL.has(r.state))) {
      try { this.journal.putInstance({ ...r, state: "unknown", reason: jr, at: this.now() }); } catch (e) { this.onError(e); }
      out.push(this.withdraw(r.instanceId, jr));
    }
    for (const id of this.manager.domains.keys()) {
      if (!PROTECTED_ID.test(id)) continue;
      const r = all.find((x) => x.instanceId === id);
      // r3: a durable terminal record does NOT erase the obligation to remove a protected VM that is still present
      if (!r) out.push(this.#removeUnjournaled(id));
      else if (TERMINAL.has(r.state)) out.push(this.#removeUnjournaled(id, `durable ${r.state} record but the protected VM is present`));
    }
    return Promise.allSettled(out);
  }
  async #removeUnjournaled(id, why = "no durable mapping") {
    // No durable (or a falsely terminal) mapping: never adopted or served; a Stop of the exact recovered record is still allowed.
    try { await this.manager.removeRecord(id); } catch (e) { this.onError(Object.assign(e, { context: why })); throw e; }
  }
}
