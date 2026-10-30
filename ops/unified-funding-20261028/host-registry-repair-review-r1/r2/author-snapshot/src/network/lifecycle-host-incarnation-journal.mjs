// host-registry r2 (repair r1): the DURABLE host-incarnation section for the owned lifecycle journal. Intended location:
// network/lifecycle-host-incarnation-journal.mjs. The generated owned journal (journal-candidate) is NOT modified: this adds the three
// methods the host-registry dispatch requires (HOST_INCARNATION_FNS) beside it, in its own file, with the same discipline: every
// accepted value is written (temp file, fsync, rename, directory fsync) BEFORE the method returns, so a crash can never reopen at a
// lower floor or lose an app binding. Unreadable or malformed state throws (unknown, never allow); nothing is ever reset.
//
//   floor    the highest canonical host incarnation this host ever accepted (exact decimal generation + digest + context)
//   genesis  digest of the FIRST incarnation this file ever accepted (activation handoff; see hostIncarnationGenesis)
//   bound    deployment id -> { generation, digest, reason, at }: the incarnation an app context started or was adopted under
import fs from 'node:fs';
import path from 'node:path';
import { hostIncarnationDigest, exactUint64 } from './lifecycle-host-profile.mjs';

const FORMAT = 'enclave-host-incarnation/v1';
const ID = /^0x[0-9a-f]{64}$/;

function load(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { format: FORMAT, hosts: {} }; throw e; }
  const j = JSON.parse(raw);
  if (j?.format !== FORMAT || !j.hosts || typeof j.hosts !== 'object' || Array.isArray(j.hosts)) throw Error('host incarnation journal malformed');
  return j;
}
function store(file, j) {
  const dir = path.dirname(file), tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(j)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
}

/** Pure in-file rules (also the reference for the labelled TEST mock). -> { readHostIncarnation, acceptHostIncarnation, bindHostIncarnation } */
export function hostIncarnationSection(file) {
  if (!path.isAbsolute(file)) throw Error('absolute host incarnation journal path required');
  const entry = (j, h) => { if (!ID.test(h || '')) throw Error('host id must be a lowercase bytes32'); return j.hosts[h] ?? null; };
  return {
    readHostIncarnation(h) { const e = entry(load(file), h); return e ? structuredClone(e) : null; },
    acceptHostIncarnation(h, x) {
      if (!x || x.hostId !== h || x.digest !== hostIncarnationDigest(x) || exactUint64(x.generation, 'host generation') !== x.generation)
        throw Error('host incarnation malformed or digest mismatch');
      const j = load(file), e = entry(j, h), f = e?.floor;
      if (f) {
        const g = BigInt(x.generation), fg = BigInt(f.generation);
        if (g < fg) throw Error(`host incarnation rollback (generation ${x.generation} below accepted ${f.generation})`);
        if (g === fg && x.digest !== f.digest) throw Error(`host incarnation equivocation at generation ${x.generation}`);
        if (g === fg) return structuredClone(f);
      }
      const floor = { generation: x.generation, digest: x.digest, context: structuredClone(x) };
      j.hosts[h] = { floor, genesis: e?.genesis ?? x.digest, bound: e?.bound ?? {} };
      store(file, j);
      return structuredClone(floor);
    },
    bindHostIncarnation(h, id, { generation, digest, reason, at }) {
      if (!ID.test(id || '')) throw Error('deployment id must be a lowercase bytes32');
      const j = load(file), e = entry(j, h);
      if (!e?.floor || e.floor.digest !== digest || e.floor.generation !== generation) throw Error('an app context binds only the durable current host incarnation');
      if (typeof reason !== 'string' || !reason || !Number.isSafeInteger(at)) throw Error('binding reason/time required');
      e.bound[id] = { generation, digest, reason: reason.slice(0, 200), at };
      store(file, j);
      return structuredClone(e.bound[id]);
    },
  };
}

/** The generated owned journal + this section as ONE plain journal object (every original method forwarded with its own `this`). */
export function withHostIncarnationJournal(journal, file) {
  const out = {}, section = hostIncarnationSection(file);
  for (let o = journal; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
    for (const k of Object.getOwnPropertyNames(o)) if (k !== 'constructor' && !(k in out) && typeof journal[k] === 'function') out[k] = (...a) => journal[k](...a);
  for (const k of Object.keys(section)) { if (k in out) throw Error(`journal already defines ${k}`); out[k] = section[k]; }
  return Object.freeze(out);
}
