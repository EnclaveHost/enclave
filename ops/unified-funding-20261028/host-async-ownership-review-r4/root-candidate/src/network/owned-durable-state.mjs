// ownership r3 + async r4 (SOURCE ONLY): the single-owner, durability-ambiguity-preserving state file under BOTH host-authority sidecars
// (deployment-host-authority-journal.mjs and lifecycle-host-incarnation-journal.mjs). No other module writes these files.
//
// OWNERSHIP (r4: asynchronous). A handle opened through openOwned*() holds the existing runtime flock (runtime-lock.mjs takeRuntimeLock) on
// `<file>.lock`. release(reason) SYNCHRONOUSLY marks the handle released (every retained method refuses from that instant) and starts every
// registered withdrawal listener (gate.close, witness.close, composition withdrawal ...). A listener may return a promise. The flock is
// released ONLY after every listener has settled successfully; any rejection, synchronous throw or the optional withdrawal deadline leaves
// the lock HELD and the handle fenced for the life of the process (no timeout ever releases it). release() returns ONE memoized completion
// promise resolving to { released, fenced, errors } (never rejecting, so no rejection is unhandled); repeated calls return that same promise.
// Lock loss (the lock path is no longer the inode we locked) is detected on every operation, including assertLive() which the gate calls on
// every assert, and starts exactly the same withdrawal; the orphaned helper fd is closed only after a successful withdrawal.
//
// DURABILITY (r4: retained acknowledgement). Each write is a numbered transaction with two retained records:
//   `<file>.intent` { seq, before, after (sha256 of exact bytes), owner }  - the ambiguity evidence; a store NEVER deletes it;
//   `<file>.commit` { seq, intent (sha256 of the intent bytes), state (sha256), outcome, owner } - the acknowledgement.
//   intent (tmp, fsync, rename, dir fsync) -> state (tmp, fsync, rename, dir fsync) -> commit (tmp, fsync, rename, dir fsync).
// A reopen is clean only when the commit names the CURRENT intent's seq and exact intent bytes, and the on-disk state hashes to the
// acknowledged state (= intent.after, or intent.before for an explicitly recovered 'not-landed'). The commit is written only after the
// state and its directory entry were synced successfully. If the commit's OWN final directory sync fails, the commit is retracted by
// rename to `<file>.commit.unacknowledged-<seq>-<uuid>` (kept as history; the intent is untouched), so a fresh open sees an intent without a
// matching acknowledgement and stays uncertain. Any failure latches this process too. recover() (explicit, by the live handle) classifies the
// exact on-disk bytes against intent.after / intent.before (anything else refuses), fsyncs file + directory, appends an fsynced provenance
// line to `<file>.history`, and only then writes the acknowledgement through the SAME retractable path: a failure of recovery's final
// acknowledgement also stays uncertain across a fresh open. Nothing is reset; floors, bindings and pending payloads are what the file holds.
// Residual (stated, not hidden): if the retraction rename itself fails after a failed final directory sync, the error says so and this
// process stays latched, but a same-boot fresh open could see that acknowledgement; it only ever acknowledges bytes whose file and directory
// syncs had already succeeded.
//
// ESTABLISHED. `<file>.established` (content 'owned-durable/v2') is created durably with the first state. Marker without file, file without
// marker, expectExisting without file, or a v2 marker with a state file but no intent refuse. With an owner coupling (`established: true` =
// the actual owned lifecycle journal already proves this host was established) a missing file refuses; with `established: false` the empty
// state is created durably AT OPEN, before any handoff could repopulate it. A legacy r3 file (empty marker, no intent) opens as committed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { takeRuntimeLock } from './runtime-lock.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');
const INTENT = 'owned-durable-intent/v2', INTENT_R3 = 'owned-durable-intent/v1', ACK = 'owned-durable-commit/v1', MARKER = 'owned-durable/v2';

/**
 * openDurableState(file, { format, validate, empty, fsImpl, expectExisting, established, owner, withdrawDeadlineMs }) -> handle
 *   established: undefined (no coupling: caller-owned/test primitive) | true | false   (see header)
 *   owner: null (caller-owned primitive) | { id, lockPath, lockStat, release }   (from openOwnedLock)
 *   withdrawDeadlineMs: optional bound; exceeding it FENCES (the lock stays held), it never releases.
 */
export function openDurableState(file, { format, validate, empty, fsImpl = fs, expectExisting = false, established, owner = null, withdrawDeadlineMs = null }) {
  if (!path.isAbsolute(file)) throw Error('absolute durable state path required');
  const marker = `${file}.established`, intentPath = `${file}.intent`, ackPath = `${file}.commit`, historyPath = `${file}.history`, dir = path.dirname(file);
  const base = path.basename(file);
  let failed = null, state = null, seen = null, lastGood = null, lastSeq = 0, released = false, fenced = false, completion = null;
  const listeners = [];
  const latch = why => { failed ??= why; throw Error(failed); };
  const statOrNull = p => { try { return fsImpl.statSync(p); } catch { return null; } };
  const readOrNull = p => (fsImpl.existsSync(p) ? fsImpl.readFileSync(p, 'utf8') : null);
  const sameStat = (a, b) => a && b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
  const dirSync = () => { const d = fsImpl.openSync(dir, 'r'); try { fsImpl.fsyncSync(d); } finally { fsImpl.closeSync(d); } };
  function atomicNoDirSync(target, bytes) {
    const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const fd = fsImpl.openSync(tmp, 'wx', 0o600);
      try { fsImpl.writeFileSync(fd, bytes); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
      fsImpl.renameSync(tmp, target);
    } catch (e) { try { fsImpl.unlinkSync(tmp); } catch {} throw e; }
  }
  const atomic = (target, bytes) => { atomicNoDirSync(target, bytes); dirSync(); };
  /** the acknowledgement: visible only after its final directory sync succeeded, otherwise retracted (kept as history) */
  function acknowledge(record) {
    atomicNoDirSync(ackPath, JSON.stringify(record));
    try { dirSync(); }
    catch (e) {
      try { fsImpl.renameSync(ackPath, `${ackPath}.unacknowledged-${record.seq}-${randomUUID()}`); }
      catch (r) { throw Error(`${e.message}; acknowledgement retraction ALSO failed: ${r.message}`); }
      throw e;
    }
  }
  // ---- owner lifetime ----
  const lockLost = () => { let st; try { st = fsImpl.lstatSync(owner.lockPath); } catch { st = null; } return !st || st.ino !== owner.lockStat.ino || st.dev !== owner.lockStat.dev; };
  function begin(reason, releaseLock) {
    if (completion) return completion;
    // Publish the exact completion before callbacks: a withdrawal may re-enter release().
    let resolveCompletion;
    completion = new Promise(resolve => { resolveCompletion = resolve; });
    released = true;
    const started = listeners.splice(0).map(fn => {
      try { const value = fn(reason); return { value, async: typeof value?.then === 'function' }; }
      catch (error) { return { error }; }
    });
    const finish = errors => {
      const failures = [...errors];
      if (!failures.length && releaseLock) {
        try { owner?.release?.(); } catch (error) { failures.push(error); }
      }
      if (failures.length) {
        fenced = true;
        resolveCompletion(Object.freeze({ released: false, fenced: true, errors: failures }));
      } else resolveCompletion(Object.freeze({ released: true, fenced: false, errors: [] }));
    };
    if (started.every(s => !s.error && !s.async)) { finish([]); return completion; }
    const all = Promise.allSettled(started.map(s => (s.error ? Promise.reject(s.error) : Promise.resolve(s.value))))
      .then(rs => rs.filter(r => r.status === 'rejected').map(r => r.reason));
    let timer = null;
    const bounded = withdrawDeadlineMs === null ? all : Promise.race([all, new Promise(res => {
      // Awaiting release must keep its deadline alive even when no other handle is referenced.
      timer = setTimeout(() => res([Error(`owner withdrawal deadline exceeded ${withdrawDeadlineMs} ms: authority stays fenced`)]), withdrawDeadlineMs);
    })]);
    bounded.then(errors => { clearTimeout(timer); finish(errors); }, error => { clearTimeout(timer); finish([error]); });
    return completion;
  }
  function lose(reason) {          // ownership lost: withdraw, refuse forever; the orphaned fd is closed only after a successful withdrawal
    begin(reason, true);
    throw Error(`durable state authority ${reason}`);
  }
  const assertLive = () => {
    if (released) throw Error('durable state owner handle released: every retained operation refuses');
    if (owner && lockLost()) lose('ownership lost (lock file replaced or removed)');
  };
  const check = () => {
    assertLive();
    if (failed) throw Error(failed);
    if (seen && !sameStat(statOrNull(file), seen)) latch('durable state lost or changed underneath this process');
    if (seen && !statOrNull(marker)) latch('durable state established marker lost');
  };
  function store(next) {
    check();
    validate(next);
    const bytes = JSON.stringify(next), after = sha(bytes), before = lastGood, seq = lastSeq + 1, by = owner?.id ?? null;
    const intent = JSON.stringify({ format: INTENT, file: base, seq, before, after, owner: by, at: Date.now() });
    try {
      if (!fsImpl.existsSync(marker)) atomic(marker, MARKER);
      atomic(intentPath, intent);                     // the ambiguity evidence lands BEFORE the state changes and is never deleted here
      atomic(file, bytes);
      acknowledge({ format: ACK, file: base, seq, intent: sha(intent), state: after, outcome: 'stored', owner: by, at: Date.now() });
      seen = fsImpl.statSync(file);
    } catch (e) { latch(`durable state persistence uncertain: ${e.message}`); }
    state = next; lastGood = after; lastSeq = seq;
  }
  // ---- open ----
  try {
    const hasFile = fsImpl.existsSync(file), markerBytes = readOrNull(marker);
    if (hasFile && markerBytes === null) throw Error('durable state without its established marker');
    if (!hasFile && (markerBytes !== null || expectExisting)) throw Error('previously established durable state is missing');
    if (!hasFile && established === true) throw Error('the owned lifecycle journal is established for this host but this durable state is missing');
    if (hasFile) { const bytes = fsImpl.readFileSync(file, 'utf8'); state = validate(JSON.parse(bytes)); lastGood = sha(bytes); seen = fsImpl.statSync(file); }
    else state = structuredClone(empty);
    const intentBytes = readOrNull(intentPath), ackBytes = readOrNull(ackPath);
    if (intentBytes !== null) {
      const i = JSON.parse(intentBytes), a = ackBytes === null ? null : JSON.parse(ackBytes);
      if (Number.isSafeInteger(i.seq)) lastSeq = i.seq;
      const clean = i.format === INTENT && i.file === base && a?.format === ACK && a.file === base && a.seq === i.seq && a.intent === sha(intentBytes) &&
        hasFile && a.state === lastGood && (a.state === i.after || (a.outcome === 'not-landed' && a.state === i.before));
      if (!clean) failed = 'durable state persistence uncertain: the durable intent has no matching durable acknowledgement (explicit verified recovery required)';
    } else if (hasFile && (markerBytes === MARKER || ackBytes !== null)) failed = 'durable state persistence uncertain: v2 state without its intent record';
    if (!failed && !hasFile && established === false) store(structuredClone(empty));   // establish NOW, before any handoff can repopulate it
  } catch (e) { failed ??= `durable state unknown: ${e.message}`; }
  return {
    get state() { check(); return state; },
    store,
    failed: () => failed,
    released: () => released,
    fenced: () => fenced,
    ownerId: () => owner?.id ?? null,
    /** throws if released or the lock was lost (lock loss starts the withdrawal); does not consult durability latches */
    assertLive,
    /** register an authority withdrawal (may return a promise) that must settle successfully before the flock is released */
    onRelease(fn) {
      if (typeof fn !== 'function') throw Error('withdrawal listener required');
      if (released) throw Error('durable state owner handle already released: a new withdrawal cannot be registered');
      listeners.push(fn);
    },
    /** -> the ONE memoized completion promise of { released, fenced, errors } (never rejects) */
    release(reason = 'owner released') { return begin(reason, true); },
    /** explicit verified recovery by the CURRENT live handle; retains provenance history; never resets; its acknowledgement is retractable */
    recover() {
      assertLive();
      if (!failed) return 'clean';
      const intentBytes = readOrNull(intentPath), intent = intentBytes === null ? null : JSON.parse(intentBytes);
      if (intent && (![INTENT, INTENT_R3].includes(intent.format) || intent.file !== base)) throw Error('intent record malformed: no recovery');
      const bytes = readOrNull(file);
      if (bytes === null) throw Error('durable state file missing: no recovery');
      const cur = sha(bytes);
      const outcome = intent ? (cur === intent.after ? 'landed' : cur === intent.before ? 'not-landed' : null) : (lastGood !== null && cur === lastGood ? 'not-landed' : null);
      if (!outcome) throw Error('on-disk state is neither the intended nor the prior state: no recovery');
      const next = validate(JSON.parse(bytes));
      if (readOrNull(marker) === null) throw Error('established marker is not present: no recovery');
      const fd = fsImpl.openSync(file, 'r'); try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
      dirSync();
      const by = owner?.id ?? null;
      const h = fsImpl.openSync(historyPath, 'a', 0o600);
      try { fsImpl.writeFileSync(h, JSON.stringify({ recoveredAt: Date.now(), by, intent, intentSha256: intentBytes === null ? null : sha(intentBytes), outcome, sha256: cur }) + '\n'); fsImpl.fsyncSync(h); }
      finally { fsImpl.closeSync(h); }
      dirSync();
      let ackIntent = intentBytes, seq = intent?.seq;
      if (!intent || intent.format !== INTENT) {      // legacy/absent intent: a fresh v2 intent describing exactly the verified bytes
        seq = lastSeq + 1;
        ackIntent = JSON.stringify({ format: INTENT, file: base, seq, before: cur, after: cur, owner: by, at: Date.now(), recovered: intent ?? null });
        atomic(intentPath, ackIntent);
      }
      acknowledge({ format: ACK, file: base, seq, intent: sha(ackIntent), state: cur, outcome, owner: by, at: Date.now(), recovered: true });
      state = next; lastGood = cur; lastSeq = seq; seen = fsImpl.statSync(file); failed = null;
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
