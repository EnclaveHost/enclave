// The permit boundary used by ingress, secret release and storage adapters.
// Timers revoke existing resources; every new operation also checks wall AND
// monotonic deadlines, so a paused event loop or a backwards clock cannot renew
// access. Callers must register streams/handles with track() and call assert()
// before each write or secret release. A read-only status is never authority.
import { performance } from 'node:perf_hooks';
import { verifyServingPermit, servingAssignmentBinding } from './deployment-serving-permit.mjs';
// host-authority permit r1: v2 gates store/compare the exact host authority (durable sidecar) before any resource is allowed
import { isHostAuthorityPermit, validateHostAuthorityContext } from './deployment-host-authority.mjs';

export class DeploymentPermitGate {
  constructor({ pins, journal, now = Date.now, monotonic = () => performance.now(), hostAuthority = null,
    timers = { set: setTimeout, clear: clearTimeout }, onError = () => {} }) {
    Object.assign(this, { pins, journal, now, monotonic, timers, onError, hostAuthority });
    this.entries = new Map(); this.epochs = new Map(); this.resources = new Map();
    if (isHostAuthorityPermit(pins) && (typeof hostAuthority?.accept !== 'function' || typeof hostAuthority?.observe !== 'function')) throw Error('v2 permit gate requires the durable host authority journal');   // host-authority permit r1
    // ownership r3 + async r4: when the authority OWNER releases (or loses its lock), every installed grant and tracked resource is withdrawn,
    // this gate stays closed, and the owner's flock is held until close()'s completion (every withdrawal settled) resolves.
    if (typeof hostAuthority?.onRelease === 'function') hostAuthority.onRelease(reason => this.close(`host authority owner: ${reason}`));
    this.lastWall = now(); this.originWall = this.lastWall; this.originMono = monotonic(); this.closed = false;
  }
  #clock() {
    const wall = this.now();
    if (!Number.isSafeInteger(wall) || wall < this.lastWall ||
        Math.abs((wall - this.originWall) - (this.monotonic() - this.originMono)) > 2000) {
      this.close('clock discontinuity'); throw Error('permit clock discontinuity');
    }
    this.lastWall = wall; return wall;
  }
  async install(envelope, context) {
    if (this.closed) throw Error('permit gate closed');
    const id = envelope?.record?.deployment;
    const epoch = this.epochs.get(id) || 0;
    const wall = this.#clock();
    const row = this.journal.read(id);
    if (isHostAuthorityPermit(this.pins)) this.observeHostEvidence(context?.hostAuthority);   // completion r2: authenticated Offline is durable + host-wide BEFORE verification
    const floor = row.digest ? { generation: row.generation, sequence: row.sequence, digest: row.digest } : null;
    let result;
    try { result = await verifyServingPermit(envelope, { ...context, pins: this.pins,
      nowSec: Math.floor(wall / 1000), floor, denyFloor: row.denial, ...(isHostAuthorityPermit(this.pins) ? { hostAuthorityFloor: this.hostAuthority.read(envelope.record.host)?.floor ?? null } : {}) }); }
    catch (e) {
      this.hold(id, 'permit authority refused');
      if (e.code === 'LIFECYCLE_DENIED' && e.denial) this.journal.deny(id, e.denial);
      throw e;
    }
    if (this.closed || epoch !== (this.epochs.get(id) || 0)) throw Error('permit installation superseded by revocation');
    const currentWall = this.#clock();
    if (result.serveUntil * 1000 <= currentWall) throw Error('permit expired during verification');
    const r = result.record;
    try {
      if (isHostAuthorityPermit(this.pins)) this.#acceptHostAuthority(id, result);   // host-authority permit r1: durable floor + explicit handoff BEFORE any resource
      if (result.restoredAt !== undefined && result.restoredAt !== null) this.journal.restoreDenial(id, result.restoredAt);
      this.journal.observeAssignment(id, r.generation, r.policyRevision, servingAssignmentBinding(this.pins, result.assignment, result.policy));
      this.journal.permit(id, { generation: r.generation, revision: r.policyRevision,
        sequence: r.sequence, digest: result.floor.digest });
    } catch (e) { this.hold(id, 'durable permit state refused'); throw e; }
    const old = this.entries.get(id);
    // Never let re-verifying the same envelope buy another monotonic lifetime.
    const deadline = Math.min(this.monotonic() + result.serveUntil * 1000 - currentWall,
      old?.digest === result.floor.digest ? old.deadline : Infinity);
    if (old) this.timers.clear(old.timer);
    if (old && (old.generation !== r.generation || old.host !== r.host)) this.#dropResources(id, 'assignment changed');
    if (old && (old.hostAuthority ?? null) !== (result.hostAuthority?.digest ?? null)) this.#dropResources(id, 'host authority changed');   // host-authority permit r1
    const entry = { host: r.host, generation: r.generation, digest: result.floor.digest, hostAuthority: result.hostAuthority?.digest ?? null,
      until: result.serveUntil * 1000, deadline, timer: null };
    this.entries.set(id, entry);
    const expire = () => {
      if (this.entries.get(id) !== entry) return;
      // A timer may fire early. Reschedule only to the ORIGINAL deadline.
      let remaining;
      try { remaining = Math.min(entry.until - this.#clock(), entry.deadline - this.monotonic()); }
      catch { return; }
      if (remaining > 0) { entry.timer = this.timers.set(expire, Math.ceil(remaining)); entry.timer?.unref?.(); }
      else this.hold(id, 'serving permit expired');
    };
    entry.timer = this.timers.set(expire, Math.max(0, Math.ceil(deadline - this.monotonic())));
    entry.timer?.unref?.();
    return { generation: r.generation, host: r.host, validUntil: entry.until, ...(entry.hostAuthority ? { hostAuthority: entry.hostAuthority } : {}) };
  }
  assert(id, { host, generation, hostAuthority = null }) {
    const wall = this.#clock(), e = this.entries.get(id);
    if (this.closed || !e || e.host !== host || e.generation !== generation || (e.hostAuthority ?? null) !== hostAuthority || !this.ownerLive() || wall >= e.until || this.monotonic() >= e.deadline) {
      this.hold(id, 'no current serving permit'); throw Error('no current serving permit');
    }
    return e.until;
  }
  // ---- host-authority permit r1 + completion r2 + ownership r3 ---------------------------------------------------------------
  #acceptHostAuthority(id, result) {
    const c = validateHostAuthorityContext(result.hostAuthority);
    // completion r2 coupling: an owned protocol journal that already holds this app's permit floor proves the sidecar was established
    if (!this.hostAuthority.read(c.hostId) && this.journal.read(id).digest) throw Error('established permit state without its host authority journal: unknown');
    this.observeHostAuthority(c);
    const b = this.hostAuthority.read(c.hostId)?.bound?.[id];
    if (!b || b.digest !== c.digest) throw Error('host authority changed or was never handed to this app context: explicit safe handoff required');
  }
  /** An authenticated advance of the host-wide floor withdraws every installed grant of ANOTHER authority for THAT host only. */
  observeHostAuthority(c) {
    validateHostAuthorityContext(c);
    let how;
    try { how = this.hostAuthority.accept(c.hostId, c); }
    catch (e) {   // rollback/equivocation/recorded Offline refuses THIS context; an uncertain/released durable state withdraws everything
      if (this.hostAuthority.failed?.() || this.hostAuthority.released?.()) for (const id of new Set([...this.entries.keys(), ...this.resources.keys()])) this.hold(id, 'host authority journal unknown');
      throw e;
    }
    if (how === 'advance') for (const [id, e] of [...this.entries]) if (e.host === c.hostId && e.hostAuthority !== c.digest) this.hold(id, 'host authority advanced');
    return how;
  }
  /**
   * completion r2: the caller's OWN authenticated evidence. An Offline observation for host H is recorded durably (no identity increment)
   * and withdraws EVERY grant of H; other hosts are untouched. Unqualified/Online/request-shaped evidence is ignored (never a veto).
   */
  observeHostEvidence(e) {
    const hostId = e?.context?.hostId;
    if (typeof hostId !== 'string' || !/^0x[0-9a-f]{64}$/.test(hostId)) return 'ignored';
    let how;
    try { how = this.hostAuthority.observe(hostId, e); }
    catch (err) {
      if (this.hostAuthority.failed?.() || this.hostAuthority.released?.()) for (const id of new Set([...this.entries.keys(), ...this.resources.keys(), ...(this.staged?.keys() ?? [])])) this.revoke(id, 'host authority journal unknown');
      throw err;
    }
    if (how === 'recorded' || how === 'already') {
      for (const [id, x] of [...this.entries]) if (x.host === hostId) this.hold(id, 'canonical host Offline');
      for (const id of this.stagedOn(hostId)) this.revoke(id, 'canonical host Offline');   // permit r6: Offline denial retires staged compute
    }
    return how;
  }
  /** Explicit safe handoff of ONE app context to the exact CURRENT Online host authority, only while nothing of it is installed or tracked. */
  handoffHostAuthority(id, c, { kind }) {
    if (this.closed) throw Error('permit gate closed');
    if (this.entries.has(id) || this.resources.has(id)) throw Error('handoff requires the app context withdrawn first (no installed grant or tracked resource)');
    this.observeHostAuthority(c);
    this.epochs.set(id, (this.epochs.get(id) || 0) + 1);   // an install already awaiting verification is superseded
    return this.hostAuthority.bind(c.hostId, id, c, { kind, at: this.#clock() });
  }
  /** ownership r3: an aborted adoption withdraws this app's grant AND its durable handoff binding (more restrictive only). */
  revokeHandoff(id, hostId) {
    this.hold(id, 'handoff revoked');
    return this.hostAuthority.unbind(hostId, id);
  }
  // ---- async r4 + completion r5: owner liveness on every use + awaited, never-forgotten withdrawals ------------------------------
  /** the per-app revocation epoch (bumped by every hold/handoff); runtime operations pin it after their handoff */
  epochOf(id) { return this.epochs.get(id) || 0; }
  /** false once closed, released or the owner's lock is lost (assertLive starts the owner withdrawal, which closes this gate) */
  ownerLive() {
    if (this.closed) return false;
    if (typeof this.hostAuthority?.assertLive !== 'function') return true;
    try { this.hostAuthority.assertLive(); } catch { return false; }
    return !this.closed;
  }
  /** register an in-flight runtime operation; close()'s completion waits for it and fails if it rejects. Refused once not live. */
  work(settled, id = null) {
    if (!this.ownerLive()) throw Error('permit gate closed: no new runtime work under a released or lost owner');
    return this.#withdrawal(id, settled);
  }
  /** completion r5: STAGED compute (spawned/ready, never served yet) is owned: close() withdraws it via `withdraw` and awaits it */
  stage(id, withdraw, { host = null } = {}) {
    if (typeof withdraw !== 'function') throw Error('staged compute requires a withdrawal');
    if (!this.ownerLive()) throw Error('permit gate closed: no staged compute under a released or lost owner');
    (this.staged ??= new Map()).set(id, { withdraw, host });
  }
  unstage(id) { this.staged?.delete(id); }
  /**
   * permit r6: PURPOSE-SPECIFIC withdrawal. hold() stays the routine nondestructive fence (a staged, still-authorized instance keeps its
   * compute across queued readiness passes). revoke() is AUTHORITY withdrawal (explicit revocation, Offline denial, unknown authority
   * journal): hold PLUS exact retirement of this app's staged compute, started synchronously here, never behind a boundary acknowledgment.
   * -> the owned retirement promise (null when nothing is staged). A failed retirement is recorded AND re-staged so it stays retryable.
   */
  revoke(id, reason = 'authority revoked') {
    this.hold(id, reason);
    return this.#retireStaged(id, reason);
  }
  /** permit r6: the staged instances of host H (an Offline denial of H retires exactly these, never another host's) */
  stagedOn(hostId) { return [...(this.staged ?? [])].filter(([, s]) => s.host === hostId).map(([id]) => id); }
  #retireStaged(id, reason) {
    const s = this.staged?.get(id); if (!s) return null;
    this.staged.delete(id);
    return this.#withdrawal(id, (async () => s.withdraw(reason))().catch(e => { if (!this.staged.has(id)) this.staged.set(id, s); throw e; }));
  }
  /** completion r5: recorded (settled) withdrawal failures; they survive their Promise and keep every later close() rejecting */
  withdrawalFailures() { return [...(this.failedWithdrawals ?? new Map())].map(([id, error]) => ({ id, error })); }
  /** completion r5: ONLY with explicit proof (confirmed manager absence AND acknowledged boundary hold) is a recorded failure cleared */
  withdrawalProven(id, proof) {
    if (proof?.absent !== true || proof?.held !== true) throw Error('a failed withdrawal is cleared only by proven absence and an acknowledged hold');
    return this.failedWithdrawals?.delete(id) ?? false;
  }
  #withdrawal(id, p) {
    const q = Promise.resolve(p), set = (this.withdrawals ??= new Set());
    set.add(q);
    q.then(() => { set.delete(q); },
      error => { (this.failedWithdrawals ??= new Map()).set(id ?? '*', error); set.delete(q); });   // r5: recorded BEFORE leaving the pending set
    return q;
  }
  #trackWithdrawal(id, close) {
    return reason => this.#withdrawal(id, (async () => close(reason))());   // starts synchronously; a synchronous throw becomes a rejection
  }
  #settleWithdrawals() {
    const p = (async () => {
      await null;   // r5: published first; close() registers its synchronous withdrawals before the first check
      while (this.withdrawals?.size) await Promise.allSettled([...this.withdrawals]);
      const failures = [...(this.failedWithdrawals ?? new Map()).values()];
      if (failures.length) throw new AggregateError(failures, 'permit gate withdrawal incomplete or previously failed: the owner authority stays fenced');
      return true;
    })();
    p.catch(error => this.onError?.(error));   // floating close() calls (clock discontinuity) are reported, not unhandled; awaiters still see it
    return p;
  }
  track(id, binding, close) {
    if (typeof close !== 'function') throw Error('resource requires a close callback');
    this.assert(id, binding);
    const resources = this.resources.get(id) || new Set(); this.resources.set(id, resources);
    close = this.#trackWithdrawal(id, close);   // async r4 + r5: the close callback's completion AND failure are retained per app
    resources.add(close);
    return () => { resources.delete(close); if (!resources.size) this.resources.delete(id); };
  }
  #dropResources(id, reason) {
    const resources = this.resources.get(id); this.resources.delete(id);
    for (const close of resources || []) {
      try { Promise.resolve(close(reason)).catch(this.onError); } catch (e) { this.onError(e); }
    }
  }
  hold(id, reason = 'held') {
    this.epochs.set(id, (this.epochs.get(id) || 0) + 1);
    const e = this.entries.get(id); if (e) this.timers.clear(e.timer);
    this.entries.delete(id); this.#dropResources(id, reason);
  }
  fence(id, generation) {
    // Withdraw resources even if durable fencing fails, then remain closed.
    this.hold(id, 'generation fenced');
    try { this.journal.fence(id, generation); }
    catch (e) { this.close('fence persistence failed'); throw e; }
  }
  close(reason = 'gate closed') {
    this.closed = true;
    const closing = (this.closing ??= this.#settleWithdrawals());   // completion r5: ONE completion published BEFORE any callback (re-entrant close returns it)
    const staged = [...(this.staged ?? [])]; this.staged?.clear();
    for (const [sid, s] of staged) this.#withdrawal(sid, (async () => s.withdraw(reason))());   // completion r5: staged compute is an owned resource
    for (const id of new Set([...this.entries.keys(), ...this.resources.keys()])) this.hold(id, reason);
    return closing;   // async r4 + completion r5: the memoized completion
  }
}
