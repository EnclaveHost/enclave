// host-authority permit r1 + completion r2 (SOURCE ONLY): the DURABLE host-authority section used by the v2 permit gate and v2 witness.
// A separate owned file beside the protocol journal (the pinned deployment-lifecycle-journal.mjs and root's generated owned journal are
// NOT edited). Every accepted change is durable (temp write, fsync, rename, directory fsync) BEFORE the method returns.
//
// Fail-closed rules:
//  - malformed nested host/floor/offline/bound state refuses (never repaired, never reset); the file is re-validated on every access;
//  - ESTABLISHED state: the first durable write also creates `<file>.established` (fsynced). Marker without file, file without marker,
//    expectExisting without file, or an owner-supplied `established()` coupling (e.g. the owned protocol journal already holds permit
//    floors) with no file all refuse as unknown: a lost established file is never "first use";
//  - a file that disappears or changes underneath this process refuses (only this process writes it);
//  - ANY write/fsync/rename/directory-fsync failure LATCHES unknown in this process. Rereading the same bytes never converts it into an
//    authorization. recover() is the only explicit in-process recovery: it requires the on-disk bytes to equal the last intended state
//    and a successful fsync of the file AND its directory (proof the evidence is durable) before clearing the latch;
//  - writer exclusion: production opens through openLockedHostAuthorityJournal(), which holds the existing runtime flock
//    (network/runtime-lock.mjs takeRuntimeLock) on `<file>.lock` for the writer's lifetime. The bare openHostAuthorityJournal() is the
//    in-process primitive (tests, or a caller that already holds that lock).
//
//   hosts[hostId].floor   { hostGeneration, ownerRevision, digest, context, offline }   identity floor, monotonic on BOTH axes;
//                         offline = null | { hostGeneration, ownerRevision, digest, blockHash, blockNumber } : an AUTHENTICATED Offline
//                         observation. It is a host-wide denial at that host generation (no identity increment is needed to record it);
//                         only a strictly newer qualified host generation clears it.
//   hosts[hostId].bound   deployment -> { digest, hostGeneration, ownerRevision, kind, at }   explicit handoff, never a genesis default
import fs from 'node:fs';
import path from 'node:path';
import { compareHostAuthority, validateHostAuthorityContext, offlineObservationOf } from './deployment-host-authority.mjs';
import { takeRuntimeLock } from './runtime-lock.mjs';

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
 * -> { read(hostId), accept(hostId, ctx), observe(hostId, evidence), bind(hostId, id, ctx, {kind, at}), failed(), recover() }
 * options: fsImpl (owned temp files only in tests), expectExisting, established: () => boolean (owner-journal coupling).
 */
export function openHostAuthorityJournal(file, { fsImpl = fs, expectExisting = false, established = null } = {}) {
  if (!path.isAbsolute(file)) throw Error('absolute host authority journal path required');
  const marker = `${file}.established`;
  let failed = null, state = null, seen = null, intended = null;
  const latch = why => { failed ??= why; throw Error(failed); };
  const sameStat = (a, b) => a && b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
  const statOrNull = p => { try { return fsImpl.statSync(p); } catch { return null; } };
  const check = () => {
    if (failed) throw Error(failed);
    if (seen && !sameStat(statOrNull(file), seen)) latch('host authority journal lost or changed underneath this process');
    if (seen && !statOrNull(marker)) latch('host authority journal established marker lost');
  };
  try {
    const hasFile = fsImpl.existsSync(file), hasMarker = fsImpl.existsSync(marker);
    if (hasFile && !hasMarker) throw Error('host authority journal without its established marker');
    if (!hasFile && (hasMarker || expectExisting)) throw Error('previously established host authority journal is missing');
    if (!hasFile && typeof established === 'function' && established() === true) throw Error('owned journal is established but its host authority journal is missing');
    if (hasFile) { state = validate(JSON.parse(fsImpl.readFileSync(file, 'utf8'))); seen = fsImpl.statSync(file); }
    else state = { format: FORMAT, hosts: {} };
  } catch (e) { failed = `host authority journal unknown: ${e.message}`; state = null; }
  function durableMarker(dir) {
    if (fsImpl.existsSync(marker)) return;
    const m = fsImpl.openSync(marker, 'wx', 0o600); try { fsImpl.fsyncSync(m); } finally { fsImpl.closeSync(m); }
    const d = fsImpl.openSync(dir, 'r'); try { fsImpl.fsyncSync(d); } finally { fsImpl.closeSync(d); }
  }
  function store(next) {
    validate(next);
    const dir = path.dirname(file), tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`), bytes = JSON.stringify(next);
    intended = bytes;
    try {
      durableMarker(dir);
      const fd = fsImpl.openSync(tmp, 'wx', 0o600);
      try { fsImpl.writeFileSync(fd, bytes); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
      fsImpl.renameSync(tmp, file);
      const d = fsImpl.openSync(dir, 'r'); try { fsImpl.fsyncSync(d); } finally { fsImpl.closeSync(d); }
      seen = fsImpl.statSync(file);
    } catch (e) {
      try { fsImpl.unlinkSync(tmp); } catch {}   // never leaves a temp file that blocks a later recovery; the latch still holds
      latch(`host authority journal persistence uncertain: ${e.message}`);
    }
    state = next;
  }
  const host = h => { if (!ID.test(h || '')) throw Error('host id must be a lowercase bytes32'); return h; };
  const entry = h => state.hosts[host(h)] ?? null;
  return {
    failed: () => failed,
    /** Explicit in-process recovery: only when the intended bytes are on disk and the file AND directory fsync now succeed. */
    recover() {
      if (!failed) return true;
      if (intended === null) throw Error('nothing was being persisted: reopen in a fresh process and re-validate');
      const bytes = fsImpl.readFileSync(file, 'utf8');
      if (bytes !== intended) throw Error('on-disk host authority journal is not the intended state: no recovery');
      const fd = fsImpl.openSync(file, 'r'); try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
      const d = fsImpl.openSync(path.dirname(file), 'r'); try { fsImpl.fsyncSync(d); } finally { fsImpl.closeSync(d); }
      if (!fsImpl.existsSync(marker)) throw Error('established marker is not durable: no recovery');
      state = validate(JSON.parse(bytes)); seen = fsImpl.statSync(file); failed = null;
      return true;
    },
    read(h) { check(); const e = entry(h); return e ? structuredClone(e) : null; },
    /** monotonic host-wide identity floor -> 'equal' | 'advance' (rollback / equivocation / recorded Offline throw) */
    accept(h, ctx) {
      check(); validateHostAuthorityContext(ctx);
      if (ctx.hostId !== host(h)) throw Error('host authority binds another host');
      const e = entry(h), how = compareHostAuthority(e?.floor ?? null, ctx);
      if (how === 'equal') return how;
      const next = structuredClone(state);
      next.hosts[h] = { floor: { hostGeneration: ctx.hostGeneration, ownerRevision: ctx.ownerRevision, digest: ctx.digest, context: structuredClone(ctx), offline: null },
        bound: structuredClone(e?.bound ?? {}) };   // existing bindings are kept (they refer to an OLDER authority and stop matching)
      store(next);
      return how;
    },
    /**
     * An AUTHENTICATED Offline observation (proof-qualified evidence for THIS host) -> durable host-wide denial at its generation.
     * -> 'recorded' | 'already' | 'stale' | 'ignored'. Unqualified/Online evidence is 'ignored' (never a veto, never a restore).
     */
    observe(h, evidence) {
      check();
      const o = offlineObservationOf(evidence);
      if (!o || o.hostId !== host(h)) return 'ignored';
      const e = entry(h), f = e?.floor ?? null;
      if (f && BigInt(o.hostGeneration) < BigInt(f.hostGeneration)) return 'stale';           // an older generation was already superseded
      if (f?.offline && BigInt(f.offline.hostGeneration) >= BigInt(o.hostGeneration)) return 'already';
      const next = structuredClone(state), c = evidence.context;
      const floor = !f || BigInt(o.hostGeneration) > BigInt(f.hostGeneration) || (BigInt(o.ownerRevision) > BigInt(f.ownerRevision))
        ? { hostGeneration: c.hostGeneration, ownerRevision: c.ownerRevision, digest: c.digest, context: structuredClone(c) }
        : { hostGeneration: f.hostGeneration, ownerRevision: f.ownerRevision, digest: f.digest, context: f.context };
      next.hosts[h] = { floor: { ...floor, offline: { hostGeneration: o.hostGeneration, ownerRevision: o.ownerRevision, digest: o.digest,
        blockHash: o.blockHash, blockNumber: o.blockNumber } }, bound: structuredClone(e?.bound ?? {}) };
      store(next);
      return 'recorded';
    },
    /** explicit handoff of ONE app context to the exact CURRENT Online floor; never a default, never an older or Offline authority */
    bind(h, id, ctx, { kind, at }) {
      check();
      if (!ID.test(id || '') || !HANDOFF_KINDS.includes(kind) || !Number.isSafeInteger(at)) throw Error('explicit handoff kind/time required');
      const e = entry(h);
      if (!e || e.floor.digest !== ctx?.digest || e.floor.offline) throw Error('an app context is handed only to the durable CURRENT Online host authority');
      const next = structuredClone(state);
      next.hosts[h].bound[id] = { digest: ctx.digest, hostGeneration: ctx.hostGeneration, ownerRevision: ctx.ownerRevision, kind, at };
      store(next);
      return structuredClone(next.hosts[h].bound[id]);
    },
  };
}

/** Production writer: holds the existing runtime flock on `<file>.lock` for this writer's lifetime. -> { journal, release } */
export async function openLockedHostAuthorityJournal(file, { flockPath = '/usr/bin/flock', timeoutMs = 5000, signal, ...options } = {}) {
  const release = await takeRuntimeLock(`${file}.lock`, { flockPath, timeoutMs, signal });
  try { return { journal: openHostAuthorityJournal(file, options), release }; }
  catch (e) { release(); throw e; }
}
