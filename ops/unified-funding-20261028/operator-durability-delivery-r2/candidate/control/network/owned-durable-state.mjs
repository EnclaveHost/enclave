// ownership r3 + async r4 + root r5-r7 async corrections + completion r5 (SOURCE ONLY): the single-owner, durability-ambiguity-preserving
// state file under BOTH host-authority sidecars (deployment-host-authority-journal.mjs and lifecycle-host-incarnation-journal.mjs).
//
// OWNERSHIP (r4 + root correction, kept). release(reason) publishes ONE memoized completion BEFORE invoking any withdrawal listener (a
// listener may re-enter release() and receives that same promise), marks the handle released, starts every listener, and releases the flock
// ONLY after every listener settled successfully. A rejection, a synchronous throw, an exception from owner.release, or the optional
// withdrawal deadline (its timer stays referenced while pending) leaves the lock HELD and the handle fenced. The completion never rejects.
// Lock loss is detected on every use (assertLive) and starts the same withdrawal.
//
// DURABILITY (r4 retained intent + acknowledgement, kept):
//   `<file>.intent` { seq, before, after, owner } - the ambiguity evidence; never deleted or rewritten except by the NEXT store's intent;
//   `<file>.commit` { seq, intent (sha256 of the intent bytes), state (sha256), outcome, owner } - the acknowledgement.
// completion r5 - ACK VISIBILITY IS NOT PROOF. When an acknowledgement became visible but its final directory sync failed, that fact is
// recorded (a) in-process for this file (every later open in this process refuses) and (b) durably as an `unproven` line in `<file>.history`
// (written in addition to - never instead of - the retained intent; it may itself fail, which the error reports). The r4 retraction rename is
// still attempted, but its success or failure proves nothing and is not relied on. A reopen is clean only if ALL hold:
//   - the acknowledgement matches the current intent's seq, exact intent bytes and the exact on-disk state hash;
//   - no in-process or durable `unproven` record for that seq is newer than a successful recovery of that seq;
//   - OWNED opens (openOwnedLock for THIS file) additionally perform BOOT VERIFICATION before the state is usable: fsync of the state file and
//     its directory now, then an fsynced `open-verified` provenance line. A failure there latches uncertain. This is the supported cold
//     restart path (openLocked* factories / openOwnedHostRegistryLifecycle / recoverOwnedHostSidecars); it never clears unknown evidence.
// Caller-owned (unowned) primitives keep r4 behaviour for consistent, never-unproven files (compatibility: root's denial-boundary reopen)
// but cannot verify or recover anything.
// RECOVERY (explicit, current owner only) REFUSES unless: the handle holds the actual lock for exactly this file and the lock inode is
// still ours; the intent exists and is a well-formed v2 intent for this file; the exact on-disk bytes equal intent.after ('landed') or
// intent.before ('not-landed'); the marker exists; file + directory fsync succeed; an fsynced `recovered` provenance line is appended; and
// the acknowledgement's own final directory sync succeeds. Nothing is synthesized from current bytes, nothing is reset, the intent and all
// history (including retracted acknowledgements) are retained. Pending/mined payloads live in the parent journal and are untouched.
//
// ESTABLISHED (unchanged): marker without file, file without marker, expectExisting without file, a v2 marker with a state file but no
// intent refuse; established:true + missing file refuses; established:false creates the empty state AT OPEN. Legacy r3 files (empty marker,
// no intent) open as committed but owned recovery of a legacy v1 intent refuses (no synthesized v2 intent).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { takeRuntimeLock } from './runtime-lock.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');
const HEX = /^[0-9a-f]{64}$/;
const INTENT = 'owned-durable-intent/v2', ACK = 'owned-durable-commit/v1', MARKER = 'owned-durable/v2';
const OWNERS = new WeakMap(); // private capability registry: inode metadata alone is not a held flock
const UNPROVEN = new Map();   // completion r5: path -> { seq, why } for acknowledgements whose final sync failed in THIS process

/**
 * openDurableState(file, { format, validate, empty, fsImpl, expectExisting, established, owner, withdrawDeadlineMs }) -> handle
 *   established: undefined (no coupling: caller-owned/test primitive) | true | false   (see header)
 *   owner: null (caller-owned primitive: no verification, no recovery) | { id, lockPath, lockStat, release } from openOwnedLock(file)
 *   withdrawDeadlineMs: optional bound; exceeding it FENCES (the lock stays held), it never releases.
 */
export function openDurableState(file, { format, validate, empty, fsImpl = fs, expectExisting = false, established, owner = null, withdrawDeadlineMs = null }) {
  if (!path.isAbsolute(file)) throw Error('absolute durable state path required');
  const key = path.resolve(file);
  const marker = `${file}.established`, intentPath = `${file}.intent`, ackPath = `${file}.commit`, historyPath = `${file}.history`, dir = path.dirname(file);
  const base = path.basename(file);
  let failed = null, state = null, seen = null, lastGood = null, lastSeq = 0, released = false, fenced = false, completion = null, verification = null;
  const listeners = [];
  const latch = why => { failed ??= why; throw Error(failed); };
  const statOrNull = p => { try { return fsImpl.statSync(p); } catch { return null; } };
  const readOrNull = p => (fsImpl.existsSync(p) ? fsImpl.readFileSync(p, 'utf8') : null);
  const sameStat = (a, b) => a && b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
  const dirSync = () => { const d = fsImpl.openSync(dir, 'r'); try { fsImpl.fsyncSync(d); } finally { fsImpl.closeSync(d); } };
  const fileSync = () => { const fd = fsImpl.openSync(file, 'r'); try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); } };
  function atomicNoDirSync(target, bytes) {
    const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const fd = fsImpl.openSync(tmp, 'wx', 0o600);
      try { fsImpl.writeFileSync(fd, bytes); fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
      fsImpl.renameSync(tmp, target);
    } catch (e) { try { fsImpl.unlinkSync(tmp); } catch {} throw e; }
  }
  const atomic = (target, bytes) => { atomicNoDirSync(target, bytes); dirSync(); };
  /** provenance line, fsynced; `durable` additionally syncs the directory (a newly created history entry) */
  function appendHistory(record, { durable = true } = {}) {
    const h = fsImpl.openSync(historyPath, 'a', 0o600);
    try { fsImpl.writeFileSync(h, JSON.stringify(record) + '\n'); fsImpl.fsyncSync(h); } finally { fsImpl.closeSync(h); }
    if (durable) dirSync();
  }
  function historyLines() {
    const text = readOrNull(historyPath);
    if (text === null) return [];
    return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { malformed: true }; } });
  }
  /** a durable `unproven` record for seq that no later successful recovery of seq superseded */
  const durablyUnproven = seq => {
    let open = false;
    for (const l of historyLines()) { if (l.malformed) open = true; else if (l.unproven === seq) open = true; else if (l.recovered === true && l.seq === seq) open = false; }
    return open;
  };
  /** the acknowledgement. Visible before its final sync: on failure, record UNPROVEN (in-process + durable history), then retract. */
  function acknowledge(record) {
    atomicNoDirSync(ackPath, JSON.stringify(record));
    try { dirSync(); }
    catch (e) {
      UNPROVEN.set(key, { seq: record.seq, why: e.message });
      let note = '';
      try { appendHistory({ unproven: record.seq, at: Date.now(), by: owner?.id ?? null, why: e.message }, { durable: false }); }
      catch (h) { note = `; durable unproven record ALSO failed: ${h.message}`; }
      try { fsImpl.renameSync(ackPath, `${ackPath}.unacknowledged-${record.seq}-${randomUUID()}`); }
      catch (r) { throw Error(`${e.message}; acknowledgement retraction ALSO failed: ${r.message}${note}`); }
      throw Error(`${e.message}${note}`);
    }
  }
  // ---- owner lifetime (root r5-r7 corrected; unchanged) ----
  const lockLost = () => { let st; try { st = fsImpl.lstatSync(owner.lockPath); } catch { st = null; } return OWNERS.get(owner)?.held !== true || !st || st.ino !== owner.lockStat.ino || st.dev !== owner.lockStat.dev; };
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
  const assertOwnership = () => {
    if (!owner || lockLost()) throw Error('durable state owner lock is not held or was lost');
  };
  const assertLive = () => {
    if (released) throw Error('durable state owner handle released: every retained operation refuses');
    if (owner && lockLost()) lose('ownership lost (lock file replaced or removed)');
  };
  /** completion r5: verification/recovery need the ACTUAL flock for exactly this file, still held (not a caller-provided flag) */
  const requireOwnedLock = what => {
    if (!owner || typeof owner.lockPath !== 'string' || !owner.lockStat) throw Error(`${what} requires the actual owner lock of this file: no verification or recovery of unknown evidence`);
    if (path.resolve(owner.lockPath) !== path.resolve(`${file}.lock`)) throw Error(`${what}: the owner lock belongs to another file`);
    assertLive();
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
  /** completion r5 BOOT VERIFICATION by a freshly acquired owner: the acknowledged bytes are synced NOW and the verification is recorded */
  function verifyOwnedOpen(i, intentBytes) {
    requireOwnedLock('owned open verification');
    fileSync(); dirSync();
    appendHistory({ verifiedAt: Date.now(), by: owner.id, seq: i.seq, intentSha256: sha(intentBytes), sha256: lastGood, outcome: 'open-verified' });
    verification = Object.freeze({ seq: i.seq, sha256: lastGood, by: owner.id });
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
      const consistent = i.format === INTENT && i.file === base && a?.format === ACK && a.file === base && a.seq === i.seq && a.intent === sha(intentBytes) &&
        hasFile && a.state === lastGood && (a.state === i.after || (a.outcome === 'not-landed' && a.state === i.before));
      if (!consistent) failed = 'durable state persistence uncertain: the durable intent has no matching durable acknowledgement (explicit verified recovery required)';
      else if (UNPROVEN.get(key)?.seq === i.seq) failed = 'durable state persistence uncertain: the acknowledgement became visible but its final sync failed in this process (owned verified recovery required)';
      else if (durablyUnproven(i.seq)) failed = 'durable state persistence uncertain: a durable record says the final acknowledgement sync failed (owned verified recovery required)';
      else if (owner) {
        try { verifyOwnedOpen(i, intentBytes); }
        catch (e) { failed = `durable state persistence uncertain: owned open verification failed: ${e.message}`; }
      }
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
    /** completion r5: the owned boot verification performed at this open (null for unowned/fresh/uncertain opens) */
    verification: () => verification,
    /** throws if released or the lock was lost (lock loss starts the withdrawal); does not consult durability latches */
    assertLive, assertOwnership,
    /** register an authority withdrawal (may return a promise) that must settle successfully before the flock is released */
    onRelease(fn) {
      if (typeof fn !== 'function') throw Error('withdrawal listener required');
      if (released) throw Error('durable state owner handle already released: a new withdrawal cannot be registered');
      listeners.push(fn);
    },
    /** -> the ONE memoized completion promise of { released, fenced, errors } (never rejects) */
    release(reason = 'owner released') { return begin(reason, true); },
    /** explicit verified recovery by the CURRENT owner of THIS file's lock; refuses rather than synthesizing evidence (see header) */
    recover() {
      assertLive();
      if (!failed) return 'clean';
      const intentBytes = readOrNull(intentPath);
      if (intentBytes === null) throw Error('intent record missing: lost provenance evidence cannot be synthesized (no recovery)');
      let intent;
      try { intent = JSON.parse(intentBytes); } catch { throw Error('intent record malformed: no recovery'); }
      if (intent?.format !== INTENT || intent.file !== base || !Number.isSafeInteger(intent.seq) || intent.seq < 1 || !HEX.test(intent.after ?? '') ||
          !(intent.before === null || HEX.test(intent.before ?? '')))
        throw Error('intent record malformed or not a v2 intent of this file: exact prior/intended state cannot be established (no recovery)');
      requireOwnedLock('recovery');
      const bytes = readOrNull(file);
      if (bytes === null) throw Error('durable state file missing: no recovery');
      const cur = sha(bytes);
      const outcome = cur === intent.after ? 'landed' : cur === intent.before ? 'not-landed' : null;
      if (!outcome) throw Error('on-disk state is neither the intended nor the prior state: no recovery');
      const next = validate(JSON.parse(bytes));
      if (readOrNull(marker) === null) throw Error('established marker is not present: no recovery');
      fileSync(); dirSync();
      appendHistory({ recoveredAt: Date.now(), by: owner.id, seq: intent.seq, intent, intentSha256: sha(intentBytes), outcome, sha256: cur, recovered: true });
      acknowledge({ format: ACK, file: base, seq: intent.seq, intent: sha(intentBytes), state: cur, outcome, owner: owner.id, at: Date.now(), recovered: true });
      if (UNPROVEN.get(key)?.seq === intent.seq) UNPROVEN.delete(key);
      state = next; lastGood = cur; lastSeq = intent.seq; seen = fsImpl.statSync(file); failed = null;
      verification = Object.freeze({ seq: intent.seq, sha256: cur, by: owner.id, recovered: outcome });
      return outcome;
    },
  };
}

/** Acquire the existing runtime flock on `<file>.lock` and record the locked inode. -> owner { id, lockPath, lockStat, release } */
export async function openOwnedLock(file, { flockPath = '/usr/bin/flock', timeoutMs = 5000, signal } = {}) {
  const lockPath = `${file}.lock`;
  const release = await takeRuntimeLock(lockPath, { flockPath, timeoutMs, signal });
  try {
    const state = { held: true };
    const owner = Object.freeze({ id: `${process.pid}:${randomUUID()}`, lockPath,
      lockStat: fs.lstatSync(lockPath), release() { if (!state.held) return; state.held = false; release(); } });
    OWNERS.set(owner, state);
    return owner;
  }
  catch (e) { release(); throw e; }
}

/** Check the private capability AND its current inode; public metadata is never ownership. */
export function assertOwnedLock(owner) {
  if (OWNERS.get(owner)?.held !== true) throw Error('owner lock is released or not a genuine held capability');
  const st = fs.lstatSync(owner.lockPath);
  if (st.ino !== owner.lockStat.ino || st.dev !== owner.lockStat.dev) throw Error('owner lock inode lost');
}
