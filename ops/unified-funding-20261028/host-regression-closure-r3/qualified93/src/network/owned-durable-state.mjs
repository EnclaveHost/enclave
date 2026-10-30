// ownership r3 (SOURCE ONLY): the single-owner, durability-ambiguity-preserving state file under BOTH host-authority sidecars
// (deployment-host-authority-journal.mjs and lifecycle-host-incarnation-journal.mjs). No other module writes these files.
//
// OWNERSHIP. A handle opened through openOwned*() holds the existing runtime flock (runtime-lock.mjs takeRuntimeLock) on `<file>.lock`.
// release() FIRST marks the handle released (every retained method then refuses forever), THEN runs the registered withdrawal listeners
// (gate.close, witness.close, ...), and only if every withdrawal succeeded releases the flock. A failed withdrawal leaves the lock HELD and
// the handle fenced: a second owner cannot acquire while live authority might remain. Lock loss (the lock path no longer the inode we
// locked) is detected on every operation and treated exactly like release (withdraw, then refuse); the helper holding the orphaned inode
// is then let go only if every withdrawal succeeded (it no longer excludes anyone either way). Release is idempotent.
//
// DURABILITY. Every write is preceded by a DURABLE intent record `<file>.intent` { before, after (sha256), owner }:
//   intent (tmp, fsync, rename, dir fsync) -> state (tmp, fsync, rename, dir fsync) -> unlink intent + dir fsync.
// Any failure latches unknown in THIS process, and because the intent record stays on disk, a NEW process/owner also opens latched:
// reopening never makes an ambiguous write clean. recover() is the only way out: it needs a live handle, classifies the on-disk state
// as exactly the intended `after` or the untouched `before` (anything else refuses), fsyncs file + directory successfully, appends an
// fsynced provenance record to `<file>.history` (intent, outcome, recovering owner) and only then removes the intent. Nothing is reset;
// floors and bindings are whatever the verified file holds.
//
// ESTABLISHED. `<file>.established` is created durably with the first state. Marker without file, file without marker, or expectExisting
// without file refuse. With an owner coupling (`established: true` = the actual owned lifecycle journal already proves this host was
// established) a missing file refuses; with `established: false` the empty state is created durably AT OPEN, before any handoff could
// repopulate it, so later loss is detectable.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { takeRuntimeLock } from './runtime-lock.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');
const INTENT = 'owned-durable-intent/v1';

/**
 * openDurableState(file, { format, validate, empty, fsImpl, expectExisting, established, owner }) -> handle
 *   established: undefined (no coupling: caller-owned/test primitive) | true | false   (see header)
 *   owner: null (caller-owned primitive) | { id, lockPath, lockStat, release }   (from openOwnedLock)
 */
export function openDurableState(file, { format, validate, empty, fsImpl = fs, expectExisting = false, established, owner = null }) {
  if (!path.isAbsolute(file)) throw Error('absolute durable state path required');
  const marker = `${file}.established`, intentPath = `${file}.intent`, historyPath = `${file}.history`, dir = path.dirname(file);
  let failed = null, state = null, seen = null, lastGood = null, released = false, fenced = false;
  const listeners = [];
  const latch = why => { failed ??= why; throw Error(failed); };
  const statOrNull = p => { try { return fsImpl.statSync(p); } catch { return null; } };
  const sameStat = (a, b) => a && b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
  const dirSync = () => { const d = fsImpl.openSync(dir, 'r'); try { fsImpl.fsyncSync(d); } finally { fsImpl.closeSync(d); } };
  function atomic(target, bytes) {
    const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const fd = fsImpl.openSync(tmp, 'wx', 0o600);
      try { fsImpl.writeFileSync(fd, bytes); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
      fsImpl.renameSync(tmp, target);
    } catch (e) { try { fsImpl.unlinkSync(tmp); } catch {} throw e; }
    dirSync();
  }
  function withdraw(reason) {
    const errors = [];
    for (const fn of listeners.splice(0)) { try { fn(reason); } catch (e) { errors.push(e); } }
    return errors;
  }
  const lockLost = () => { let st; try { st = fsImpl.lstatSync(owner.lockPath); } catch { st = null; } return !st || st.ino !== owner.lockStat.ino || st.dev !== owner.lockStat.dev; };
  function lose(reason) {          // ownership lost: withdraw first, refuse forever
    if (!released) {
      released = true; fenced = withdraw(reason).length > 0;
      if (!fenced) try { owner.release?.(); } catch {}
    }
    throw Error(`durable state authority ${reason}`);
  }
  const check = () => {
    if (released) throw Error('durable state owner handle released: every retained operation refuses');
    if (owner && lockLost()) lose('ownership lost (lock file replaced or removed)');
    if (failed) throw Error(failed);
    if (seen && !sameStat(statOrNull(file), seen)) latch('durable state lost or changed underneath this process');
    if (seen && !statOrNull(marker)) latch('durable state established marker lost');
  };
  function store(next) {
    check();
    validate(next);
    const bytes = JSON.stringify(next), after = sha(bytes), before = lastGood;
    const record = JSON.stringify({ format: INTENT, file: path.basename(file), before, after, owner: owner?.id ?? null, at: Date.now() });
    try {
      if (!fsImpl.existsSync(marker)) { const m = fsImpl.openSync(marker, 'wx', 0o600); try { fsImpl.fsyncSync(m); } finally { fsImpl.closeSync(m); } dirSync(); }
      atomic(intentPath, record);                    // durable intent BEFORE the state changes
      atomic(file, bytes);
      fsImpl.unlinkSync(intentPath); dirSync();      // commit: the intent is retired only after the state is durable
      seen = fsImpl.statSync(file);
    } catch (e) { latch(`durable state persistence uncertain: ${e.message}`); }
    state = next; lastGood = after;
  }
  // ---- open ----
  try {
    const hasFile = fsImpl.existsSync(file), hasMarker = fsImpl.existsSync(marker), hasIntent = fsImpl.existsSync(intentPath);
    if (hasFile && !hasMarker) throw Error('durable state without its established marker');
    if (!hasFile && (hasMarker || expectExisting)) throw Error('previously established durable state is missing');
    if (!hasFile && established === true) throw Error('the owned lifecycle journal is established for this host but this durable state is missing');
    if (hasFile) { const bytes = fsImpl.readFileSync(file, 'utf8'); state = validate(JSON.parse(bytes)); lastGood = sha(bytes); seen = fsImpl.statSync(file); }
    else state = structuredClone(empty);
    if (hasIntent) failed = 'durable state persistence uncertain: a durable intent record is present (explicit verified recovery required)';
    else if (!hasFile && established === false) store(structuredClone(empty));   // establish NOW, before any handoff can repopulate it
  } catch (e) { failed ??= `durable state unknown: ${e.message}`; }
  return {
    get state() { check(); return state; },
    store,
    failed: () => failed,
    released: () => released,
    fenced: () => fenced,
    ownerId: () => owner?.id ?? null,
    /** register an authority withdrawal to run (synchronously, before the flock is released) when this owner releases or is lost */
    onRelease(fn) { if (typeof fn !== 'function') throw Error('withdrawal listener required'); if (released) { fn('owner already released'); return; } listeners.push(fn); },
    /** -> { released, fenced, errors } ; idempotent */
    release(reason = 'owner released') {
      if (released) return { released: !fenced, fenced, errors: [] };
      released = true;
      const errors = withdraw(reason);
      if (errors.length) { fenced = true; return { released: false, fenced: true, errors }; }   // lock stays HELD: live authority may remain
      owner?.release?.();
      return { released: true, fenced: false, errors };
    },
    /** explicit verified recovery by the CURRENT live handle; retains provenance history; never resets */
    recover() {
      if (released) throw Error('durable state owner handle released');
      if (owner && lockLost()) lose('ownership lost (lock file replaced or removed)');
      if (!failed) return 'clean';
      const intent = fsImpl.existsSync(intentPath) ? JSON.parse(fsImpl.readFileSync(intentPath, 'utf8')) : null;
      if (intent && (intent.format !== INTENT || intent.file !== path.basename(file))) throw Error('intent record malformed: no recovery');
      const bytes = fsImpl.existsSync(file) ? fsImpl.readFileSync(file, 'utf8') : null;
      if (bytes === null) throw Error('durable state file missing: no recovery');
      const cur = sha(bytes);
      const outcome = intent ? (cur === intent.after ? 'landed' : cur === intent.before ? 'not-landed' : null) : (lastGood !== null && cur === lastGood ? 'not-landed' : null);
      if (!outcome) throw Error('on-disk state is neither the intended nor the prior state: no recovery');
      const next = validate(JSON.parse(bytes));
      const fd = fsImpl.openSync(file, 'r'); try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
      dirSync();
      if (!fsImpl.existsSync(marker)) throw Error('established marker is not present: no recovery');
      const h = fsImpl.openSync(historyPath, 'a', 0o600);
      try { fsImpl.writeFileSync(h, JSON.stringify({ recoveredAt: Date.now(), by: owner?.id ?? null, intent, outcome, sha256: cur }) + '\n'); fsImpl.fsyncSync(h); }
      finally { fsImpl.closeSync(h); }
      dirSync();
      if (intent) { fsImpl.unlinkSync(intentPath); dirSync(); }
      state = next; lastGood = cur; seen = fsImpl.statSync(file); failed = null;
      return outcome;
    },
  };
}

/** Acquire the existing runtime flock on `<file>.lock` and record the locked inode. -> owner { id, lockPath, lockStat, release } */
export async function openOwnedLock(file, { flockPath = '/usr/bin/flock', timeoutMs = 5000, signal } = {}) {
  const lockPath = `${file}.lock`;
  const release = await takeRuntimeLock(lockPath, { flockPath, timeoutMs, signal });
  try { return { id: `${process.pid}:${randomUUID()}`, lockPath, lockStat: fs.lstatSync(lockPath), release }; }
  catch (e) { release(); throw e; }
}
