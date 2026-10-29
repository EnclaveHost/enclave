// Witness signing boundary. The service owns its journal for its entire life.
// Authority and health readers are trusted local verification adapters; requests
// cannot supply snapshots, arbitrary typed data, or a precomputed digest to sign.
import { getAddress, recoverTypedDataAddress, hashTypedData } from 'viem';
import { validateServingPermitContext, signServingPermit, servingAssignmentBinding, resolveServingContext } from './deployment-serving-permit.mjs';
import { verifyGenerationChain, prepareGenerationProposal } from './deployment-generation-certificate.mjs';
import { transitionTypedData } from './deployment-transition-intent.mjs';
import { canRestoreLifecycleDenial, lifecycleHostAdmitted } from './deployment-authority-window.mjs';
// host-authority permit r1: a v2 witness derives the host authority from its OWN authenticated reader and durable floor
import { isHostAuthorityPermit, validateHostAuthorityContext } from './deployment-host-authority.mjs';

export class DeploymentLifecycleWitness {
  constructor({ pins, account, journal, authority, health, now = Date.now, requestTimeoutMs = 10000, hostAuthorityJournal = null }) {
    if (typeof account?.signTypedData !== 'function' || typeof authority?.read !== 'function' || typeof health?.verify !== 'function')
      throw Error('witness needs a signer and local authority/readiness verifiers');
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 10000) throw Error('invalid witness deadline');
    Object.assign(this, { pins, account, journal, authority, health, now, requestTimeoutMs, hostAuthorityJournal });
    if (isHostAuthorityPermit(pins) && typeof hostAuthorityJournal?.accept !== 'function') throw Error('v2 witness requires its durable host authority journal');   // host-authority permit r1
    this.busy = new Set(); this.closed = false;
  }
  permit(record, operatorSignature) { return this.#bounded(signal => this.#permit(record, operatorSignature, signal)); }
  async #bounded(run) {
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => { timer = setTimeout(() => {
      const error = Error('witness verification deadline'); controller.abort(error); reject(error);
    }, this.requestTimeoutMs); });
    const work = run(controller.signal);
    try { return await Promise.race([work, expired]); }
    finally { clearTimeout(timer); work.catch(() => {}); }
  }
  async #permit(record, operatorSignature, signal) {
    if (this.closed) throw Error('witness closed');
    const id = record?.deployment;
    if (this.busy.has(id) || this.busy.size >= 256) throw Error('witness deployment busy');
    this.busy.add(id);
    try {
      const row = this.journal.read(id);
      const context = await resolveServingContext({ ...await this.authority.read(id, record.host, { signal }), pins: this.pins,
        nowSec: Math.floor(this.now() / 1000), denyFloor: row.denial });
      const floor = row.digest ? { generation: row.generation, sequence: row.sequence, digest: row.digest } : null;
      const V2 = isHostAuthorityPermit(this.pins), haFloor = V2 ? { hostAuthorityFloor: this.hostAuthorityJournal.read(record.host)?.floor ?? null } : {};   // host-authority permit r1
      const checked = validateServingPermitContext(record, { ...context, pins: this.pins,
        floor, nowSec: Math.floor(this.now() / 1000), ...haFloor });
      if (!checked.allowed.has(getAddress(this.account.address).toLowerCase())) throw Error('signer is not a configured witness');
      const operator = await recoverTypedDataAddress({ ...checked.data, signature: operatorSignature });
      if (getAddress(context.assignment.operator) !== operator) throw Error('permit request is not signed by the assigned operator');
      const health = await this.health.verify(id, record.host, record.generation, { signal });
      const nowSec = Math.floor(this.now() / 1000);
      if (health?.verified !== true || health.deployment !== id || health.host !== record.host ||
          health.generation !== record.generation || health.ready !== true ||
          !Number.isSafeInteger(health.validUntil) || health.validUntil <= nowSec || health.validUntil < checked.serveUntil)
        throw Error('no authenticated readiness covering this permit');
      // Validation can take time; never sign after its authority or health aged
      // out. Revalidate the same evidence, never relabel it with the current time.
      if (V2) await this.#sameHostAuthority(id, record, signal);   // host-authority permit r1: readiness work took time
      validateServingPermitContext(record, { ...context, pins: this.pins, floor, nowSec, ...haFloor });
      signal.throwIfAborted();
      if (this.closed) throw Error('witness closed');
      if (V2) this.hostAuthorityJournal.accept(record.host, validateHostAuthorityContext(record.hostAuthority));   // host-authority permit r1: durable BEFORE signing
      if (context.restoredAt !== undefined && context.restoredAt !== null) this.journal.restoreDenial(id, context.restoredAt);
      this.journal.observeAssignment(id, record.generation, record.policyRevision,
        servingAssignmentBinding(this.pins, context.assignment, context.policy));
      this.journal.permit(id, { generation: record.generation, revision: record.policyRevision,
        sequence: record.sequence, digest: checked.digest });
      const signature = await signServingPermit(this.account, this.pins, record);
      signal.throwIfAborted();
      if (this.closed || this.journal.read(id).fenced) throw Error('witness fenced during signing');
      if (V2) await this.#sameHostAuthority(id, record, signal);   // host-authority permit r1: an obsolete signature is never released
      return { witness: this.account.address, signature };
    } catch (e) {
      if (e.code === 'LIFECYCLE_DENIED' && e.denial && !signal.aborted) this.journal.deny(id, e.denial);
      throw e;
    } finally { this.busy.delete(id); }
  }
  fence(id, generation) {
    // Must precede any vote to retire this generation. A signing operation
    // already in flight checks the fence again before returning its signature.
    this.journal.fence(id, generation);
  }
  generation(request) { return this.#bounded(signal => this.#generation(request, signal)); }
  async #generation({ record, predecessors, intent, actorSignature = null }, signal) {
    if (this.closed) throw Error('witness closed');
    if (typeof this.authority.readGeneration !== 'function') throw Error('generation authority adapter required');
    const id = record?.deployment;
    if (this.busy.has(id) || this.busy.size >= 256) throw Error('witness deployment busy');
    this.busy.add(id);
    try {
      const source = await this.authority.readGeneration(id, record.host, { signal });
      const localDenial = this.journal.read(id).denial;
      const denial = localDenial || source.denyFloor;
      const nowSec = Math.floor(this.now() / 1000);
      if (denial && !canRestoreLifecycleDenial(denial, source.anchor, nowSec)) throw Error('authenticated restoration required');
      const context = { ...source, pins: this.pins, nowSec, denyFloor: null };
      const parent = (await verifyGenerationChain(predecessors, context)).assignment;
      const checked = await prepareGenerationProposal(record, predecessors, context);
      if (!source.policy.witnesses.some(a => getAddress(a) === getAddress(this.account.address))) throw Error('not a configured generation witness');
      const typedIntent = transitionTypedData(this.pins, intent);
      if (hashTypedData(typedIntent) !== record.transitionIntent || intent.id !== id || intent.generation !== parent.generation ||
          intent.revision !== source.policy.revision || intent.target !== record.action || intent.host !== record.host || intent.healthySince !== 0 ||
          intent.deadline < context.nowSec || intent.deadline > context.nowSec + 120 || BigInt(intent.maxChargeWei) > BigInt(source.policy.maxTransitionWei))
        throw Error('certificate does not bind the exact payable transition');
      let actor = null;
      if (actorSignature) actor = getAddress(await recoverTypedDataAddress({ ...typedIntent, signature: actorSignature }));
      const owner = getAddress(source.anchor.ownerAuthority);
      if (record.action === 2) {
        if (!lifecycleHostAdmitted(source.anchor, record.host)) throw Error('candidate host is not admitted');
        const candidate = source.candidate;
        if (candidate?.proofVerified !== true || candidate.blockHash !== source.anchor.hash || candidate.host !== record.host ||
            candidate.eligible !== true || getAddress(candidate.operator) !== getAddress(record.operator) || actor !== getAddress(record.operator))
          throw Error('candidate lacks anchored eligibility or operator authorization');
        const health = await this.health.verify(id, record.host, record.generation, { signal });
        if (!this.#health(health, id, record.host, record.generation, context.nowSec) || health.ready !== true)
          throw Error('replacement readiness is not authenticated');
      } else if (actor !== owner && !(parent.state === 'running' && actor === getAddress(parent.operator))) {
        if (parent.state === 'running') {
          const health = await this.health.verify(id, parent.host, parent.generation, { signal });
          const expired = health?.livenessExpired === true && Number.isSafeInteger(health.lastHeartbeatUntil) && health.lastHeartbeatUntil <= context.nowSec;
          if (!this.#health(health, id, parent.host, parent.generation, context.nowSec) || (health.ended !== true && !expired) || !health.instance)
            throw Error('no authenticated failure or owner/operator authorization');
        } else if (record.action !== 3 || parent.remainingWei > BigInt(source.policy.stopReserveWei) + BigInt(intent.maxChargeWei))
          throw Error('owner authorization required for idle deployment');
      }
      // Recheck age after all asynchronous verification, then durably fence and
      // bind the unique successor before either signature can leave the process.
      await prepareGenerationProposal(record, predecessors, { ...context, nowSec: Math.floor(this.now() / 1000) });
      signal.throwIfAborted();
      if (this.closed) throw Error('witness closed');
      if (localDenial) this.journal.restoreDenial(id, source.anchor.number);
      this.journal.observeAssignment(id, parent.generation, source.policy.revision,
        servingAssignmentBinding(this.pins, { ...parent, policyRevision: source.policy.revision }, source.policy));
      const digest = hashTypedData(checked.typedData);
      this.journal.voteSuccessor(id, { generation: record.generation, previous: record.previous, digest,
        payload: JSON.stringify({ record, intent }, (_k, value) => typeof value === 'bigint' ? value.toString() : value) });
      const signature = await this.account.signTypedData(checked.typedData);
      signal.throwIfAborted();
      const transitionSignature = await this.account.signTypedData(typedIntent);
      signal.throwIfAborted();
      if (this.closed) throw Error('witness closed');
      return { witness: this.account.address, signature, transitionSignature };
    } catch (e) {
      if (e.code === 'LIFECYCLE_DENIED' && e.denial && !signal.aborted) this.journal.deny(id, e.denial);
      throw e;
    } finally { this.busy.delete(id); }
  }
  #health(h, id, host, generation, nowSec) {
    return h?.verified === true && h.deployment === id && h.host === host && h.generation === generation &&
      Number.isSafeInteger(h.validUntil) && h.validUntil > nowSec;
  }
  // host-authority permit r1: the CURRENT host authority from this witness's own authenticated reader must still be exactly the signed one
  async #sameHostAuthority(id, record, signal) {
    const now = await this.authority.read(id, record.host, { signal });
    signal.throwIfAborted();
    const e = now?.hostAuthority;
    if (!e || e.proofVerified !== true || e.status !== 'online' || validateHostAuthorityContext(e.context).digest !== record.hostAuthority.digest)
      throw Error('canonical host authority changed or unknown during witness verification/signing: no signature released');
  }
  close() { this.closed = true; }
}
