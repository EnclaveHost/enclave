// Local Linux processes only. Bytes are copied and hashed in a private run
// directory before execution; caller-supplied status JSON never names a build.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { procIdentity, signalOwned } from '../gossip-head-source.mjs';
import { strictWriteFile } from '../lease-release-journal.mjs';

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
export async function stageBinary(source, digest, dir, accepted, name = 'executable') {
  if (!path.isAbsolute(source) || !/^[0-9a-f]{64}$/.test(digest || '') || !accepted?.[digest]) throw Error('binary is not an accepted build');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw Error('invalid staged filename');
  const destination = path.join(dir, name);
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  if (await sha256File(destination) !== digest) throw Error('staged binary differs from accepted digest');
  fs.chmodSync(destination, 0o500);
  return destination;
}
export function spawnOwned(executable, args, { cwd, env = {}, stdoutBytes = 65536, stderrBytes = 16384, launcher = null } = {}) {
  if (process.platform !== 'linux') throw Error('derived reader process supervision requires Linux');
  const child = spawn(launcher?.file || executable, [...(launcher?.args || []), ...(launcher ? [executable] : []), ...args], {
    cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: cwd, ...env },
  });
  const identity = child.pid && procIdentity(child.pid);
  let owned = identity?.pgid === child.pid ? { pid: child.pid, ...identity } : null;
  const record = path.join(cwd, 'child.json');
  let output = '', stderr = '', reason = null, exited = false;
  const done = new Promise(resolve => {
    child.once('error', e => { reason ||= e.message; });
    child.once('close', (code, signal) => {
      exited = true;
      try { fs.unlinkSync(record); } catch {}
      resolve({ code, signal, output, stderr, reason });
    });
  });
  async function kill(message = 'process cancelled') {
    reason ||= message;
    if (owned) await signalOwned(owned, 'SIGKILL');
    else if (!exited) child.kill('SIGKILL');
  }
  child.stdout.on('data', bytes => {
    if (Buffer.byteLength(output) + bytes.length > stdoutBytes) void kill('native output limit exceeded');
    else output += bytes.toString('utf8');
  });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-stderrBytes); });
  if (!owned) void kill('child ownership unavailable');
  else {
    try { strictWriteFile(record, JSON.stringify({ format: 'enclave-derived-reader-child/v1', ...owned, executable })); }
    catch (e) { void kill(`child ownership persistence failed: ${e.message}`); }
  }
  return { pid: child.pid, owned, done, kill, get exited() { return exited; } };
}
export function assertListeningOwner(process, port) {
  const actual = process.owned && procIdentity(process.pid);
  if (process.exited || !actual || actual.pgid !== process.owned.pgid || actual.startTime !== process.owned.startTime)
    throw Error('L1 light client is not the owned live process');
  const inodes = new Set();
  for (const fd of fs.readdirSync(`/proc/${process.pid}/fd`)) {
    try { const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${process.pid}/fd/${fd}`)); if (m) inodes.add(m[1]); } catch {}
  }
  let found = false;
  for (const name of ['tcp', 'tcp6']) {
    const rows = fs.readFileSync(`/proc/net/${name}`, 'utf8').trim().split('\n').slice(1);
    for (const row of rows) {
      const fields = row.trim().split(/\s+/), [address, hexPort] = fields[1].split(':');
      if (fields[3] !== '0A' || parseInt(hexPort, 16) !== port) continue;
      if (name !== 'tcp' || address !== '0100007F' || !inodes.has(fields[9])) throw Error('L1 port is owned elsewhere or exposed outside loopback');
      found = true;
    }
  }
  if (!found) throw Error('owned L1 loopback listener not ready');
}
export async function reapRun(dir, { executable = path.join(dir, 'executable') } = {}) {
  const record = path.join(dir, 'child.json');
  if (!fs.existsSync(record)) return;
  if (fs.statSync(record).size > 4096) throw Error('invalid saved process owner');
  const owner = JSON.parse(fs.readFileSync(record, 'utf8'));
  if (owner.format !== 'enclave-derived-reader-child/v1' || owner.executable !== executable ||
      !Number.isSafeInteger(owner.pid) || owner.pid < 2 || owner.pgid !== owner.pid || !/^\d+$/.test(owner.startTime)) throw Error('invalid saved process owner');
  let exe = null; try { exe = fs.readlinkSync(`/proc/${owner.pid}/exe`).replace(/ \(deleted\)$/, ''); } catch {}
  const actual = procIdentity(owner.pid);
  if (actual && actual.startTime === owner.startTime && actual.pgid === owner.pgid) {
    if (exe !== owner.executable) throw Error('saved child executable identity differs; refusing to kill');
    await signalOwned(owner, 'SIGKILL');
    const deadline = Date.now() + 5000;
    while (procIdentity(owner.pid)?.startTime === owner.startTime) {
      if (Date.now() >= deadline) throw Error('saved child did not terminate; preserving run directory');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { fs.unlinkSync(record); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
