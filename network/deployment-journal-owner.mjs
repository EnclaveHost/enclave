import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { takeRuntimeLock } from './runtime-lock.mjs';
import { openLifecycleJournal } from './deployment-lifecycle-journal.mjs';
import { strictWriteFile } from './lease-release-journal.mjs';

// Kernel-owned exclusion, released on process death. No stale PID deletion,
// time-based lock stealing, or deletion of a journal to recover from a crash.
export async function ownLifecycleJournal(file, { initialize = false } = {}) {
  if (!path.isAbsolute(file)) throw Error('absolute journal path required');
  const dir = fs.realpathSync(path.dirname(file));
  const canonical = path.join(dir, path.basename(file));
  let release;
  if (process.platform === 'linux') release = await takeRuntimeLock(`${canonical}.lock`);
  else if (process.platform === 'win32') {
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
