import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { openLifecycleJournal, validateLifecycleJournal } from './deployment-lifecycle-journal.mjs';
import { strictWriteFile } from './lease-release-journal.mjs';
import { openOwnedLock, openDurableState } from './owned-durable-state.mjs';

// Kernel-owned exclusion, released on process death. No stale PID deletion,
// time-based lock stealing, or deletion of a journal to recover from a crash.
export async function ownLifecycleJournal(file, { initialize = false, importSha256 = null,
  withdrawDeadlineMs = 5000, fsImpl = fs, ...lockOptions } = {}) {
  if (!path.isAbsolute(file)) throw Error('absolute journal path required');
  const dir = fs.realpathSync(path.dirname(file));
  const canonical = path.join(dir, path.basename(file));
  if (process.platform === 'linux') {
    const owner = await openOwnedLock(canonical, lockOptions);
    let durable;
    try {
      durable = openDurableState(canonical, { format: 'enclave-lifecycle/v1',
        validate: validateLifecycleJournal, empty: { version: 1, deployments: [], authorityAnchors: {} },
        expectExisting: !initialize, established: initialize ? false : true, owner,
        withdrawDeadlineMs, fsImpl, importSha256, requireVersion2: true });
      if (durable.failed()) throw Error(durable.failed());
      const raw = openLifecycleJournal(canonical, { storage: durable });
      const journal = Object.fromEntries(Object.entries(raw).map(([name, fn]) => [name, (...args) => {
        if (durable.released()) throw Error('journal owner closed');
        try { return fn(...args); }
        catch (error) {
          // A caller error (e.g. conflicting vote) does not close a sound owner.
          // Persistence/continuity loss withdraws registered serving boundaries.
          if (durable.failed()) durable.release('journal durability lost');
          throw error;
        }
      }]));
      return Object.freeze({ journal: Object.freeze(journal),
        onRelease: fn => durable.onRelease(fn),
        close: reason => durable.release(reason), verification: () => durable.verification() });
    } catch (error) {
      if (durable) await durable.release('journal open refused'); else owner.release();
      throw error;
    }
  }
  if (importSha256 !== null) throw Error('owned durable import requires qualified Linux flock');
  let release;
  if (process.platform === 'win32') {
    const name = createHash('sha256').update(canonical.toLowerCase()).digest('hex');
    const server = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(`\\\\.\\pipe\\enclave-lifecycle-${name}`, resolve);
    });
    release = () => server.close();
  } else throw Error('lifecycle journal needs Linux flock or a Windows named pipe');
  let closed = false;
  const close = () => { if (!closed) { closed = true; release(); } };
  try {
    if (!fs.existsSync(canonical)) {
      // Enrollment alone can initialize a new journal. A missing file during
      // normal restart is lost safety state, not permission to forget votes.
      if (!initialize) throw Error('lifecycle journal missing; authenticated recovery or initial enrollment required');
      strictWriteFile(canonical, JSON.stringify({ version: 1, deployments: [], authorityAnchors: {} }));
    }
    const raw = openLifecycleJournal(canonical);
    const journal = Object.fromEntries(Object.entries(raw).map(([name, fn]) => [name, (...args) => {
      if (closed) throw Error('journal owner closed'); return fn(...args);
    }]));
    return { journal, close };
  } catch (e) { close(); throw e; }
}

/** Explicit Linux recovery of a retained before/after write intent. No transaction
 * is settled here and no serving capability is returned; reopen and reauthenticate. */
export async function recoverLifecycleJournal(file, { fsImpl = fs, ...lockOptions } = {}) {
  if (process.platform !== 'linux' || !path.isAbsolute(file)) throw Error('Linux absolute journal path required');
  const canonical = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  const owner = await openOwnedLock(canonical, lockOptions);
  let durable;
  try {
    durable = openDurableState(canonical, { format: 'enclave-lifecycle/v1',
      validate: validateLifecycleJournal, empty: { version: 1, deployments: [], authorityAnchors: {} },
      expectExisting: true, established: true, owner, fsImpl, requireVersion2: true });
    const outcome = durable.recover();
    return Object.freeze({ outcome, verification: durable.verification(), servingAuthorized: false });
  } finally {
    if (durable) await durable.release('recovery finished'); else owner.release();
  }
}
