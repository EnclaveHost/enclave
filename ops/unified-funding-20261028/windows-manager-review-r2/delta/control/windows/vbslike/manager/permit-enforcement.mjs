/* ============================================================
   CONTINUING PER-APP AUTHORIZATION for the Windows manager (permit r2, SOURCE ONLY - authored, not run).

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
   witness-signed: the attachment is authenticated by the control channel and checked against durable state.
   App generation (the permit's), host generation (inside its host authority) and manager/launch epochs are
   separate fields and are never compared with each other.

   DEADLINES. The gate's effective deadline is min(permit validUntil - skew, authority window) in WALL ms plus a
   MONOTONIC deadline set at acceptance; the attachment may only shorten it (validUntil from the caller's own
   gate). Seconds: the signed record (issuedAt/validUntil). Milliseconds: everything here and on the wire to
   the guard. Re-sending the same envelope cannot extend (the gate keeps the old monotonic deadline; the guard
   refuses a renew with the same digest).

   WITHDRAWAL ORDER on expiry/revocation/Offline/owner loss/guard loss: synchronously drop the serving entry and
   close the instance's data-plane splices (new streams are refused because the data-plane lookup re-asserts the
   gate on every admission), THEN start exact compute removal, independently of any relay/transport cleanup.
   Removal is "done" only when a real backend survey no longer lists the exact identity; failures stay recorded
   and are retried. Nothing here deletes a protected record.
   r2: removal never waits unboundedly on a hung raw startup or a hung installed removal: each is OWNED (kept,
   awaited again on the next attempt) but bounded per attempt by retryMs; while either is unsettled absence is not
   confirmed and the record stays remove-failed (retried), and the guard's independent removal was already asked.
   A hold acknowledgment reports what actually happened: ingress is true only if the data-plane close returned
   without error; storage/secrets are reported with their real basis (never admitted for protected r1).

   SCOPE (refused rather than claimed; UNFINISHED migration blockers, see REPORT-WINDOWS-PERMIT-R2.md): secret
   (V6/V7), desktop, GPU, ports, volumes and config-socket derivations are NOT admitted as protected, because their
   secret-release/storage/worker paths are not wired to this gate.
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
const H32 = /^0x[0-9a-f]{64}$/, A20 = /^0x[0-9a-f]{40}$/, GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROTECTED_DERIVATIONS = new Set(["enclave-catalog-bundle/1", "enclave-catalog-bundle/5"]);
const TERMINAL = new Set(["removed", "refused"]);
const exact = (o, keys) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const fail = (status, message) => Object.assign(new Error(message), { status });
const hex = (n) => crypto.randomBytes(n).toString("hex");
const PENDING = Symbol("pending");

/** The reviewed configuration: exact keys, v2 pins only, this host, bounded staging. */
export function validateEnforcementConfig(c) {
  const keys = ["schema", "pins", "host", "maxStagingMs", "derivations", "qualification", "retryMs"];
  if (!exact(c, keys) || c.schema !== CONFIG_SCHEMA) throw Error("permit enforcement config has unknown or missing fields");
  if (!isHostAuthorityPermit(c.pins) || !A20.test(String(c.pins.lifecycle).toLowerCase())) throw Error("permit enforcement requires exact v2 host-authority pins");
  if (!H32.test(c.host)) throw Error("permit enforcement host must be a lowercase bytes32");
  if (!Number.isSafeInteger(c.maxStagingMs) || c.maxStagingMs < 1000 || c.maxStagingMs > 600_000) throw Error("maxStagingMs must be 1000..600000");
  if (!Array.isArray(c.derivations) || !c.derivations.length || c.derivations.some((d) => !PROTECTED_DERIVATIONS.has(d))) throw Error("protected derivations are limited to /1 and /5 in r1");
  if (!["production", TEST_QUALIFICATION].includes(c.qualification)) throw Error("unknown qualification");
  if (!Number.isSafeInteger(c.retryMs) || c.retryMs < 100 || c.retryMs > 60_000) throw Error("retryMs must be 100..60000");
  return Object.freeze(structuredClone(c));
}

export class PermitEnforcement {
  /**
   * manager: ProtectedManager; journal: openPermitJournal(owned log); guard: GuardClient | null;
   * authority: { qualification, read(deployment) -> servingContextOf(...) shape } | null
   * dataPlane: { closeInstance(id, why) } | null
   */
  constructor({ config, manager, journal, guard = null, authority = null, dataPlane = null,
                now = Date.now, monotonic = () => performance.now(), timers = { set: setTimeout, clear: clearTimeout }, onError = () => {} }) {
    this.config = validateEnforcementConfig(config);
    Object.assign(this, { manager, journal, guard, authority, dataPlane, now, monotonic, timers, onError });
    this.gate = new DeploymentPermitGate({ pins: this.config.pins, journal, now, monotonic, timers, onError, hostAuthority: journal.hostAuthority });
    this.serving = new Map();       // instanceId -> { deployment, generation, hostAuthority, until, monoDeadline, digest, release, timer }
    this.spawns = new Map();        // instanceId -> the raw spawn promise (owned until settled, beyond any HTTP call)
    this.removals = new Map();      // instanceId -> in-flight removal
    this.removeCalls = new Map();   // instanceId -> the installed removeRecord() promise (owned until settled, r2)
    this.ingress = new Map();       // instanceId -> { closed: boolean, error } of the LAST data-plane close (r2)
    this.staging = new Map();       // instanceId -> staging timer
    this.tails = new Map();         // deployment -> serialization tail
    this.guardReady = false; this.guardLost = guard ? null : "no guard configured";
    if (guard) guard.onLost((why) => this.#guardLost(why));
  }

  // ---- capability: true only when the whole selected path is present ----
  capability() {
    const reasons = [];
    try { this.journal.assertLive(); } catch (e) { reasons.push(`journal: ${e.message}`); }
    if (this.config.qualification === "production" && this.journal.exclusion !== "windows-exlock") reasons.push("journal exclusion is not the Windows share-mode-0 handle");
    if (!this.authority) reasons.push("no authenticated authority reader is composed (see authority-reader.mjs for the exact missing inputs)");
    else if (this.config.qualification === "production" && this.authority.qualification !== PRODUCTION_AUTHORITY) reasons.push(`authority reader is ${this.authority.qualification}, not ${PRODUCTION_AUTHORITY}`);
    else if (this.config.qualification !== "production" && this.authority.qualification !== "TEST") reasons.push("TEST configuration requires a TEST-labelled authority");
    if (this.guardLost) reasons.push(`guard unavailable: ${this.guardLost}`);
    else if (!this.guardReady) reasons.push("guard readiness not verified");
    if (!this.dataPlane) reasons.push("no data plane to withdraw");
    if (this.gate.closed) reasons.push("permit gate closed");
    if (this.gate.withdrawalFailures().length) reasons.push("a previous withdrawal is unconfirmed");
    try { if (this.journal.instances().some((r) => ["unknown", "remove-failed", "removing"].includes(r.state))) reasons.push("a protected instance's removal is not yet confirmed"); } catch {}
    return { available: reasons.length === 0, reasons, qualification: this.config.qualification,
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
    for (const r of this.#active()) this.withdraw(r.instanceId, `guard unavailable: ${why}`);
  }
  #active() { try { return this.journal.instances().filter((r) => !TERMINAL.has(r.state)); } catch { return []; } }
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
    if (spawn.hasSecrets !== false || Number(spawn.gpuShare) > 0 || Number(spawn.gpuMilli) > 0 || (spawn.volumes || []).length || (spawn.firewall || []).length || spawn.derive?.http)
      throw fail(400, "protected r1 admits no secrets, GPU, volumes, ports or command sockets");
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
      const ms = Math.min(this.config.maxStagingMs, stagingMs);
      const instanceId = "pp" + hex(16), launchEpoch = hex(16), wallUntil = this.now() + ms, monoDeadline = this.monotonic() + ms;
      const rec = { instanceId, deployment, generation: a.generation + 1, launchEpoch, managerEpoch: this.manager.epoch, state: "staging",
        stagingWallUntil: wallUntil, vmId: null, appId: null, runtimeId: null, image: null, recordSha256: null, permit: null,
        reason: null, error: null, at: this.now() };
      this.journal.putInstance(rec, { admission: true });               // durable intent BEFORE the guard and the spawn
      try { await this.guard.call("register", { instanceId, deployment, appId: null, launchEpoch, wallUntil, remainingMs: ms, kind: "staging" }); }
      catch (x) {
        // r2: a registration reply lost/refused is NOT proof that nothing is armed at the guard; nothing was spawned,
        // so `refused` is accurate for compute here, and the guard owns any record it may have written.
        this.guard.call("withdraw", { instanceId, reason: "registration not acknowledged" }).catch(() => {});
        this.journal.putInstance({ ...rec, state: "refused", reason: `guard registration failed before any spawn: ${x.message}` });
        throw fail(503, `guard registration failed; nothing was started: ${x.message}`);
      }
      this.gate.stage(deployment, () => this.withdraw(instanceId, "permit owner closed while staged"));
      const timer = () => {
        const left = Math.min(wallUntil - this.now(), monoDeadline - this.monotonic());
        if (left > 0) { const t = this.timers.set(timer, Math.ceil(left)); t?.unref?.(); this.staging.set(instanceId, t); return; }
        const cur = this.journal.instance(instanceId);
        if (cur && ["staging", "staged"].includes(cur.state)) this.withdraw(instanceId, "staging deadline passed without a verified serving permit");
      };
      const t0 = this.timers.set(timer, ms); t0?.unref?.(); this.staging.set(instanceId, t0);
      // The raw spawn is OWNED here, beyond this HTTP call: its late completion is bound or removed, never forgotten.
      const p = this.manager.spawnProtectedInternal({ ...structuredClone(spawn), id: instanceId });
      this.spawns.set(instanceId, p);
      p.then((view) => this.#spawned(instanceId, view), (x) => this.#spawnThrew(instanceId, x)).catch((x) => this.onError(x));
      return { instanceId, deployment, generation: rec.generation, launchEpoch, managerEpoch: this.manager.epoch,
        stagingWallUntil: wallUntil, serving: false, enforcementEpoch: this.#epoch() };
    });
  }
  async #spawned(id, view) {
    this.spawns.delete(id);
    const cur = this.journal.instance(id), mrec = this.manager.domains.get(id);
    const vmId = String(mrec?.handle?.vmId || "").toLowerCase();
    if (!cur || cur.state !== "staging" || !mrec || view?.status === "failed" || !GUID.test(vmId)) {
      return this.withdraw(id, cur?.state !== "staging" ? "withdrawn before the launch completed (late completion removed)" : `launch did not stage: ${view?.reason || "no VM GUID"}`);
    }
    try { this.journal.putInstance({ ...cur, state: "staged", vmId, appId: mrec.appId, runtimeId: mrec.runtimeId, image: mrec.image ?? null, recordSha256: mrec.recordSha256 ?? null }); }
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
      if (rec.appId !== m.appId || rec.runtimeId !== m.runtimeId || String(m.handle?.vmId || "").toLowerCase() !== rec.vmId) throw fail(409, "durable mapping differs from the live record");
      if (r.deployment !== rec.deployment || r.generation !== rec.generation || r.host !== this.config.host) throw fail(403, "permit is for another deployment, generation or host");
      if (!Number.isSafeInteger(at.validUntil)) throw fail(400, "attachment validUntil (ms) required");
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
      const until = Math.min(entry.until, at.validUntil, old?.digest === digest ? old.until : Infinity);
      const monoDeadline = Math.min(entry.deadline, this.monotonic() + (until - this.now()));
      const remainingMs = Math.floor(Math.min(until - this.now(), monoDeadline - this.monotonic()));
      if (!(remainingMs > 0)) { this.gate.hold(rec.deployment, "effective deadline already passed"); throw fail(403, "effective deadline already passed"); }
      if (old?.digest !== digest) {
        this.journal.putInstance({ ...after, state: "serving", permit: { digest, sequence: r.sequence, wallUntil: until } });
        try { await this.guard.call("renew", { instanceId, permitDigest: digest, wallUntil: until, remainingMs }); }
        catch (x) { this.gate.hold(rec.deployment, "guard did not accept the deadline"); throw fail(503, `guard did not accept the deadline: ${x.message}`); }
        if (this.journal.instance(instanceId)?.state !== "serving") throw fail(409, "withdrawn while the guard was renewed");
      }
      const binding = { host: this.config.host, generation: grant.generation, hostAuthority: grant.hostAuthority };
      if (old) { this.timers.clear(old.timer); old.release?.(); }
      const s = { deployment: rec.deployment, binding, until, monoDeadline, digest, release: null, timer: null };
      s.release = this.gate.track(rec.deployment, binding, (why) => this.withdraw(instanceId, why));
      const tick = () => {
        if (this.serving.get(instanceId) !== s) return;
        const left = Math.min(s.until - this.now(), s.monoDeadline - this.monotonic());
        if (left > 0) { s.timer = this.timers.set(tick, Math.ceil(left)); s.timer?.unref?.(); } else this.gate.hold(rec.deployment, "effective deadline passed");
      };
      s.timer = this.timers.set(tick, Math.ceil(remainingMs)); s.timer?.unref?.();
      this.serving.set(instanceId, s);
      this.gate.unstage(rec.deployment);
      const t = this.staging.get(instanceId); if (t) { this.timers.clear(t); this.staging.delete(instanceId); }
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
    if (this.now() >= s.until || this.monotonic() >= s.monoDeadline) { this.gate.hold(s.deployment, "effective deadline passed"); return null; }
    return view;
  }
  viewOf(id) {
    let r = null; try { r = this.journal.instance(id); } catch {}
    const s = this.serving.get(id);
    return r ? { state: r.state, serving: !!s, deployment: r.deployment, generation: r.generation, launchEpoch: r.launchEpoch,
      stagingWallUntil: r.stagingWallUntil, validUntil: s?.until ?? null, permitDigest: s?.digest ?? null, reason: r.reason, error: r.error }
      : { state: "unknown", serving: false, reason: "no durable protected record: not adopted, not served" };
  }

  /** Authenticated controller hold (or Stop): withdraw access now, then remove compute. Reports what actually happened. */
  async hold(instanceId, why = "controller hold") {
    const rec = this.journal.instance(instanceId);
    if (!rec) throw fail(404, "unknown protected instance");
    const removal = this.withdraw(instanceId, why);
    const ing = this.ingress.get(instanceId) ?? { closed: false, error: "no data-plane close was attempted" };
    return { deployment: rec.deployment, instanceId,
      ingress: ing.closed === true,
      storage: true, secrets: true,          // protected r1 admits neither (stage() refuses volumes/secrets): nothing to withdraw
      basis: { ingress: ing.closed ? "data-plane splices closed and admission refused" : `data-plane close FAILED (${ing.error}); admission refused, live streams unconfirmed`,
        storage: "never admitted for a protected r1 instance (stage refuses volumes)", secrets: "never admitted for a protected r1 instance (stage refuses secrets)" },
      compute: "removal started; confirmed only by a backend survey", removal: "pending", removalTracked: removal instanceof Promise };
  }

  /**
   * THE withdrawal. Synchronous part: no serving entry, splices closed, gate entry held. Then exact removal,
   * retried until a survey confirms absence. Returns the first attempt's promise (rejects if unconfirmed).
   */
  withdraw(instanceId, why) {
    const s = this.serving.get(instanceId);
    if (s) { this.serving.delete(instanceId); this.timers.clear(s.timer); }
    try { this.dataPlane?.closeInstance(instanceId, why); this.ingress.set(instanceId, { closed: !!this.dataPlane, error: this.dataPlane ? null : "no data plane" }); }
    catch (e) { this.ingress.set(instanceId, { closed: false, error: String(e?.message ?? e) }); this.onError(e); }
    let rec = null; try { rec = this.journal.instance(instanceId); } catch (e) { this.onError(e); }
    if (s || rec) try { if (this.gate.entries.has(rec?.deployment ?? s.deployment)) this.gate.hold(rec?.deployment ?? s.deployment, why); } catch (e) { this.onError(e); }
    const t = this.staging.get(instanceId); if (t) { this.timers.clear(t); this.staging.delete(instanceId); }
    if (this.removals.has(instanceId)) return this.removals.get(instanceId);
    if (rec && TERMINAL.has(rec.state)) return Promise.resolve(rec.state);
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
  async #remove(id, why) {
    let rec = this.journal.instance(id);
    if (rec && !["removing", "remove-failed", "unknown"].includes(rec.state)) rec = this.journal.putInstance({ ...rec, state: "removing", reason: why });
    // the guard's exact removal is asked FIRST and independently: it does not wait for the manager's own cleanup
    if (this.guard && !this.guardLost) this.guard.call("withdraw", { instanceId: id, reason: why }).catch(() => {});
    try {
      const pending = this.spawns.get(id);
      if (pending && await this.#bounded(pending) === PENDING) throw Error("raw launch still in flight: absence cannot be confirmed yet (launch stays owned)");
      if (this.manager.domains.has(id) && !this.removeCalls.has(id)) {
        const call = Promise.resolve().then(() => this.manager.removeRecord(id));
        this.removeCalls.set(id, call);
        call.then(() => this.removeCalls.delete(id), (e) => { this.removeCalls.delete(id); this.onError(e); });
      }
      const rc = this.removeCalls.get(id);
      if (rc) {
        if (await this.#bounded(rc) === PENDING) throw Error("installed removal still running: absence not confirmed (call stays owned)");
        await rc;                                                     // a rejected removal is this attempt's failure
      }
      const inv = await this.manager.backend.survey();
      if (!inv || !Array.isArray(inv.vms)) throw Error("backend survey unavailable: absence is unknown");
      const vmId = rec?.vmId ?? null;
      const left = inv.vms.filter((v) => (vmId && String(v.vmId || "").toLowerCase() === vmId) || parseNotes(v.notes).identity?.id === id);
      if (left.length) throw Error(`exact identity still present (${left.map((v) => v.vmId).join(", ")})`);
      if (this.spawns.has(id)) throw Error("raw launch began after the survey: absence not confirmed");
      if (rec) {
        const cur = this.journal.instance(id);
        const from = cur.state === "unknown" || cur.state === "removing" || cur.state === "remove-failed" ? cur : this.journal.putInstance({ ...cur, state: "removing", reason: why });
        this.journal.putInstance({ ...from, state: "removed", error: null, confirmed: { by: "survey", at: this.now() } });
      }
      return "removed";
    } catch (e) {
      try { const cur = this.journal.instance(id); if (cur && !TERMINAL.has(cur.state)) this.journal.putInstance({ ...cur, state: "remove-failed", error: e.message }); } catch (j) { this.onError(j); }
      this.#retry(id, why);
      throw e;
    }
  }
  #retry(id, why) {
    const t = this.timers.set(() => { if (!this.removals.has(id)) this.withdraw(id, why); }, this.config.retryMs); t?.unref?.();
  }

  /** Startup: nothing protected is continued; every non-terminal record and every unjournaled protected VM is removed. */
  async recoverAtStartup() {
    const out = [];
    const jr = this.journal.quarantined() ? "journal tail was quarantined: state unknown" : "manager restarted: no lifetime is continued";
    for (const r of this.#active()) { this.journal.putInstance({ ...r, state: "unknown", reason: jr }); out.push(this.withdraw(r.instanceId, jr)); }
    for (const id of this.manager.domains.keys())
      if (PROTECTED_ID.test(id) && !this.journal.instance(id)) out.push(this.#removeUnjournaled(id));
    return Promise.allSettled(out);
  }
  async #removeUnjournaled(id) {
    // No durable mapping: never adopted or served; a Stop of the exact recovered record is still allowed.
    try { await this.manager.removeRecord(id); } catch (e) { this.onError(e); throw e; }
  }
}
