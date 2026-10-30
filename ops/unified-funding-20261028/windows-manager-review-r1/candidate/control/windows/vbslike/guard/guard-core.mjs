/* ============================================================
   THE PERMIT GUARD - the per-app compute fence that does not live in the manager (permit r1, SOURCE ONLY).

   A JS timer inside the manager dies with the manager, and wmiserve --hold stdin only closes the relay on EOF
   (its VM stays). So protected compute is ALSO owned by this separate process (a Windows service, staged by
   install-guard.ps1, never installed by this change). It knows nothing about permits or witnesses: it holds,
   per protected instance, an exact identity (instance id in the VM's Notes, VM GUID once known) and two
   non-extending deadlines, and it removes exactly that VM when ANY of these happens:
     - the wall deadline OR the monotonic deadline passes (whichever is first: a backwards wall clock cannot
       extend, a monotonic clock that stopped across suspend is cut by the wall check);
     - the manager session that registered it ends (pipe closed, or the manager's process identity - PID AND
       creation time, never PID alone - is no longer that process): MANAGER DEATH IS REMOVAL, not a grace;
     - the manager withdraws it (expiry/revocation/stop), after which the guard still confirms absence itself.
   The manager renews only with a NEW permit digest and the deadline it verified; the same digest never buys
   time, and a renew can never move a deadline past the stated wall deadline.

   STARTUP / CRASH / RECOVERY CONTRACT (fail closed):
     - the guard's journal (win-durable.mjs, purpose enclave-permit-guard/1) is opened exclusively FIRST;
       missing/corrupt/torn/foreign -> the guard does not start (no readiness, so no manager advertises
       protected capability, so no protected launch is admitted);
     - every non-terminal registration found at startup is set `removing` BEFORE readiness: its monotonic
       baseline died with the previous guard process (or the host rebooted), so no lifetime is ever continued
       across a guard restart. Removal runs until a real survey confirms absence;
     - removal failures are recorded (`remove-failed`, with the error) and retried; a record is never dropped
       because a call timed out, a child exited or the manager said so. Only a survey that began after the
       late-effect horizon and does not contain the exact identity confirms `removed`;
     - while a registration has no bound VM GUID (the launch may still be running in a PowerShell child of a
       dead manager) absence is confirmed only after maxLaunchMs from registration: a late VM is still removed.
   IF THE GUARD IS UNAVAILABLE: the manager loses its authenticated session, withdraws data-plane access for
   every protected instance at once, starts its own exact removal, and stops advertising capability. If guard
   AND manager are both dead, nothing removes the VM until one of them starts (both remove at startup). That
   residual window and a hostile host administrator (who can stop either service) are OUTSIDE this design:
   T0-hv, host not excluded.
   Exactness: removal matches the VM GUID and the Notes identity id; never a prefix, never a legacy VM.
   ============================================================ */
import { parseNotes } from "../manager/wmi-launcher.mjs";

export const GUARD_PURPOSE = "enclave-permit-guard/1";
const INST = /^pp[0-9a-f]{32}$/;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const H64 = /^[0-9a-f]{64}$/;
const MAX_LIFETIME_MS = 15 * 60_000;           // a staging window or a permit window; both far below this
const TERMINAL = new Set(["removed"]);

export class PermitGuard {
  /**
   * log: win-durable openOwnedLog(..., { purpose: GUARD_PURPOSE }) handle (the capability)
   * backend: { survey() -> {vms:[{vmId,name,state,notes}]}, removeById(vmId) -> {found, removed, error} }
   * monotonic/now: ms clocks; timers: {set, clear}; maxLaunchMs: the launcher's longest start (late-effect horizon)
   */
  constructor({ log, backend, bootId, monotonic, now = Date.now, timers = { set: setTimeout, clear: clearTimeout },
                maxLaunchMs = 600_000, retryMs = 5_000, onEvent = () => {} }) {
    if (!log || typeof log.append !== "function") throw Error("guard requires its owned journal");
    if (typeof backend?.survey !== "function" || typeof backend?.removeById !== "function") throw Error("guard requires survey and exact removal");
    if (typeof monotonic !== "function") throw Error("guard requires a monotonic clock");
    Object.assign(this, { log, backend, bootId: String(bootId || ""), monotonic, now, timers, maxLaunchMs, retryMs, onEvent });
    this.regs = new Map();                      // instanceId -> durable record
    this.live = new Map();                      // instanceId -> { session, monoDeadline, armedMono, timer }
    this.removing = new Map();                  // instanceId -> in-flight removal promise
    this.session = null; this.ready = false; this.closed = false;
    for (const r of log.rows()) if (r.kind === "reg") this.regs.set(r.data.instanceId, r.data.rec);
  }

  #put(rec) { this.log.append("reg", { instanceId: rec.instanceId, rec }); this.regs.set(rec.instanceId, structuredClone(rec)); return rec; }

  /** Startup: everything not terminal is removed. Readiness only after that is durably recorded. */
  async start() {
    this.log.assertLive();
    if (this.log.ambiguous()) throw Error("guard journal has a torn tail: not starting");
    const restart = [...this.regs.values()].filter((r) => !TERMINAL.has(r.state));
    for (const r of restart)
      this.#put({ ...r, state: "removing", reason: r.bootId === this.bootId ? "guard restarted: the monotonic baseline is gone" : "host boot changed", at: this.now() });
    this.log.append("guard-start", { bootId: this.bootId, pid: process.pid, removing: restart.map((r) => r.instanceId) });
    this.ready = true;
    for (const r of restart) this.#removal(r.instanceId, { horizonFromStart: true });
    return this.status();
  }

  status() {
    const list = [...this.regs.values()];
    return { ready: this.ready && !this.closed && !this.log.failed(), owner: this.log.ownerId, exclusion: this.log.exclusion, bootId: this.bootId,
      session: this.session ? { epoch: this.session.identity.epoch, pid: this.session.identity.pid } : null,
      armed: list.filter((r) => r.state === "armed").length,
      removing: list.filter((r) => r.state === "removing").map((r) => r.instanceId),
      failures: list.filter((r) => r.state === "remove-failed").map((r) => ({ id: r.instanceId, error: r.error })) };
  }

  /** One authenticated manager session at a time (identity already verified by the transport: pid + creation time + epoch). */
  attach(identity) {
    if (!this.ready || this.closed) throw Error("guard not ready");
    if (this.session) throw Error("another manager session is attached");
    if (!Number.isSafeInteger(identity?.pid) || !identity.created || !/^[0-9a-f]{32}$/.test(identity.epoch || "")) throw Error("manager identity incomplete");
    const s = { identity: Object.freeze({ ...identity }), ended: false };
    this.session = s;
    this.log.append("attach", { identity: s.identity, at: this.now() });
    return s;
  }
  /** Session end for ANY reason (pipe close, identity change, protocol error): all its instances are removed. */
  sessionEnded(s, why) {
    if (!s || s.ended) return;
    s.ended = true;
    if (this.session === s) this.session = null;
    for (const [id, l] of [...this.live]) if (l.session === s) this.#expire(id, `manager session ended: ${why}`);
  }
  #own(s, id) {
    if (!s || s.ended || this.session !== s) throw Error("no attached manager session");
    const r = this.regs.get(id);
    if (!r || r.session?.epoch !== s.identity.epoch) throw Error("instance is not registered by this manager session");
    if (r.state !== "armed") throw Error(`instance is ${r.state}`);
    return r;
  }
  #arm(id, s, wallUntil, remainingMs) {
    const old = this.live.get(id);
    const ms = Math.min(remainingMs, wallUntil - this.now());
    if (!(ms > 0)) throw Error("deadline already passed");
    const monoDeadline = Math.min(this.monotonic() + ms, old ? old.monoDeadline + Infinity : Infinity);
    if (old) this.timers.clear(old.timer);
    const l = { session: s, monoDeadline, wallUntil, armedMono: old?.armedMono ?? this.monotonic(), timer: null };
    this.live.set(id, l);
    const tick = () => {
      if (this.live.get(id) !== l) return;
      const left = Math.min(l.wallUntil - this.now(), l.monoDeadline - this.monotonic());
      if (left > 0) { l.timer = this.timers.set(tick, Math.ceil(left)); l.timer?.unref?.(); }
      else this.#expire(id, "deadline passed");
    };
    l.timer = this.timers.set(tick, Math.ceil(Math.max(0, monoDeadline - this.monotonic()))); l.timer?.unref?.();
  }

  /** Registration BEFORE the manager starts the VM. Durable before the ack. */
  register(s, { instanceId, deployment, appId, launchEpoch, wallUntil, remainingMs, kind = "staging" }) {
    if (!this.ready || this.closed) throw Error("guard not ready");
    if (!s || s.ended || this.session !== s) throw Error("no attached manager session");
    if (!INST.test(instanceId || "") || !/^0x[0-9a-f]{64}$/.test(deployment || "") || !/^[0-9a-f]{32}$/.test(launchEpoch || "")) throw Error("invalid protected identity");
    if (!Number.isSafeInteger(wallUntil) || !Number.isSafeInteger(remainingMs) || remainingMs <= 0 || remainingMs > MAX_LIFETIME_MS) throw Error("invalid deadline");
    if (this.regs.has(instanceId)) throw Error("instance id already registered (ids are never reused)");
    const rec = { instanceId, deployment, appId: appId ?? null, launchEpoch, kind, vmId: null, permitDigest: null, wallUntil,
      session: { epoch: s.identity.epoch, pid: s.identity.pid, created: s.identity.created }, bootId: this.bootId,
      state: "armed", at: this.now(), error: null, reason: null };
    this.#put(rec);
    this.#arm(instanceId, s, wallUntil, remainingMs);
    return { registered: instanceId, wallUntil };
  }
  bindVm(s, { instanceId, vmId }) {
    const r = this.#own(s, instanceId);
    if (!GUID.test(String(vmId || ""))) throw Error("not a VM GUID");
    if (r.vmId && r.vmId.toLowerCase() !== String(vmId).toLowerCase()) throw Error("a protected instance's VM GUID is immutable");
    this.#put({ ...r, vmId: String(vmId).toLowerCase() });
    return { bound: instanceId, vmId: String(vmId).toLowerCase() };
  }
  /** A newer verified permit: new digest required; the deadline is the manager's verified, already non-extending one. */
  renew(s, { instanceId, permitDigest, wallUntil, remainingMs }) {
    const r = this.#own(s, instanceId);
    if (!H64.test(String(permitDigest || "").replace(/^0x/, "")) ) throw Error("permit digest required");
    if (permitDigest === r.permitDigest) throw Error("the same permit never extends a deadline");
    if (!r.vmId) throw Error("no serving permit before the VM GUID is bound");
    if (!Number.isSafeInteger(wallUntil) || !Number.isSafeInteger(remainingMs) || remainingMs <= 0 || remainingMs > MAX_LIFETIME_MS) throw Error("invalid deadline");
    this.#put({ ...r, kind: "serving", permitDigest, wallUntil });
    this.#arm(instanceId, s, wallUntil, remainingMs);
    return { renewed: instanceId, permitDigest, wallUntil };
  }
  /** The manager withdrew it. The guard still removes/confirms itself; it never trusts "already gone". */
  withdraw(s, { instanceId, reason }) {
    const r = this.regs.get(instanceId);
    if (!s || s.ended || this.session !== s || !r || r.session?.epoch !== s.identity.epoch) throw Error("instance is not registered by this manager session");
    if (r.state === "armed") this.#expire(instanceId, `manager withdrew: ${String(reason || "unspecified").slice(0, 200)}`);
    return { withdrawing: instanceId, state: this.regs.get(instanceId).state };
  }
  #expire(id, why) {
    const l = this.live.get(id); if (l) { this.timers.clear(l.timer); this.live.delete(id); }
    const r = this.regs.get(id);
    if (!r || TERMINAL.has(r.state)) return;
    if (r.state === "armed") {
      try { this.#put({ ...r, state: "removing", reason: why, at: this.now() }); }
      catch (e) { this.onEvent({ kind: "journal-failed", id, error: e.message }); }   // removal proceeds even if the record failed
    }
    this.#removal(id, { armedMono: l?.armedMono });
  }
  /** Exact removal until a survey confirms absence. Never resolves "removed" on a timeout or an error. */
  #removal(id, { armedMono = null, horizonFromStart = false } = {}) {
    if (this.removing.has(id)) return this.removing.get(id);
    const horizon = (horizonFromStart || armedMono === null ? this.monotonic() : armedMono) + this.maxLaunchMs;
    const run = (async () => {
      for (;;) {
        if (this.closed) return;
        const r = this.regs.get(id);
        if (!r || TERMINAL.has(r.state)) return;
        try {
          const before = this.monotonic();
          const s = await this.backend.survey();
          if (!s || !Array.isArray(s.vms)) throw Error("survey returned no VM list (unknown is not absent)");
          const mine = s.vms.filter((v) => (r.vmId && String(v.vmId || "").toLowerCase() === r.vmId) || parseNotes(v.notes).identity?.id === id);
          for (const v of mine) {
            if (parseNotes(v.notes).identity?.id !== id) throw Error(`VM ${v.vmId} has the bound GUID but another identity: not touched`);
            const out = await this.backend.removeById(String(v.vmId));
            if (!(out?.found === true && out.removed === true) && !(out?.found === false && out.removed === false))
              throw Error(`removal of ${v.vmId} not confirmed: ${out?.error || "no confirmation"}`);
          }
          if (mine.length) continue;              // re-survey: confirmation is a survey without it
          const bound = !!r.vmId;
          if (!bound && before < horizon) { await new Promise((ok) => { const t = this.timers.set(ok, this.retryMs); t?.unref?.(); }); continue; }
          this.#put({ ...this.regs.get(id), state: "removed", confirmed: { by: "survey", at: this.now(), bound }, error: null });
          this.onEvent({ kind: "removed", id });
          return;
        } catch (e) {
          const cur = this.regs.get(id);
          try { if (cur.state !== "remove-failed" || cur.error !== e.message) this.#put({ ...cur, state: "remove-failed", error: e.message, at: this.now() }); }
          catch (j) { this.onEvent({ kind: "journal-failed", id, error: j.message }); }
          this.onEvent({ kind: "remove-failed", id, error: e.message });
          await new Promise((ok) => { const t = this.timers.set(ok, this.retryMs); t?.unref?.(); });
        }
      }
    })().finally(() => this.removing.delete(id));
    this.removing.set(id, run);
    return run;
  }
  /** For tests and an orderly service stop: armed instances are removed, never left running unguarded. */
  async stop(why = "guard stopping") {
    for (const id of [...this.live.keys()]) this.#expire(id, why);
    await Promise.allSettled([...this.removing.values()]);
    this.closed = true; this.ready = false;
  }
}
