// Fixed local Windows command transport. No shell, retry, ledger reset or release.
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const hex = (s, n) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
function local(s) {
  return typeof s === 'string' && s.length <= 512 && /^[A-Za-z]:\\/.test(s)
    && !/["\r\n\0]/.test(s) && !s.slice(3).includes(':')
    && path.win32.normalize(s) === s && !s.endsWith('\\');
}
async function imageHash(filename) {
  const file = await open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 262144) throw new Error('physical pool image bound');
    const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('physical pool image changed');
    return crypto.createHash('sha256').update(bytes.subarray(0, offset)).digest('hex');
  } finally { await file.close(); }
}
// deps are trusted test adapters only. main.mjs never obtains them from requests
// or environment. The native command additionally validates its protected image.
export function createPhysicalReservations(config, deps = {}) {
  const { command, commandHash, configPath, poolHash, boot } = config ?? {};
  // The command is part of THIS trusted manager installation, never a selectable
  // executable elsewhere. Production enrollment must first qualify SYSTEM/admin
  // ownership, protected ACLs and non-reparse ancestry for the whole installation
  // (including this module/main and command). Hashing is not that qualification.
  const installation = deps.installation ?? path.win32.dirname(fileURLToPath(import.meta.url));
  const installedCommand = path.win32.join(installation, 'physical-pool-command.exe');
  if (!local(command) || !local(configPath) || path.win32.basename(configPath) !== 'pool.txt'
      || command !== installedCommand
      || !hex(commandHash, 64) || !hex(poolHash, 64) || !hex(boot, 32)
      || (deps.platform ?? process.platform) !== 'win32') throw new Error('invalid Windows physical pool configuration');
  const launch = deps.spawn ?? spawn, hash = deps.imageHash ?? imageHash;
  const clock = deps.clock ?? (() => performance.now()), wall = deps.wall ?? Date.now;
  let busy = false, poisoned = false;
  async function request(operation, claim) {
    if (busy || poisoned) throw new Error('physical pool transport occupied or held');
    if (!claim || claim.poolHash !== poolHash || claim.boot !== boot || !hex(claim.id, 64)
        || !['app-native', 'app-legacy'].includes(claim.actor) || !Number.isSafeInteger(claim.bytes)
        || claim.bytes <= 0 || claim.bytes % 1048576) throw new Error('invalid manager physical claim');
    const expected = { schema: 'host-physical-pool-result/1', operation, poolHash, boot,
      actor: claim.actor, id: claim.id, bytes: claim.bytes, nonce: crypto.randomBytes(16).toString('hex'), imageHash: commandHash };
    const issued = wall();
    if (!Number.isSafeInteger(issued) || issued < 0 || !Number.isSafeInteger(issued + 5000)) throw new Error('invalid request clock');
    busy = true; const start = clock(); let child = null, timer, expired = false;
    const check = () => { if (expired || clock() - start >= 5000) throw new Error('physical pool transport deadline'); };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = poisoned = true;
        // This request is failed forever even if a late process completes. A kill
        // request is not death proof and never releases durable reservations.
        try { child?.kill(); } catch {}
        reject(new Error('physical pool transport deadline; reservation held'));
      }, 5000);
    });
    const work = (async () => {
      if (await hash(command) !== commandHash) throw new Error('physical pool command hash mismatch');
      check();
      const argv = [operation, configPath, poolHash, boot, expected.actor, expected.id, String(expected.bytes),
        expected.nonce, String(issued), String(issued + 5000), commandHash];
      await new Promise((resolve, reject) => {
        let output = '', errorBytes = 0, invalid = false;
        const refuse = () => { invalid = poisoned = true; try { child?.kill(); } catch {} reject(new Error('physical pool response unconfirmed; reservation held')); };
        child = launch(command, argv, { shell: false, windowsHide: true, cwd: path.win32.dirname(command),
          env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', WINDIR: process.env.SystemRoot ?? 'C:\\Windows' },
          stdio: ['ignore', 'pipe', 'pipe'] });
        child.once('error', refuse);
        child.stdout.on('data', b => { if (invalid) return; if (output.length + b.length > 2048) return refuse(); output += b.toString('ascii'); });
        child.stderr.on('data', b => { errorBytes += b.length; if (errorBytes > 2048) refuse(); });
        child.once('close', (code, signal) => {
          if (invalid) return;
          try {
            check(); if (code !== 0 || signal || errorBytes) throw new Error('command refused');
            const response = JSON.parse(output);
            if (Object.keys(response).length !== Object.keys(expected).length
                || Object.entries(expected).some(([key, value]) => response[key] !== value)) throw new Error('response binding differs');
            resolve();
          } catch { reject(new Error('physical pool command did not confirm exact claim; reservation held')); }
        });
      });
      check();
    })();
    try { await Promise.race([work, timeout]); }
    finally { clearTimeout(timer); busy = false; }
  }
  return Object.freeze({ poolHash, boot, acquire: c => request('acquire', c), consumeStart: c => request('consume', c) });
}

export function physicalReservationsFromEnv(env) {
  const keys = ['ENCLAVE_PHYSICAL_POOL_COMMAND', 'ENCLAVE_PHYSICAL_POOL_COMMAND_SHA256',
    'ENCLAVE_PHYSICAL_POOL_CONFIG', 'ENCLAVE_PHYSICAL_POOL_SHA256', 'ENCLAVE_PHYSICAL_POOL_BOOT'];
  if (!keys.some(key => env[key] !== undefined)) return null;
  const [command, commandHash, configPath, poolHash, boot] = keys.map(key => env[key]);
  return createPhysicalReservations({ command, commandHash, configPath, poolHash, boot });
}
