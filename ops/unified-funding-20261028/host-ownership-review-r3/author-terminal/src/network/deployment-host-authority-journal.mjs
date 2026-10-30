// host-authority permit r1 + completion r2 + ownership r3 (SOURCE ONLY): the DURABLE host-authority section used by the v2 permit gate and
// v2 witness. Storage, single ownership, durable intent, recovery and established coupling live in owned-durable-state.mjs (header there).
//
//   hosts[hostId].floor   { hostGeneration, ownerRevision, digest, context, offline }   identity floor, monotonic on BOTH axes;
//                         offline = null | { hostGeneration, ownerRevision, digest, blockHash, blockNumber } : an AUTHENTICATED Offline
//                         observation = host-wide denial at that host generation; only a strictly newer qualified generation clears it.
//   hosts[hostId].bound   deployment -> { digest, hostGeneration, ownerRevision, kind, at }   explicit handoff, never a genesis default
//
// PRODUCTION entry: openLockedHostAuthorityJournal(file, { ownedJournal, hostId }) - exclusive owner + coupling to the actual owned lifecycle
// journal (its host-authority floor proves establishment). openHostAuthorityJournal() is the CALLER-OWNED primitive (tests, or a caller that
// already holds the lock and the coupling); it is never the proposed composition path.
import fs from 'node:fs';
import { compareHostAuthority, validateHostAuthorityContext, offlineObservationOf } from './deployment-host-authority.mjs';
import { openDurableState, openOwnedLock } from './owned-durable-state.mjs';

const FORMAT = 'enclave-host-authority-permit/v2';
const ID = /^0x[0-9a-f]{64}$/, DEC = /^(0|[1-9][0-9]{0,19})$/;
export const HANDOFF_KINDS = Object.freeze(['fresh-queued-start', 'explicit-adoption']);
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));

function validate(j) {
  if (!exact(j, ['format', 'hosts']) || j.format !== FORMAT || !j.hosts || typeof j.hosts !== 'object' || Array.isArray(j.hosts))
    throw Error('host authority journal malformed');
  for (const [h, e] of Object.entries(j.hosts)) {
    if (!ID.test(h) || !exact(e, ['floor', 'bound']) || !exact(e.floor, ['hostGeneration', 'ownerRevision', 'digest', 'context', 'offline']))
      throw Error('host authority journal host entry malformed');
    const c = validateHostAuthorityContext(e.floor.context);
    if (c.hostId !== h || c.digest !== e.floor.digest || c.hostGeneration !== e.floor.hostGeneration || c.ownerRevision !== e.floor.ownerRevision)
      throw Error('host authority journal floor inconsistent with its context');
    const o = e.floor.offline;
    if (o !== null && (!exact(o, ['hostGeneration', 'ownerRevision', 'digest', 'blockHash', 'blockNumber']) || !DEC.test(o.hostGeneration) ||
        !DEC.test(o.ownerRevision) || !ID.test(o.digest) || !ID.test(o.blockHash) || !(o.blockNumber === null || DEC.test(o.blockNumber)) ||
        BigInt(o.hostGeneration) !== BigInt(e.floor.hostGeneration)))
      throw Error('host authority journal Offline record malformed or not at its floor generation');
    if (!e.bound || typeof e.bound !== 'object' || Array.isArray(e.bound)) throw Error('host authority journal bindings malformed');
    for (const [id, b] of Object.entries(e.bound))
      if (!ID.test(id) || !exact(b, ['digest', 'hostGeneration', 'ownerRevision', 'kind', 'at']) || !ID.test(b.digest) || !DEC.test(b.hostGeneration) ||
          !DEC.test(b.ownerRevision) || !HANDOFF_KINDS.includes(b.kind) || !Number.isSafeInteger(b.at) ||
          BigInt(b.hostGeneration) > BigInt(e.floor.hostGeneration) || BigInt(b.ownerRevision) > BigInt(e.floor.ownerRevision))
        throw Error('host authority journal binding malformed or ahead of its floor');
  }
  return j;
}

/**
 * -> { read, accept, observe, bind, unbind, failed, recover, onRelease, release, released }
 * options: fsImpl (owned temp files only in tests), expectExisting, established (true|false|() => boolean), owner (internal).
 */
export function openHostAuthorityJournal(file, { fsImpl = fs, expectExisting = false, established, owner = null } = {}) {
  const s = openDurableState(file, { format: FORMAT, validate, empty: { format: FORMAT, hosts: {} }, fsImpl, expectExisting, owner,
    established: typeof established === 'function' ? established() === true : established });
  const host = h => { if (!ID.test(h || '')) throw Error('host id must be a lowercase bytes32'); return h; };
  const entry = h => s.state.hosts[host(h)] ?? null;
  const put = (h, value) => { const next = structuredClone(s.state); next.hosts[h] = value; s.store(next); };
  return {
    failed: s.failed, recover: s.recover, onRelease: s.onRelease, release: s.release, released: s.released, fenced: s.fenced, ownerId: s.ownerId,
    hostAuthorityOwned: owner !== null,
    read(h) { const e = entry(h); return e ? structuredClone(e) : null; },
    /** monotonic host-wide identity floor -> 'equal' | 'advance' (rollback / equivocation / recorded Offline throw) */
    accept(h, ctx) {
      validateHostAuthorityContext(ctx);
      if (ctx.hostId !== host(h)) throw Error('host authority binds another host');
      const e = entry(h), how = compareHostAuthority(e?.floor ?? null, ctx);
      if (how === 'equal') return how;
      put(h, { floor: { hostGeneration: ctx.hostGeneration, ownerRevision: ctx.ownerRevision, digest: ctx.digest, context: structuredClone(ctx), offline: null },
        bound: structuredClone(e?.bound ?? {}) });
      return how;
    },
    /** AUTHENTICATED Offline observation for THIS host -> 'recorded' | 'already' | 'stale' | 'ignored' (never a veto, never a restore) */
    observe(h, evidence) {
      const o = offlineObservationOf(evidence);
      if (!o || o.hostId !== host(h)) { entry(h); return 'ignored'; }
      const e = entry(h), f = e?.floor ?? null;
      if (f && BigInt(o.hostGeneration) < BigInt(f.hostGeneration)) return 'stale';
      if (f?.offline && BigInt(f.offline.hostGeneration) >= BigInt(o.hostGeneration)) return 'already';
      const c = evidence.context;
      const floor = !f || BigInt(o.hostGeneration) > BigInt(f.hostGeneration) || BigInt(o.ownerRevision) > BigInt(f.ownerRevision)
        ? { hostGeneration: c.hostGeneration, ownerRevision: c.ownerRevision, digest: c.digest, context: structuredClone(c) }
        : { hostGeneration: f.hostGeneration, ownerRevision: f.ownerRevision, digest: f.digest, context: f.context };
      put(h, { floor: { ...floor, offline: { hostGeneration: o.hostGeneration, ownerRevision: o.ownerRevision, digest: o.digest,
        blockHash: o.blockHash, blockNumber: o.blockNumber } }, bound: structuredClone(e?.bound ?? {}) });
      return 'recorded';
    },
    /** explicit handoff of ONE app context to the exact CURRENT Online floor; never a default, never an older or Offline authority */
    bind(h, id, ctx, { kind, at }) {
      if (!ID.test(id || '') || !HANDOFF_KINDS.includes(kind) || !Number.isSafeInteger(at)) throw Error('explicit handoff kind/time required');
      const e = entry(h);
      if (!e || e.floor.digest !== ctx?.digest || e.floor.offline) throw Error('an app context is handed only to the durable CURRENT Online host authority');
      const b = { digest: ctx.digest, hostGeneration: ctx.hostGeneration, ownerRevision: ctx.ownerRevision, kind, at };
      put(h, { floor: structuredClone(e.floor), bound: { ...structuredClone(e.bound), [id]: b } });
      return structuredClone(b);
    },
    /** ownership r3: withdraw an app context's handoff (an aborted adoption); always more restrictive, never a grant */
    unbind(h, id) {
      const e = entry(h);
      if (!e?.bound?.[id]) return false;
      const bound = structuredClone(e.bound); delete bound[id];
      put(h, { floor: structuredClone(e.floor), bound });
      return true;
    },
  };
}

/**
 * PRODUCTION writer: the exclusive owner of this host's permit authority. -> { journal, release }
 *   ownedJournal + hostId: the actual owned lifecycle journal; its host-authority floor for hostId proves establishment, so a missing
 *   sidecar (with or without its marker) refuses instead of becoming first use; on a fresh host the empty state is established at open.
 */
export async function openLockedHostAuthorityJournal(file, { flockPath = '/usr/bin/flock', timeoutMs = 5000, signal, ownedJournal = null, hostId = null, ...options } = {}) {
  const owner = await openOwnedLock(file, { flockPath, timeoutMs, signal });
  try {
    const established = ownedJournal && hostId ? !!ownedJournal.readHostAuthority(hostId)?.floor : options.established;
    const journal = openHostAuthorityJournal(file, { ...options, established, owner });
    return { journal, release: reason => journal.release(reason) };
  } catch (e) { owner.release(); throw e; }
}
