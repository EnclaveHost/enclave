// Linux runtime state-directory exclusion. The parent owns the open file
// description; flock(1) only acquires the kernel lock on an inherited duplicate.
// Never unlink the lock file: replacing its inode would permit two owners.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export async function takeRuntimeLock(file, { flockPath = '/usr/bin/flock', timeoutMs = 5000, signal } = {}) {
  if (process.platform !== 'linux') throw new Error('runtime lock requires Linux flock');
  if (!path.isAbsolute(file) || !path.isAbsolute(flockPath)) throw new Error('lock and flock paths must be absolute');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('invalid lock deadline');
  signal?.throwIfAborted();
  // The caller must own a private state directory. Do not follow lock symlinks.
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  let owned = true;
  const release = () => { if (owned) { owned = false; fs.closeSync(fd); } };
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) throw new Error('runtime lock must be a regular, unshared file');
    // Nonempty files belong to a different lock protocol. Do not guess whether
    // an old PID record is stale, and never remove it while another owner races.
    if (before.size !== 0) throw new Error('legacy runtime lock: stop the old runtime and review migration first');
    await new Promise((resolve, reject) => {
      let child, failure = null, timer;
      const abort = () => {
        failure ??= signal?.reason ?? new Error('runtime lock acquisition aborted');
        child?.kill('SIGKILL');
      };
      try {
        child = spawn(flockPath, ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'],
          { stdio: ['ignore', 'ignore', 'ignore', fd], windowsHide: true });
      } catch (error) { reject(error); return; }
      child.on('error', error => { failure ??= error; });
      child.once('close', (code, sig) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else if (code === 73) reject(new Error('stateDir is in use by a running runtime'));
        else reject(new Error(`runtime flock failed (${code ?? sig})`));
      });
      timer = setTimeout(() => {
        failure ??= new Error('runtime lock acquisition deadline exceeded');
        child.kill('SIGKILL');
      }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    const current = fs.lstatSync(file);
    if (current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1 || !current.isFile()) {
      throw new Error('runtime lock inode changed during acquisition');
    }
    return release;
  } catch (error) { release(); throw error; }
}
