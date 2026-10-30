// host-registry r2 + host-authority completion r2 + ownership r3 + async r4 (SOURCE ONLY): the DURABLE host-incarnation section of the owned
// lifecycle journal, used by the actual dispatch (HOST_INCARNATION_FNS). Storage, single ownership (release/lock loss -> every retained
// method refuses, asynchronous withdrawal settles before the flock is released), retained intent/acknowledgement across process
// replacement, verified recovery with history, and established coupling live in owned-durable-state.mjs. Semantics kept from completion r2:
//  1. an accepted same-generation Offline PERSISTS (floor.context.status + floor.offline); an older Online view at that generation is refused;
//     only a strictly newer qualified generation restores;
//  2. an observed/established file that goes missing is UNKNOWN, never an empty first-use journal;
//  3. malformed nested floor/context/bindings refuse (digest, generation, host, status/offline consistency);
//  4. any write/fsync/rename/DIRECTORY-fsync failure (including the final acknowledgement) latches unknown, also across a NEW process.
// Every pending/mined transition payload lives in the owned lifecycle journal and is untouched here.
// r4 OWNER EPOCH on the PRODUCTION wrapper: every FORWARDED owned-lifecycle-journal method is guarded by this owner's liveness, so after
// release or lock loss the dispatch can no longer prepare/submit/start through the retained reference. Explicitly scoped safe
// reconciliation stays available after authority loss: reads, mined-outcome settlement/archival, runtime retirement (authenticated Stop)
// and restrictive fence/deny. Pending records are never erased by this module (settleTransition is NOT in the safe set).
//
// PRODUCTION entry: openLockedHostIncarnationJournal(ownedJournal, file, { hostId }). hostIncarnationSection()/withHostIncarnationJournal()
// are the CALLER-OWNED primitives (tests, or a caller that already holds the lock).
//
//   floor   { generation, digest, context, offline }   offline = null | { generation, at }  (context.status === 'offline' iff offline)
//   genesis digest of the FIRST incarnation this file accepted (provenance only; never an authorization)
//   bound   deployment -> { generation, digest, reason, at, requeue }
import fs from 'node:fs';
import { hostIncarnationDigest, exactUint64 } from './lifecycle-host-profile.mjs';
import { openDurableState, openOwnedLock } from './owned-durable-state.mjs';

const FORMAT = 'enclave-host-incarnation/v2';
const ID = /^0x[0-9a-f]{64}$/;
export const SAFE_AFTER_AUTHORITY_LOSS = Object.freeze(['read', 'readHostAuthority', 'decision', 'settleMined', 'archiveMined', 'retireRuntime', 'fence', 'deny']);
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));

function checkContext(h, x, what) {
  if (!x || typeof x !== 'object' || x.hostId !== h || x.digest !== hostIncarnationDigest(x) || exactUint64(x.generation, 'host generation') !== x.generation ||
      !['online', 'offline'].includes(x.status)) throw Error(`${what}: host incarnation malformed or digest mismatch`);
  return x;
}
function validate(j) {
  if (!exact(j, ['format', 'hosts']) || j.format !== FORMAT || !j.hosts || typeof j.hosts !== 'object' || Array.isArray(j.hosts))
    throw Error('host incarnation journal malformed');
  for (const [h, e] of Object.entries(j.hosts)) {
    if (!ID.test(h) || !exact(e, ['floor', 'genesis', 'bound']) || !exact(e.floor, ['generation', 'digest', 'context', 'offline']) || !ID.test(e.genesis))
      throw Error('host incarnation journal host entry malformed');
    const c = checkContext(h, e.floor.context, 'accepted floor');
    if (c.digest !== e.floor.digest || c.generation !== e.floor.generation) throw Error('accepted floor does not match its nested context');
    const o = e.floor.offline;
    if ((o === null) !== (c.status === 'online') || (o !== null && (!exact(o, ['generation', 'at']) || o.generation !== e.floor.generation || !Number.isSafeInteger(o.at))))
      throw Error('accepted floor Offline record inconsistent with its context status');
    if (!e.bound || typeof e.bound !== 'object' || Array.isArray(e.bound)) throw Error('host incarnation bindings malformed');
    for (const [id, b] of Object.entries(e.bound))
      if (!ID.test(id) || !exact(b, ['generation', 'digest', 'reason', 'at', 'requeue']) || !ID.test(b.digest) || exactUint64(b.generation, 'binding generation') !== b.generation ||
          BigInt(b.generation) > BigInt(e.floor.generation) || typeof b.reason !== 'string' || !b.reason || b.reason.length > 200 ||
          !Number.isSafeInteger(b.at) || typeof b.requeue !== 'boolean') throw Error('host incarnation binding malformed or ahead of its floor');
  }
  return j;
}

/**
 * The section. options: fsImpl, expectExisting, established (true|false: open-time coupling to the owned lifecycle journal),
 * establishedFor (hostId => boolean: lazy coupling for the caller-owned wrapper), owner (internal, from openOwnedLock), withdrawDeadlineMs.
 */
export function hostIncarnationSection(file, { fsImpl = fs, expectExisting = false, established, establishedFor = null, owner = null, withdrawDeadlineMs = null } = {}) {
  const freshAtOpen = !fsImpl.existsSync(file);
  const s = openDurableState(file, { format: FORMAT, validate, empty: { format: FORMAT, hosts: {} }, fsImpl, expectExisting, established, owner, withdrawDeadlineMs });
  let coupled = null;
  const st = h => {
    const state = s.state;                                   // owner/latch/loss checks first
    if (h !== undefined && !ID.test(h || '')) throw Error('host id must be a lowercase bytes32');
    if (coupled) throw Error(coupled);
    if (h !== undefined && freshAtOpen && !state.hosts[h] && typeof establishedFor === 'function' && establishedFor(h) === true) {
      coupled = 'owned journal holds an established host authority for this host but its host incarnation journal is missing';
      throw Error(coupled);
    }
    return state;
  };
  const put = (h, value) => { const next = structuredClone(s.state); next.hosts[h] = value; s.store(next); };
  return {
    failed: () => coupled ?? s.failed(), recover: s.recover, onRelease: s.onRelease, release: s.release, released: s.released, fenced: s.fenced,
    ownerId: s.ownerId, assertLive: s.assertLive,
    readHostIncarnation(h) { const e = st(h).hosts[h]; return e ? structuredClone(e) : null; },
    acceptHostIncarnation(h, x) {
      const e = st(h).hosts[h]; checkContext(h, x, 'acceptHostIncarnation');
      const f = e?.floor;
      let floor;
      if (f) {
        const g = BigInt(x.generation), fg = BigInt(f.generation);
        if (g < fg) throw Error(`host incarnation rollback (generation ${x.generation} below accepted ${f.generation})`);
        if (g === fg && x.digest !== f.digest) throw Error(`host incarnation equivocation at generation ${x.generation}`);
        if (g === fg) {
          if (f.offline && x.status === 'online') throw Error(`canonical host recorded Offline at generation ${f.generation}: an Online view at that generation is stale; only a newer qualified generation restores`);
          if (f.offline || x.status === 'online') return structuredClone(f);
          floor = { generation: f.generation, digest: f.digest, context: structuredClone(x), offline: { generation: f.generation, at: Date.now() } };
        }
      }
      floor ??= { generation: x.generation, digest: x.digest, context: structuredClone(x),
        offline: x.status === 'offline' ? { generation: x.generation, at: Date.now() } : null };
      put(h, { floor, genesis: e?.genesis ?? x.digest, bound: structuredClone(e?.bound ?? {}) });
      return structuredClone(floor);
    },
    bindHostIncarnation(h, id, { generation, digest, reason, at, requeue = false }) {
      const e = st(h).hosts[h];
      if (!ID.test(id || '')) throw Error('deployment id must be a lowercase bytes32');
      if (!e?.floor || e.floor.digest !== digest || e.floor.generation !== generation || e.floor.offline)
        throw Error('an app context binds only the durable current Online host incarnation');
      if (typeof reason !== 'string' || !reason || !Number.isSafeInteger(at) || typeof requeue !== 'boolean') throw Error('binding reason/time/requeue required');
      const b = { generation, digest, reason: reason.slice(0, 200), at, requeue };
      put(h, { floor: structuredClone(e.floor), genesis: e.genesis, bound: { ...structuredClone(e.bound), [id]: b } });
      return structuredClone(b);
    },
  };
}

/** guarded = true only for the PRODUCTION (locked) wrapper: forwarded methods outside SAFE_AFTER_AUTHORITY_LOSS require a live owner */
function wrap(journal, section, owned, guarded = false) {
  const out = {};
  for (let o = journal; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
    for (const k of Object.getOwnPropertyNames(o)) if (k !== 'constructor' && !(k in out) && typeof journal[k] === 'function')
      out[k] = guarded && !SAFE_AFTER_AUTHORITY_LOSS.includes(k) ? (...a) => { section.assertLive(); return journal[k](...a); } : (...a) => journal[k](...a);
  if (owned && typeof journal.readHostAuthority === 'function')
    out.readHostAuthority = h => { const r = journal.readHostAuthority(h); if (!owned.has(h)) owned.set(h, !!r?.floor); return r; };
  for (const k of ['readHostIncarnation', 'acceptHostIncarnation', 'bindHostIncarnation']) { if (k in out) throw Error(`journal already defines ${k}`); out[k] = section[k]; }
  Object.assign(out, { recoverHostIncarnation: section.recover, hostIncarnationFailed: section.failed, onHostIncarnationRelease: section.onRelease,
    releaseHostIncarnation: section.release, hostIncarnationReleased: section.released, hostIncarnationOwned: section.ownerId() !== null,
    assertHostIncarnationLive: section.assertLive });
  return Object.freeze(out);
}

/** CALLER-OWNED: the owned lifecycle journal + this section as ONE journal object; lazy coupling via the attach-time readHostAuthority. */
export function withHostIncarnationJournal(journal, file, options = {}) {
  const owned = new Map();
  return wrap(journal, hostIncarnationSection(file, { ...options, establishedFor: h => owned.get(h) === true }), owned);
}

/**
 * PRODUCTION writer: the exclusive owner of this host's incarnation authority. -> { journal, release(reason) -> completion promise }
 *   hostId: the actual owned lifecycle journal's host-authority floor for hostId (read NOW, before any decision) proves establishment, so a
 *   missing sidecar refuses; on a fresh host the empty state is established at open, before any handoff could repopulate it.
 */
export async function openLockedHostIncarnationJournal(journal, file, { flockPath = '/usr/bin/flock', timeoutMs = 5000, signal, hostId = null, ...options } = {}) {
  const owner = await openOwnedLock(file, { flockPath, timeoutMs, signal });
  try {
    const established = hostId ? !!journal.readHostAuthority?.(hostId)?.floor : options.established;
    const owned = hostId ? null : new Map();
    const section = hostIncarnationSection(file, { ...options, established, owner, ...(owned ? { establishedFor: h => owned.get(h) === true } : {}) });
    const j = wrap(journal, section, owned, true);
    return { journal: j, release: reason => section.release(reason) };
  } catch (e) { owner.release(); throw e; }
}
