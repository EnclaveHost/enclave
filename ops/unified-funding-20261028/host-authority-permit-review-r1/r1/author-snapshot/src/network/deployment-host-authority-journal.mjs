// host-authority permit r1 (SOURCE ONLY): the DURABLE host-authority section used by the v2 permit gate and the v2 witness.
// A separate owned file beside the protocol journal (the pinned deployment-lifecycle-journal.mjs and root's generated owned
// journal are NOT edited). Every accepted change is durable (temp write, fsync, rename, directory fsync) BEFORE the method returns.
//
// Fail-closed rules (root r3 additions):
//  - malformed nested host/floor/bound state refuses at open (never repaired, never reset);
//  - expectExisting: true (the operator's statement that this file was already observed) + missing file refuses (lost journal);
//    a file that disappears or changes underneath this process refuses;
//  - ANY write/fsync/rename/directory-fsync failure LATCHES unknown for the rest of this process: rereading identical bytes later
//    never converts an uncertain persistence into an authorization. Recovery is a fresh process that re-opens and re-validates.
//
//   hosts[hostId].floor  { hostGeneration, ownerRevision, digest, context }  monotonic on BOTH axes (compareHostAuthority)
//   hosts[hostId].bound  deployment -> { digest, hostGeneration, ownerRevision, kind, at }  the host authority an app context was
//                        explicitly handed to ('fresh-queued-start' | 'explicit-adoption'); never created by default/genesis
import fs from 'node:fs';
import path from 'node:path';
import { compareHostAuthority, validateHostAuthorityContext } from './deployment-host-authority.mjs';

const FORMAT = 'enclave-host-authority-permit/v1';
const ID = /^0x[0-9a-f]{64}$/, DEC = /^(0|[1-9][0-9]{0,19})$/;
export const HANDOFF_KINDS = Object.freeze(['fresh-queued-start', 'explicit-adoption']);
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));

function validate(j) {
  if (!exact(j, ['format', 'hosts']) || j.format !== FORMAT || !j.hosts || typeof j.hosts !== 'object' || Array.isArray(j.hosts))
    throw Error('host authority journal malformed');
  for (const [h, e] of Object.entries(j.hosts)) {
    if (!ID.test(h) || !exact(e, ['floor', 'bound']) || !exact(e.floor, ['hostGeneration', 'ownerRevision', 'digest', 'context']))
      throw Error('host authority journal host entry malformed');
    const c = validateHostAuthorityContext(e.floor.context);
    if (c.hostId !== h || c.digest !== e.floor.digest || c.hostGeneration !== e.floor.hostGeneration || c.ownerRevision !== e.floor.ownerRevision)
      throw Error('host authority journal floor inconsistent with its context');
    if (!e.bound || typeof e.bound !== 'object' || Array.isArray(e.bound)) throw Error('host authority journal bindings malformed');
    for (const [id, b] of Object.entries(e.bound))
      if (!ID.test(id) || !exact(b, ['digest', 'hostGeneration', 'ownerRevision', 'kind', 'at']) || !ID.test(b.digest) || !DEC.test(b.hostGeneration) ||
          !DEC.test(b.ownerRevision) || !HANDOFF_KINDS.includes(b.kind) || !Number.isSafeInteger(b.at) ||
          BigInt(b.hostGeneration) > BigInt(e.floor.hostGeneration) || BigInt(b.ownerRevision) > BigInt(e.floor.ownerRevision))
        throw Error('host authority journal binding malformed or ahead of its floor');
  }
  return j;
}

/** -> { read(hostId), accept(hostId, ctx), bind(hostId, id, ctx, {kind, at}), failed() } ; fsImpl injectable (owned temp files only). */
export function openHostAuthorityJournal(file, { fsImpl = fs, expectExisting = false } = {}) {
  if (!path.isAbsolute(file)) throw Error('absolute host authority journal path required');
  let failed = null, state = null, seen = null;
  const latch = why => { failed ??= why; throw Error(failed); };
  const same = (a, b) => a && b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
  const check = () => {
    if (failed) throw Error(failed);
    let st; try { st = fsImpl.statSync(file); } catch { st = null; }
    if (seen && !same(st, seen)) latch('host authority journal lost or changed underneath this process');
  };
  try {
    if (fsImpl.existsSync(file)) { state = validate(JSON.parse(fsImpl.readFileSync(file, 'utf8'))); seen = fsImpl.statSync(file); }
    else if (expectExisting) throw Error('previously observed host authority journal is missing');
    else state = { format: FORMAT, hosts: {} };
  } catch (e) { failed = `host authority journal unknown: ${e.message}`; state = null; }
  function store(next) {
    validate(next);
    const dir = path.dirname(file), tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
    try {
      const fd = fsImpl.openSync(tmp, 'wx', 0o600);
      try { fsImpl.writeFileSync(fd, JSON.stringify(next)); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
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
  return {
    failed: () => failed,
    read(h) { check(); const e = state.hosts[host(h)]; return e ? structuredClone(e) : null; },
    /** monotonic host-wide floor -> 'equal' | 'advance' (rollback / equivocation throw) */
    accept(h, ctx) {
      check(); validateHostAuthorityContext(ctx);
      if (ctx.hostId !== host(h)) throw Error('host authority binds another host');
      const e = state.hosts[h], how = compareHostAuthority(e?.floor ?? null, ctx);
      if (how === 'equal') return how;
      const next = structuredClone(state);
      next.hosts[h] = { floor: { hostGeneration: ctx.hostGeneration, ownerRevision: ctx.ownerRevision, digest: ctx.digest, context: structuredClone(ctx) },
        bound: structuredClone(e?.bound ?? {}) };   // existing bindings are kept (they now refer to an OLDER authority and stop matching)
      store(next);
      return how;
    },
    /** explicit handoff of ONE app context to the exact CURRENT floor; never a default, never for an older authority */
    bind(h, id, ctx, { kind, at }) {
      check();
      if (!ID.test(id || '') || !HANDOFF_KINDS.includes(kind) || !Number.isSafeInteger(at)) throw Error('explicit handoff kind/time required');
      const e = state.hosts[host(h)];
      if (!e || e.floor.digest !== ctx?.digest) throw Error('an app context is handed only to the durable CURRENT host authority');
      const next = structuredClone(state);
      next.hosts[h].bound[id] = { digest: ctx.digest, hostGeneration: ctx.hostGeneration, ownerRevision: ctx.ownerRevision, kind, at };
      store(next);
      return structuredClone(next.hosts[h].bound[id]);
    },
  };
}
