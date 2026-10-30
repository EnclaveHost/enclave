import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stageBinary, spawnOwned, assertListeningOwner } from './process.mjs';
import { boundedRpc, finalizedHeader } from './rpc.mjs';
import { stageLibraries, nativeCommand } from './libraries.mjs';

export const L1_BUILDS = Object.freeze({
  cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0: 'helios-eeffcc9 ethereum mode; original-game live canary 2026-10-26',
});
export const CHECKPOINT_RECORDS = Object.freeze({
  '2e8502e68864abb49a230a69612bd7c98c94775d8dd81f956a0185d53652ac33':
    'mainnet slot 15511008, five-source checkpoint recorded 2026-10-25; maximum age seven days',
});
const OWNED = new WeakSet();
export function assertL1Runtime(runtime) {
  if (!OWNED.has(runtime)) throw Error('L1 authority must be an owned local light-client runtime');
  runtime.assertOwned();
}
export function readCheckpoint(file, { accepted = CHECKPOINT_RECORDS, now = Date.now } = {}) {
  if (!path.isAbsolute(file) || fs.statSync(file).size > 16384) throw Error('invalid checkpoint record');
  const bytes = fs.readFileSync(file), digest = createHash('sha256').update(bytes).digest('hex');
  if (!accepted[digest]) throw Error('checkpoint record is not reviewed');
  const record = JSON.parse(bytes);
  if (record.format !== 'enclave-l1-checkpoint/v1' || record.network !== 'mainnet' || !/^0x[0-9a-f]{64}$/.test(record.root) ||
      !Number.isSafeInteger(record.slot) || record.slot < 0) throw Error('invalid checkpoint schema');
  const timestamp = 1606824023 + record.slot * 12, seconds = Math.floor(now() / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp > seconds + 2 || seconds - timestamp > 604800) throw Error('reviewed checkpoint expired or from the future');
  return Object.freeze({ root: record.root, slot: record.slot, timestamp, digest });
}
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener('abort', abort, { once: true });
});
export async function startL1Runtime(config, { runDir, signal, now = Date.now,
  acceptedBuilds = L1_BUILDS, acceptedCheckpoints = CHECKPOINT_RECORDS, buildArgs = null } = {}) {
  const { port, binary, checkpointFile, consensusUrl, executionUrl } = config;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !path.isAbsolute(runDir)) throw Error('invalid L1 runtime configuration');
  const requestTimeoutMs = config.requestTimeoutMs ?? 20000, readyTimeoutMs = config.readyTimeoutMs ?? 120000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 200000 ||
      !Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 100 || readyTimeoutMs > 600000) throw Error('invalid L1 runtime deadlines');
  for (const endpoint of [consensusUrl, executionUrl]) {
    const u = new URL(endpoint);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash || u.search) throw Error('invalid L1 source URL');
  }
  const checkpoint = readCheckpoint(checkpointFile, { accepted: acceptedCheckpoints, now });
  const executable = await stageBinary(binary.path, binary.sha256, runDir, acceptedBuilds);
  const libraries = await stageLibraries(config.runtime, runDir);
  const data = path.join(runDir, 'data'); fs.mkdirSync(data, { mode: 0o700 });
  const args = buildArgs ? buildArgs({ port, checkpoint, data }) : ['ethereum', '--network', 'mainnet', '--consensus-rpc', consensusUrl,
    '--execution-rpc', executionUrl, '--checkpoint', checkpoint.root, '--data-dir', data,
    '--rpc-bind-ip', '127.0.0.1', '--rpc-port', String(port), '--strict-checkpoint-age'];
  const command = nativeCommand(executable, args, libraries);
  signal?.throwIfAborted();
  const child = spawnOwned(command.executable, command.args, { cwd: runDir });
  const close = async () => { await child.kill('L1 runtime closed'); await child.done; };
  const onAbort = () => { void close(); }; signal?.addEventListener('abort', onAbort, { once: true });
  let closed = false;
  const assertOwned = () => {
    if (closed || signal?.aborted) throw Error('L1 runtime closed');
    // Check checkpoint lifetime on use as well as startup; never roll forward
    // an expired weak-subjectivity pin merely because a process stayed alive.
    if (Math.floor(now() / 1000) - checkpoint.timestamp > 604800) throw Error('reviewed checkpoint expired');
    assertListeningOwner(child, port);
  };
  const request = boundedRpc(`http://127.0.0.1:${port}`, { assertOwned, timeoutMs: requestTimeoutMs });
  let readyTimer;
  try {
    const ready = new AbortController();
    readyTimer = setTimeout(() => ready.abort(Error('L1 readiness deadline')), readyTimeoutMs);
    const readinessSignal = signal ? AbortSignal.any([ready.signal, signal]) : ready.signal;
    for (;;) {
      readinessSignal.throwIfAborted();
      if (child.exited) throw Error(`L1 client exited: ${(await child.done).stderr.slice(-600)}`);
      try {
        if (await request('eth_chainId', [], { signal: readinessSignal }) !== '0x1') throw Error('L1 client is on another chain');
        finalizedHeader(await request('eth_getBlockByNumber', ['finalized', false], { signal: readinessSignal }), Math.floor(now() / 1000), 1800);
        break;
      } catch { readinessSignal.throwIfAborted(); }
      await wait(100, readinessSignal);
    }
    clearTimeout(readyTimer);
    const runtime = Object.freeze({ request, assertOwned, checkpoint, pid: child.pid,
      async finalized({ signal: requestSignal, maxAgeSec = 1800 } = {}) {
        if (!Number.isInteger(maxAgeSec) || maxAgeSec < 1 || maxAgeSec > 3600) throw Error('invalid L1 freshness bound');
        return finalizedHeader(await request('eth_getBlockByNumber', ['finalized', false], { signal: requestSignal }), Math.floor(now() / 1000), maxAgeSec);
      },
      async close() { closed = true; signal?.removeEventListener('abort', onAbort); await close(); },
    });
    OWNED.add(runtime); return runtime;
  } catch (e) { closed = true; signal?.removeEventListener('abort', onAbort); await close(); throw e; }
  finally { clearTimeout(readyTimer); }
}
