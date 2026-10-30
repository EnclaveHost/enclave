// Portable adapter for the existing guestd/Hyper-V manager HTTP contract.
// No legacy ledger release/renew call is made here. Network/storage/secret
// boundary acknowledgements and the existing measured launch verifier are
// mandatory dependencies, not inferred from a manager saying "running".
// host-authority permit r1: v2 permit records carry the exact host authority; the gate receives the REAL snapshot->servingContext conversion
import { isHostAuthorityPermit, permitHostAuthorityOf, servingContextOf } from './deployment-host-authority.mjs';
export function createIsolationLifecycleRuntime({ client, gate, journal, plans, readiness, collectPermit, boundaries, host, now = Date.now, boundaryTimeoutMs = 3000 }) {
  if (![client?.findByName, client?.spawn, client?.remove, plans?.read, readiness?.verify,
    boundaries?.hold, boundaries?.allow, collectPermit].every(fn => typeof fn === 'function'))
    throw Error('lifecycle runtime requires manager, plan, readiness and enforced boundary adapters');
  if (!Number.isInteger(boundaryTimeoutMs) || boundaryTimeoutMs < 1 || boundaryTimeoutMs > 5000)
    throw Error('boundary timeout must be within 1..5000 ms');
  const instances = new Map();
  const inflight = new Map();   // permit r6: id -> settled promises of owned operations still running
  const V2 =isHostAuthorityPermit(gate?.pins);   // host-authority permit r1 (the gate carries the reviewed pins)
  if (V2 && (typeof gate.handoffHostAuthority !== 'function' || typeof gate.revoke !== 'function')) throw Error('v2 runtime requires the host-authority permit gate (r6: with purpose-specific revoke)');
  // async r4 (v2 only): remove an instance and CONFIRM absence through an independent manager lookup; any failure/unknown rejects
  async function removeConfirmed(id, instance) {
    if (instance) await client.remove(instance);
    let view = await client.findByName(id);
    if (view) { await client.remove(view.id); view = await client.findByName(id); }
    if (view) throw Error('runtime instance not confirmed absent after authority withdrawal: the owner stays fenced');
  }
  // async r4 + completion r5 (v2 only): one owned operation (start OR serve). It is registered with the gate BEFORE any side effect (refused
  // if the owner is gone), re-checks owner liveness + this app's revocation epoch after every await, and close()'s completion waits for its
  // end, rejecting if its withdrawal of a started instance (or its acknowledged boundary fence) failed. Legacy (v1): inert, exact old behavior.
  function opOf(id) {
    if (!V2) return { pin() {}, live: () => true, check() {}, async withdraw() {}, spawn: p => p, fault() {}, end() {} };
    let epoch = null, failure = null, finish;
    const settled = new Promise((resolve, reject) => { finish = () => (failure ? reject(failure) : resolve(true)); });
    gate.work(settled, id);
    // permit r6: an authority withdrawal of `id` waits for these (their late effects are withdrawn by op.spawn) before confirming absence
    const mine = inflight.get(id) ?? new Set(); inflight.set(id, mine); mine.add(settled);
    settled.catch(() => {}).finally(() => { mine.delete(settled); if (!mine.size && inflight.get(id) === mine) inflight.delete(id); });
    const live = () => gate.ownerLive() && (epoch === null || gate.epochOf(id) === epoch);
    const op = {
      fencing: false,
      pin() { epoch = gate.epochOf(id); },
      live,
      check() { if (!live()) throw Error('runtime authority closed or revoked during an await: no new side effect'); },
      async withdraw(instance) { try { await removeConfirmed(id, instance); } catch (e) { failure ??= e; throw e; } },
      async spawn(pending) {        // initiated while live; its outcome is withdrawn if authority ended meanwhile
        let r;
        try { r = await pending; } catch (e) { if (!live()) await op.withdraw(null); throw e; }
        if (!live()) { await op.withdraw(r?.view?.id); throw Error('runtime authority closed during spawn: the started instance was withdrawn'); }
        return r;
      },
      fault(e) { failure ??= e; },   // r5: an unacknowledged withdrawal of this operation's remote effect fences the owner
      end() { finish(); },
    };
    return op;
  }
  const releaseResource = new Map();
  const held = new Set();
  async function boundaryCall(name, ...args) {
    const controller = new AbortController();
    let timer;
    if (V2 && name === 'allow') {
      if (!gate.ownerLive()) throw Error('owner released before raw allow');
      const id = args[0], epoch = gate.epochOf(id);
      // Track the real operation, not the timeout race. Aborting a request is not proof it stopped.
      const raw = Promise.resolve().then(() => boundaries[name](...args, { signal: controller.signal }));
      const cleanup = async () => {
        if (!controller.signal.aborted && gate.ownerLive() && gate.epochOf(id) === epoch) return;
        const results = await Promise.allSettled([boundaryCall('hold', id), removeConfirmed(id, null)]);
        const error = results.find(r => r.status === 'rejected');
        if (error) throw error.reason;
        const ack = results[0].value;
        if (ack?.deployment !== id || ack?.ingress !== true || ack?.storage !== true || ack?.secrets !== true)
          throw Error('late raw allow withdrawal not acknowledged');
      };
      gate.work(raw.then(cleanup, cleanup), id);
      try {
        return await Promise.race([raw, new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('runtime boundary allow timed out')), boundaryTimeoutMs);
        })]);
      } finally { clearTimeout(timer); controller.abort(); }
    }
    try {
      return await Promise.race([
        Promise.resolve().then(() => boundaries[name](...args, { signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`runtime boundary ${name} timed out`)), boundaryTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async function revokeInstance(id, instance) {
    // A remote boundary can hang or ignore cancellation. Removing this exact
    // VM must start independently of that acknowledgment, never behind it.
    const results = await Promise.allSettled([boundaryCall('hold', id), client.remove(instance)]);
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
  // permit r6: fence() is the ROUTINE purpose: it withdraws serving and restricts I/O, but a staged, still-authorized instance keeps its
  // compute (repeated queued readiness reuses that one instance under its unchanged absolute deadline). It is never authority withdrawal.
  async function fence(id) {
    gate.hold(id, 'runtime withdrawn');
    await acknowledgeHold(id);
  }
  async function acknowledgeHold(id) {
    const ack = await boundaryCall('hold', id);
    if (ack?.deployment !== id || ack?.ingress !== true || ack?.storage !== true || ack?.secrets !== true)
      throw Error('runtime boundary withdrawal not acknowledged');
    held.add(id);
  }
  // permit r6: AUTHORITY withdrawal. `retiring` was started synchronously by gate.revoke (the caller's first statement), so exact compute
  // retirement never waits behind a slow or hung boundary. Owned in-flight operations finish first (a late spawn is withdrawn by op.spawn),
  // then absence is CONFIRMED by an exact-name manager lookup. Resolves only on confirmed absence AND an acknowledged hold; rejects
  // otherwise (compute may already be absent while the boundary is unacknowledged: the owner stays fenced, the failure stays recorded).
  // permit r7 (root late-spawn regression: 'boundary withdrawal not acknowledged'): while one of this app's owned raw stages is still in
  // flight its outcome is an owned unknown, so a hold asked THEN can truthfully never be acknowledged. Compute retirement still starts
  // at once (`retiring`); the boundary is asked only after the owned in-flight operations settle (a late spawn is withdrawn by op.spawn),
  // so the answer describes the terminal state. A stage whose outcome stays unknown keeps the acknowledgment false: the owner stays fenced.
  async function withdrawAuthority(id, retiring) {
    const late = [...(inflight.get(id) ?? [])];
    const [ack, removal] = await Promise.allSettled([
      (async () => { await Promise.allSettled(late); await acknowledgeHold(id); })(),
      (async () => { await retiring; await Promise.allSettled(late); await removeConfirmed(id, null); })()]);
    if (removal.status === 'rejected') throw removal.reason;
    if (ack.status === 'rejected') throw ack.reason;
    instances.delete(id);
    const known = journal.read(id).runtime;
    if (known) journal.retireRuntime(id, known.instance);
    gate.withdrawalProven(id, { absent: true, held: true });
    return { absent: true, held: true };
  }
  async function stop(id) {
    // A broken boundary cannot prevent an explicit stop from retiring compute.
    const withdrawal = fence(id).then(() => null, error => error);
    const view = await client.findByName(id);
    if (view) await client.remove(view.id);
    if (await client.findByName(id)) return false;
    const known = journal.read(id).runtime;
    if (known) journal.retireRuntime(id, known.instance);
    instances.delete(id); releaseResource.get(id)?.(); releaseResource.delete(id);
    const error = await withdrawal;
    if (error) throw error;
    if (V2) { gate.unstage(id); gate.withdrawalProven(id, { absent: true, held: true }); }   // completion r5: Stop proved absence + acknowledged hold
    return true;
  }
  async function checked(id, generation, view, plan) {
    if (!view) return { ready: false, ended: false };
    if (plan?.verified !== true || plan.host !== host || plan.body?.name !== id) return { ready: false, ended: false };
    if (view.name !== id || !view.id || view.recovered) return { ready: false, ended: false };
    const remembered = journal.rememberRuntime(id, { instance: view.id, generation, now: now() });
    instances.set(id, remembered);
    if (['failed', 'stopped'].includes(view.status)) return { ready: false, ended: true, instance: view.id };
    const result = await readiness.verify({ deployment: id, host, generation, view, plan });
    return { ready: view.status === 'running' && result?.verified === true && result.ready === true && result.deployment === id &&
      result.host === host && result.generation === generation && result.instance === view.id &&
      Number.isSafeInteger(result.validUntil) && result.validUntil > now(),
    ended: false, instance: view.id };
  }
  return {
    hostAuthorityPermit: V2,   // completion r2: the dispatch requires exactly this for independent-host-registry-r1 serving and handoff
    fence, stop,
    async health(id, generation) {
      const view = await client.findByName(id);
      if (!view) {
        const known = instances.get(id) || journal.read(id).runtime;
        return { ready: false, ended: known?.generation === generation, instance: known?.instance };
      }
      return checked(id, generation, view, await plans.read(id));
    },
    async ensureStaged(id, snapshot) {
      const op = opOf(id); try {   // async r4: owned operation (registered before any side effect)
      await fence(id);
      const plan = await plans.read(id, snapshot);
      op.check();   // async r4: plans.read (and the boundary hold) may resolve after close/revocation
      if (!held.has(id) || plan?.verified !== true || plan.body?.name !== id || plan.host !== host || plan.stagingEnforced !== true)
        throw Error('no verified launch plan with staged I/O enforcement');
      if (V2) {   // host-authority permit r1: a FRESH queued start is an explicit handoff to the current host authority (never a genesis default)
        if (snapshot?.assignment?.state !== 'queued') throw Error('host authority handoff only from a fresh queued origin');
        gate.handoffHostAuthority(id, permitHostAuthorityOf(snapshot), { kind: 'fresh-queued-start' });
      }
      op.pin();   // async r4: this start's revocation epoch (after fence + handoff)
      let view = await client.findByName(id);
      op.check();   // async r4: the manager lookup may resolve after close: NO spawn is initiated then
      if (!view) {
        const attempt = journal.beginAttempt(id);
        try { view = (await op.spawn(client.spawn(plan.body))).view; }
        catch (e) {
          op.check();   // async r4: authority ended during spawn -> refuse (the instance was already withdrawn by op.spawn)
          if (e.kind === 'refused') return { ready: false, ended: true, instance: `boot:${id}:${attempt}` };
          // An ambiguous POST must be reconciled with manager inventory before
          // another attempt. The next pass begins with findByName again.
          return { ready: false, ended: false, reason: 'launch outcome unknown' };
        }
      }
      if (V2 && view?.id) gate.stage(id, () => removeConfirmed(id, view.id), { host }); // own compute before readiness can reject (r6: host-bound for Offline)
      const result = await checked(id, snapshot.assignment.generation + 1, view, plan);
      if (!op.live()) { await op.withdraw(view?.id); op.check(); }   // async r4: readiness resolved after close: withdraw what this start staged
      const deadline = plan.startupDeadlineMs ?? 180000;
      if (!Number.isInteger(deadline) || deadline < 1000 || deadline > 600000) throw Error('invalid startup deadline');
      const runtime = journal.read(id).runtime;
      if (!result.ready && !result.ended && runtime && now() - runtime.startedAt >= deadline) {
        if (await stop(id)) return { ready: false, ended: true, instance: runtime.instance };
      }
      return result;
      } finally { op.end(); }   // async r4
    },
    /**
     * host-authority permit r1: EXPLICIT safe adoption of an app context into the exact current host authority. completion r2: called ONLY
     * by the dispatch's serialized adoptHostIncarnation after its fresh pre/post reads, pending/nonfinal refusal, owner-epoch checks and
     * independently confirmed quiescence, with that adoption's final fresh snapshot. Old-context serving is withdrawn first.
     */
    async adoptHostAuthority(id, snapshot) {
      if (!V2) throw Error('host authority adoption exists only for v2 permits');
      if (!gate.ownerLive()) throw Error('permit gate closed: no adoption under a released or lost owner');   // async r4
      await fence(id);
      return gate.handoffHostAuthority(id, permitHostAuthorityOf(snapshot), { kind: 'explicit-adoption' });
    },
    /**
     * ownership r3: the dispatch's abort path when the canonical recheck AFTER adoptHostAuthority fails. async r4: the grant and the durable
     * handoff binding are withdrawn SYNCHRONOUSLY first; the newer canonical authority is observed; only then is the boundary fence awaited.
     */
    async revokeHostAuthority(id, snapshot) {
      if (!V2) return false;
      const retiring = gate.revoke(id, 'host authority revoked');   // permit r6: staged compute retirement starts NOW, not after any ack
      gate.revokeHandoff(id, host);
      const e = snapshot?.hostAuthorityEvidence;
      if (e?.proofVerified === true) {
        if (e.status === 'offline') gate.observeHostEvidence(e);
        else try { gate.observeHostAuthority(e.context); } catch { /* an older/equal view adds nothing; the binding is already gone */ }
      }
      return withdrawAuthority(id, retiring);   // permit r6: stronger than fence(): resolves only on CONFIRMED absence + acknowledged hold
    },
    /** permit r6: explicit app authority revocation (Offline denial / revoked assignment) for one app: retire compute, not just fence I/O */
    async revokeAuthority(id, reason = 'app authority revoked') {
      if (!V2) return false;
      return withdrawAuthority(id, gate.revoke(id, reason));
    },
    async serve(id, snapshot) {
      if (!V2 && snapshot?.profile === 'independent-host-registry-r1') throw Error('independent-host-registry-r1 serves only through v2 host-authority permits');   // completion r2
      const op = opOf(id); try {   // completion r5: serve is an owned operation registered BEFORE its first await
      const assignment = snapshot.assignment;
      if (assignment.host !== host || assignment.state !== 'running') throw Error('not assigned here');
      const instance = instances.get(id);
      if (!instance || instance.generation !== assignment.generation) throw Error('runtime instance not verified for this generation');
      const row = journal.read(id), issuedAt = Math.floor(now() / 1000);
      const record = { deployment: id, host, generation: assignment.generation,
        policyRevision: assignment.revision, sequence: row.sequence + 1, issuedAt, validUntil: issuedAt + 20 };
      if (V2) record.hostAuthority = permitHostAuthorityOf(snapshot);   // host-authority permit r1: signed inside the v2 typed data
      const envelope = await collectPermit(record, snapshot.policy);
      try {
        const grant = await gate.install(envelope, servingContextOf(gate.pins, snapshot) ?? snapshot.servingContext);
        releaseResource.get(id)?.();
        // Register before the first remote await. A stalled allow request must
        // not leave compute alive after the local permit expires.
        releaseResource.set(id, gate.track(id, { host, generation: grant.generation, ...(V2 ? { hostAuthority: grant.hostAuthority } : {}) }, () => revokeInstance(id, instance.instance)));
        if (V2) gate.unstage(id);   // completion r5: the tracked serving resource now owns this compute (its revokeInstance removes it)
        // The boundary uses exactly this deadline and generation. It must never
        // turn this into a fresh duration when it receives or retries the update.
        const ack = await boundaryCall('allow', id, grant);
        gate.assert(id, { host, generation: grant.generation, ...(V2 ? { hostAuthority: grant.hostAuthority } : {}) });
        if (ack?.deployment !== id || ack?.generation !== grant.generation || ack?.validUntil !== grant.validUntil || ack?.expiryEnforced !== true)
          throw Error('runtime boundary grant not acknowledged');
        if (V2 && ack?.hostAuthority !== grant.hostAuthority) throw Error('runtime boundary did not bind the exact host authority');   // host-authority permit r1
        held.delete(id);
      } catch (e) { op.fencing = true; await fence(id); op.fencing = false; throw e; }
      } catch (e) { if (op.fencing) op.fault(e); throw e; } finally { op.end(); }   // completion r5: an unacknowledged late-effect withdrawal fences
    },
  };
}
