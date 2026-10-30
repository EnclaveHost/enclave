// The permit boundary used by ingress, secret release and storage adapters.
// Timers revoke existing resources; every new operation also checks wall AND
// monotonic deadlines, so a paused event loop or a backwards clock cannot renew
// access. Callers must register streams/handles with track() and call assert()
// before each write or secret release. A read-only status is never authority.
import { performance } from 'node:perf_hooks';
import { verifyServingPermit, servingAssignmentBinding } from './deployment-serving-permit.mjs';

export class DeploymentPermitGate {
  constructor({ pins, journal, now = Date.now, monotonic = () => performance.now(),
    timers = { set: setTimeout, clear: clearTimeout }, onError = () => {} }) {
    Object.assign(this, { pins, journal, now, monotonic, timers, onError });
    this.entries = new Map(); this.epochs = new Map(); this.resources = new Map();
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
    const floor = row.digest ? { generation: row.generation, sequence: row.sequence, digest: row.digest } : null;
    let result;
    try { result = await verifyServingPermit(envelope, { ...context, pins: this.pins,
      nowSec: Math.floor(wall / 1000), floor, denyFloor: row.denial }); }
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
    const entry = { host: r.host, generation: r.generation, digest: result.floor.digest,
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
    return { generation: r.generation, host: r.host, validUntil: entry.until };
  }
  assert(id, { host, generation }) {
    const wall = this.#clock(), e = this.entries.get(id);
    if (this.closed || !e || e.host !== host || e.generation !== generation || wall >= e.until || this.monotonic() >= e.deadline) {
      this.hold(id, 'no current serving permit'); throw Error('no current serving permit');
    }
    return e.until;
  }
  track(id, binding, close) {
    if (typeof close !== 'function') throw Error('resource requires a close callback');
    this.assert(id, binding);
    const resources = this.resources.get(id) || new Set(); this.resources.set(id, resources);
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
    for (const id of new Set([...this.entries.keys(), ...this.resources.keys()])) this.hold(id, reason);
  }
}
