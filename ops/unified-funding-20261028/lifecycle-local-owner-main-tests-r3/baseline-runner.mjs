// Event-driven host controller, shared by Windows and Linux. Adapters retain
// the existing authenticated chain reads, owner/admin/catalog gates, measured
// launch and secret-release verification. The legacy lease loop must never run
// for the same deployment. This module has NO renew/checkpoint/heartbeat-tx API.
//
// runtime.ensureStaged boots WITHOUT an authoritative serving/write permit;
// runtime.serve may enable traffic only after obtaining a fresh quorum permit.
// runtime.fence revokes existing streams/storage access as well as new requests.
// A chain read is never considered verified merely because HTTP returned 200.
import { verifyGenerationChain } from './deployment-generation-certificate.mjs';
import { canRestoreLifecycleDenial, lifecycleHostAdmitted } from './deployment-authority-window.mjs';

export class DeploymentLifecycleRunner {
  constructor({ chain, runtime, journal, pins = null, now = Date.now, random = Math.random }) {
    this.chain = chain; this.runtime = runtime; this.journal = journal;
    this.now = now; this.random = random; this.pins = pins; this.busy = new Set();
  }
  async reconcile(id) {
    if (this.busy.has(id)) return { status: 'busy' };
    this.busy.add(id);
    try { return await this.#reconcile(id); }
    catch (e) { await this.runtime.fence(id); return { status: 'held', reason: `lifecycle adapter failed: ${e.message}` }; }
    finally { this.busy.delete(id); }
  }
  async #reconcile(id) {
    let now = this.now();
    let snapshot;
    try { snapshot = await this.chain.read(id); }
    catch (e) { await this.runtime.fence(id); return { status: 'held', reason: `chain authority unavailable: ${e.message}` }; }
    now = this.now();
    let operational = null;
    if (snapshot.generationAuthority) {
      try {
        if (!this.pins) throw Error('reviewed lifecycle pins required');
        const g = snapshot.generationAuthority;
        const localDenial = this.journal.read(id).denial;
        const denial = localDenial || g.denyFloor;
        operational = await verifyGenerationChain(g.certificates, { ...g, pins: this.pins, nowSec: Math.floor(now / 1000), denyFloor: null });
        const hostAdmitted = lifecycleHostAdmitted(g.anchor, snapshot.thisHost);
        if (denial && !canRestoreLifecycleDenial(denial, g.anchor, Math.floor(now / 1000))) throw Error('authenticated restoration required');
        if (localDenial) this.journal.restoreDenial(id, g.anchor.number);
        const a = operational.assignment;
        snapshot = { ...snapshot, verified: true, authorityTier: g.anchor.tier,
          enabled: g.anchor.enabled === true, admitted: hostAdmitted,
          funded: a.remainingWei > BigInt(g.policy.stopReserveWei) && a.fundedUntil * 1000 > now,
          policy: g.policy, servingContext: { generationAuthority: g },
          assignment: { ...a, revision: g.policy.revision, startAfter: a.startAfter * 1000 } };
      } catch (e) {
        await this.runtime.fence(id);
        if (e.code === 'LIFECYCLE_DENIED' && e.denial) {
          this.journal.deny(id, e.denial);
          await this.runtime.stop(id);
        }
        return { status: 'held', reason: `operational authority refused: ${e.message}` };
      }
    }
    if (snapshot.schema !== 2 || snapshot.id !== id || snapshot.verified !== true ||
        !['safe', 'finalized', 'l1-finalized-derived'].includes(snapshot.authorityTier) ||
        (!operational && (!Number.isSafeInteger(snapshot.blockAt) || snapshot.blockAt > now + 2000 || now - snapshot.blockAt > 20000))) {
      await this.runtime.fence(id);
      return { status: 'held', reason: 'unqualified or stale lifecycle authority' };
    }
    const { assignment } = snapshot;
    if (!assignment || !['queued', 'running', 'stopped'].includes(assignment.state)) {
      await this.runtime.fence(id); return { status: 'held', reason: 'unknown assignment' };
    }
    // A recently verified read can still be older than one this host already
    // acted on. Persist the floor before enabling a runtime or preparing a tx.
    try { this.journal.observeAssignment(id, assignment.generation, assignment.revision); }
    catch (e) {
      await this.runtime.fence(id);
      return { status: 'held', reason: `assignment journal refused: ${e.message}` };
    }
    const local = this.journal.read(id);
    if (local.minedTransitions.length) {
      if (typeof this.chain.finalize !== 'function') { await this.runtime.fence(id); return { status: 'held', reason: 'finality reconciliation adapter missing' }; }
      for (const intent of local.minedTransitions) {
        const resolution = await this.chain.finalize(id, intent);
        if (resolution?.verified !== true || resolution.digest !== intent.digest) continue;
        if (resolution.outcome === 'finalized' && resolution.proofVerified === true &&
            ['finalized', 'l1-finalized-derived'].includes(resolution.authorityTier)) this.journal.settleMined(id, intent.digest);
        else if (resolution.outcome === 'reorged' && resolution.proofVerified === true) {
          await this.runtime.fence(id); await this.runtime.stop(id);
          return { status: 'held', reason: 'mined transition reorganized; exact intent retained for recovery' };
        }
      }
    }
    // A lost relay response is NOT a failed transition. Settle/replay the exact
    // durable intent before preparing any replacement or launching a new VM.
    if (local.pending) {
      const resolution = await this.chain.resolve(id, local.pending);
      const certified = operational && snapshot.generationAuthority.certificates.some(c => c.record.transitionIntent === local.pending.digest);
      if (certified && resolution?.verified === true && resolution.digest === local.pending.digest && resolution.outcome === 'mined' &&
          resolution.proofVerified === true && ['unsafe', 'safe', 'finalized'].includes(resolution.authorityTier)) {
        if (typeof this.chain.finalize !== 'function') { await this.runtime.fence(id); return { status: 'held', reason: 'finality reconciliation adapter missing' }; }
        this.journal.archiveMined(id, local.pending.digest, resolution);
      } else {
        if (resolution?.verified !== true || resolution.proofVerified !== true ||
            !['finalized', 'l1-finalized-derived'].includes(resolution.authorityTier) || resolution.digest !== local.pending.digest ||
            !['confirmed', 'finalized-fence'].includes(resolution.outcome))
          return { status: 'pending', reason: 'transition outcome unresolved' };
        this.journal.settleTransition(id, local.pending.digest);
        return { status: 'reconcile', reason: 'transition settled; refresh assignment' };
      }
    }
    if (assignment.state === 'stopped') {
      await this.runtime.fence(id); await this.runtime.stop(id);
      return { status: 'stopped' };
    }
    if (assignment.state === 'running' && assignment.host !== snapshot.thisHost) {
      await this.runtime.fence(id); await this.runtime.stop(id);
      return { status: 'elsewhere' };
    }
    if (snapshot.enabled !== true || snapshot.funded !== true) {
      await this.runtime.fence(id);
      if (!await this.runtime.stop(id)) return { status: 'held', reason: 'stop not confirmed' };
      return this.#transition(id, snapshot, 'stopped', 'admission or spendable funds exhausted');
    }
    if (snapshot.admitted !== true) {
      await this.runtime.fence(id);
      if (!await this.runtime.stop(id)) return { status: 'held', reason: 'stop not confirmed' };
      if (assignment.state === 'running') return this.#transition(id, snapshot, 'queued', 'host no longer admits this workload');
      return { status: 'queued', reason: 'this host cannot admit this workload' };
    }
    if (assignment.state === 'running') {
      const health = await this.runtime.health(id, assignment.generation);
      if (health.ready === true) {
        this.journal.healthy(id, { now });
        await this.runtime.serve(id, snapshot); // internally requires quorum permit
        return { status: 'running' };
      }
      this.journal.unhealthy(id, now);
      await this.runtime.fence(id);
      if (health.ended !== true) return { status: 'held', reason: 'readiness unknown; no failure inferred' };
      if (typeof health.instance !== 'string' || !health.instance.length) return { status: 'held', reason: 'failure has no instance identity' };
      this.journal.failure(id, { identity: health.instance, now, random: this.random });
      if (!await this.runtime.stop(id)) return { status: 'held', reason: 'retirement not confirmed' };
      return this.#transition(id, snapshot, 'queued', 'instance ended');
    }
    const decision = this.journal.decision(id, now);
    if (!decision.start || assignment.crashHeld || now < assignment.startAfter)
      return { status: 'queued', reason: decision.reason || (assignment.crashHeld ? 'repeated crashes; owner resume required' : 'generation fence/backoff') };
    const staged = await this.runtime.ensureStaged(id, snapshot);
    if (staged.ended === true) {
      this.journal.failure(id, { identity: staged.instance, now, random: this.random });
      await this.runtime.fence(id); await this.runtime.stop(id);
      // It was already queued. A failed boot never creates another queued
      // transaction, nor a misleading running/stopped pair.
      return { status: 'queued', reason: 'startup failed; restart backoff' };
    }
    if (staged.ready !== true) return { status: 'queued', reason: 'starting without a serving permit' };
    return this.#transition(id, snapshot, 'running', 'readiness verified');
  }
  async #transition(id, snapshot, target, reason) {
    const intent = await this.chain.prepare(id, snapshot, target, reason);
    // prepare returns an unsigned, fully bound intent. submit signs only after
    // this write succeeds; it must never silently change fees/generation/payee.
    this.journal.prepareTransition(id, intent);
    try { await this.chain.submit(id, intent); }
    catch { return { status: 'pending', reason: 'submission uncertain; exact intent retained' }; }
    return { status: 'pending', reason: `${target} transition submitted; awaiting verified receipt` };
  }
}
