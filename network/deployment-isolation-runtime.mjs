// Portable adapter for the existing guestd/Hyper-V manager HTTP contract.
// No legacy ledger release/renew call is made here. Network/storage/secret
// boundary acknowledgements and the existing measured launch verifier are
// mandatory dependencies, not inferred from a manager saying "running".
export function createIsolationLifecycleRuntime({ client, gate, journal, plans, readiness, collectPermit, boundaries, host, now = Date.now }) {
  if (![client?.findByName, client?.spawn, client?.remove, plans?.read, readiness?.verify,
    boundaries?.hold, boundaries?.allow, collectPermit].every(fn => typeof fn === 'function'))
    throw Error('lifecycle runtime requires manager, plan, readiness and enforced boundary adapters');
  const instances = new Map();
  const releaseResource = new Map();
  const held = new Set();
  async function fence(id) {
    gate.hold(id, 'runtime withdrawn');
    const ack = await boundaries.hold(id);
    if (ack?.deployment !== id || ack?.ingress !== true || ack?.storage !== true || ack?.secrets !== true)
      throw Error('runtime boundary withdrawal not acknowledged');
    held.add(id);
  }
  async function stop(id) {
    await fence(id);
    const view = await client.findByName(id);
    if (view) await client.remove(view.id);
    if (await client.findByName(id)) return false;
    const known = journal.read(id).runtime;
    if (known) journal.retireRuntime(id, known.instance);
    instances.delete(id); releaseResource.get(id)?.(); releaseResource.delete(id);
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
      await fence(id);
      const plan = await plans.read(id, snapshot);
      if (!held.has(id) || plan?.verified !== true || plan.body?.name !== id || plan.host !== host || plan.stagingEnforced !== true)
        throw Error('no verified launch plan with staged I/O enforcement');
      let view = await client.findByName(id);
      if (!view) {
        const attempt = journal.beginAttempt(id);
        try { view = (await client.spawn(plan.body)).view; }
        catch (e) {
          if (e.kind === 'refused') return { ready: false, ended: true, instance: `boot:${id}:${attempt}` };
          // An ambiguous POST must be reconciled with manager inventory before
          // another attempt. The next pass begins with findByName again.
          return { ready: false, ended: false, reason: 'launch outcome unknown' };
        }
      }
      const result = await checked(id, snapshot.assignment.generation + 1, view, plan);
      const deadline = plan.startupDeadlineMs ?? 180000;
      if (!Number.isInteger(deadline) || deadline < 1000 || deadline > 600000) throw Error('invalid startup deadline');
      const runtime = journal.read(id).runtime;
      if (!result.ready && !result.ended && runtime && now() - runtime.startedAt >= deadline) {
        if (await stop(id)) return { ready: false, ended: true, instance: runtime.instance };
      }
      return result;
    },
    async serve(id, snapshot) {
      const assignment = snapshot.assignment;
      if (assignment.host !== host || assignment.state !== 'running') throw Error('not assigned here');
      const instance = instances.get(id);
      if (!instance || instance.generation !== assignment.generation) throw Error('runtime instance not verified for this generation');
      const row = journal.read(id), issuedAt = Math.floor(now() / 1000);
      const record = { deployment: id, host, generation: assignment.generation,
        policyRevision: assignment.revision, sequence: row.sequence + 1, issuedAt, validUntil: issuedAt + 20 };
      const envelope = await collectPermit(record, snapshot.policy);
      try {
        const grant = await gate.install(envelope, snapshot.servingContext);
        // The boundary uses exactly this deadline and generation. It must never
        // turn this into a fresh duration when it receives or retries the update.
        const ack = await boundaries.allow(id, grant);
        if (ack?.deployment !== id || ack?.generation !== grant.generation || ack?.validUntil !== grant.validUntil || ack?.expiryEnforced !== true)
          throw Error('runtime boundary grant not acknowledged');
        releaseResource.get(id)?.();
        releaseResource.set(id, gate.track(id, { host, generation: grant.generation }, async () => {
          // Capture the concrete instance, never delete a later replacement by
          // deployment name. Withdrawal/expiry also stops compute if the main
          // host reconciliation loop has stalled.
          try { await boundaries.hold(id); }
          finally { await client.remove(instance.instance); }
        }));
        held.delete(id);
      } catch (e) { await fence(id); throw e; }
    },
  };
}
