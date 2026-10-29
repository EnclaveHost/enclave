// host-registry r2 + host-authority completion r2 (SOURCE ONLY): the DURABLE host-incarnation section of the owned lifecycle journal, used
// by the actual dispatch (HOST_INCARNATION_FNS). It REPLACES root r3's 49351d80 sidecar as the active boundary; the four defects root
// demonstrated in host-incarnation-denial-boundary-r1 are fixed here, not beside it:
//  1. an accepted same-generation Offline PERSISTS (floor.context.status + floor.offline) and an older Online view at that generation is
//     refused; only a strictly newer qualified generation restores (no identity increment is needed to record Offline);
//  2. an observed (or established) file that goes missing is UNKNOWN, never an empty first-use journal: `<file>.established` marker,
//     expectExisting, and coupling to the actual owned journal (its host-authority floor exists but this file does not -> unknown);
//  3. malformed nested floor/context/bindings refuse (digest, generation, host, status/offline consistency), re-validated per access;
//  4. any write/fsync/rename/DIRECTORY-fsync failure latches unknown in this process; rereading the renamed bytes never authorizes.
//     recover() requires the intended bytes on disk plus a successful file AND directory fsync before it clears the latch.
// Writer exclusion: openLockedHostIncarnationJournal() holds the existing runtime flock (runtime-lock.mjs) on `<file>.lock`.
// Every pending/mined transition payload lives in the owned journal and is untouched here; reads/reconciliation keep working while
// new serving is refused. Nothing here resets a floor or a binding.
//
//   floor   { generation, digest, context, offline }   offline = null | { generation, at }  (context.status === 'offline' iff offline)
//   genesis digest of the FIRST incarnation this file accepted (provenance only; never an authorization)
//   bound   deployment -> { generation, digest, reason, at, requeue }   requeue: an explicit adoption stopped the old runtime; the app
//           must settle through an authorized queued transition before a fresh start (dispatch completion r2)
import fs from 'node:fs';
import path from 'node:path';
import { hostIncarnationDigest, exactUint64 } from './lifecycle-host-profile.mjs';
import { takeRuntimeLock } from './runtime-lock.mjs';

const FORMAT = 'enclave-host-incarnation/v2';
const ID = /^0x[0-9a-f]{64}$/;
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

/** The section primitive. options: fsImpl (owned temp files in tests), expectExisting, established: hostId => boolean (owned-journal coupling). */
export function hostIncarnationSection(file, { fsImpl = fs, expectExisting = false, established = null } = {}) {
  if (!path.isAbsolute(file)) throw Error('absolute host incarnation journal path required');
  const marker = `${file}.established`;
  let failed = null, state = null, seen = null, intended = null, fresh = false;
  const latch = why => { failed ??= why; throw Error(failed); };
  const statOrNull = p => { try { return fsImpl.statSync(p); } catch { return null; } };
  const sameStat = (a, b) => a && b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
  try {
    const hasFile = fsImpl.existsSync(file), hasMarker = fsImpl.existsSync(marker);
    if (hasFile && !hasMarker) throw Error('host incarnation journal without its established marker');
    if (!hasFile && (hasMarker || expectExisting)) throw Error('previously established host incarnation journal is missing');
    if (hasFile) { state = validate(JSON.parse(fsImpl.readFileSync(file, 'utf8'))); seen = fsImpl.statSync(file); }
    else { state = { format: FORMAT, hosts: {} }; fresh = true; }
  } catch (e) { failed = `host incarnation journal unknown: ${e.message}`; state = null; }
  const check = h => {
    if (failed) throw Error(failed);
    if (seen && !sameStat(statOrNull(file), seen)) latch('host incarnation journal lost or changed underneath this process');
    if (seen && !statOrNull(marker)) latch('host incarnation journal established marker lost');
    if (h !== undefined && !ID.test(h || '')) throw Error('host id must be a lowercase bytes32');
    if (h !== undefined && fresh && !state.hosts[h] && typeof established === 'function' && established(h) === true)
      latch('owned journal holds an established host authority for this host but its host incarnation journal is missing');
  };
  function store(next) {
    validate(next);
    const dir = path.dirname(file), tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`), bytes = JSON.stringify(next);
    intended = bytes;
    try {
      if (!fsImpl.existsSync(marker)) {
        const m = fsImpl.openSync(marker, 'wx', 0o600); try { fsImpl.fsyncSync(m); } finally { fsImpl.closeSync(m); }
        const dm = fsImpl.openSync(dir, 'r'); try { fsImpl.fsyncSync(dm); } finally { fsImpl.closeSync(dm); }
      }
      const fd = fsImpl.openSync(tmp, 'wx', 0o600);
      try { fsImpl.writeFileSync(fd, bytes); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
      fsImpl.renameSync(tmp, file);
      const d = fsImpl.openSync(dir, 'r'); try { fsImpl.fsyncSync(d); } finally { fsImpl.closeSync(d); }
      seen = fsImpl.statSync(file);
    } catch (e) {
      try { fsImpl.unlinkSync(tmp); } catch {}
      latch(`host incarnation journal persistence uncertain: ${e.message}`);
    }
    state = next; fresh = false;
  }
  return {
    failed: () => failed,
    recover() {
      if (!failed) return true;
      if (intended === null) throw Error('nothing was being persisted: reopen in a fresh process and re-validate');
      if (fsImpl.readFileSync(file, 'utf8') !== intended) throw Error('on-disk host incarnation journal is not the intended state: no recovery');
      const fd = fsImpl.openSync(file, 'r'); try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
      const d = fsImpl.openSync(path.dirname(file), 'r'); try { fsImpl.fsyncSync(d); } finally { fsImpl.closeSync(d); }
      if (!fsImpl.existsSync(marker)) throw Error('established marker is not durable: no recovery');
      state = validate(JSON.parse(intended)); seen = fsImpl.statSync(file); failed = null; fresh = false;
      return true;
    },
    readHostIncarnation(h) { check(h); const e = state.hosts[h]; return e ? structuredClone(e) : null; },
    acceptHostIncarnation(h, x) {
      check(h); checkContext(h, x, 'acceptHostIncarnation');
      const e = state.hosts[h], f = e?.floor;
      let floor;
      if (f) {
        const g = BigInt(x.generation), fg = BigInt(f.generation);
        if (g < fg) throw Error(`host incarnation rollback (generation ${x.generation} below accepted ${f.generation})`);
        if (g === fg && x.digest !== f.digest) throw Error(`host incarnation equivocation at generation ${x.generation}`);
        if (g === fg) {
          if (f.offline && x.status === 'online') throw Error(`canonical host recorded Offline at generation ${f.generation}: an Online view at that generation is stale; only a newer qualified generation restores`);
          if (f.offline || x.status === 'online') return structuredClone(f);   // unchanged
          floor = { generation: f.generation, digest: f.digest, context: structuredClone(x), offline: { generation: f.generation, at: Date.now() } };
        }
      }
      floor ??= { generation: x.generation, digest: x.digest, context: structuredClone(x),
        offline: x.status === 'offline' ? { generation: x.generation, at: Date.now() } : null };
      const next = structuredClone(state);
      next.hosts[h] = { floor, genesis: e?.genesis ?? x.digest, bound: structuredClone(e?.bound ?? {}) };
      store(next);
      return structuredClone(floor);
    },
    bindHostIncarnation(h, id, { generation, digest, reason, at, requeue = false }) {
      check(h);
      if (!ID.test(id || '')) throw Error('deployment id must be a lowercase bytes32');
      const e = state.hosts[h];
      if (!e?.floor || e.floor.digest !== digest || e.floor.generation !== generation || e.floor.offline)
        throw Error('an app context binds only the durable current Online host incarnation');
      if (typeof reason !== 'string' || !reason || !Number.isSafeInteger(at) || typeof requeue !== 'boolean') throw Error('binding reason/time/requeue required');
      const next = structuredClone(state);
      next.hosts[h].bound[id] = { generation, digest, reason: reason.slice(0, 200), at, requeue };
      store(next);
      return structuredClone(next.hosts[h].bound[id]);
    },
  };
}

/**
 * The owned lifecycle journal + this section as ONE plain journal object (every original method forwarded with its own `this`).
 * Coupling: the first readHostAuthority(hostId) through this object (dispatch attach does it before any decision) records whether the
 * owned journal already holds an established host-authority floor; if it does while this section's file is missing, every host
 * incarnation access for that host is unknown (never first use).
 */
export function withHostIncarnationJournal(journal, file, options = {}) {
  const out = {}, owned = new Map();
  const section = hostIncarnationSection(file, { ...options, established: h => owned.get(h) === true });
  for (let o = journal; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
    for (const k of Object.getOwnPropertyNames(o)) if (k !== 'constructor' && !(k in out) && typeof journal[k] === 'function') out[k] = (...a) => journal[k](...a);
  if (typeof journal.readHostAuthority === 'function')
    out.readHostAuthority = h => { const r = journal.readHostAuthority(h); if (!owned.has(h)) owned.set(h, !!r?.floor); return r; };
  for (const k of ['readHostIncarnation', 'acceptHostIncarnation', 'bindHostIncarnation', 'recover', 'failed']) {
    if (k in out) throw Error(`journal already defines ${k}`);
    out[k === 'recover' ? 'recoverHostIncarnation' : k === 'failed' ? 'hostIncarnationFailed' : k] = section[k];
  }
  return Object.freeze(out);
}

/** Production writer: holds the existing runtime flock on `<file>.lock` for this writer's lifetime. -> { journal, release } */
export async function openLockedHostIncarnationJournal(journal, file, { flockPath = '/usr/bin/flock', timeoutMs = 5000, signal, ...options } = {}) {
  const release = await takeRuntimeLock(`${file}.lock`, { flockPath, timeoutMs, signal });
  try { return { journal: withHostIncarnationJournal(journal, file, options), release }; }
  catch (e) { release(); throw e; }
}
