import fs from 'node:fs';
import path from 'node:path';
import { spawnOwned } from './process.mjs';
import { nativeCommand } from './libraries.mjs';

// Source-built combined verifier: nine native checks plus two compiled config/
// serde checks passed. Live witness and accepted-image qualification are separate.
// A configuration file cannot declare an arbitrary binary trusted.
export const DERIVATION_BUILDS = Object.freeze({
  f1a6bb0e82be37fddf9e2485c50f78b4cd5eb02d43e903152230c91fd22dcfd9: 'combined-r1, base/base 5476069f, rustup 1.96.0; source/native tests passed',
});
export async function invokeDerivation({ executable, runtime = null, trusted, witness, workDir, signal,
  timeoutMs = 180000, maxWitnessBytes = 64 << 20, maxMemoryMiB = 1536, outputBytes = 65536 }) {
  if (!Buffer.isBuffer(witness) || witness.length === 0 || witness.length > maxWitnessBytes) throw Error('native witness size refused');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000 || !Number.isInteger(maxMemoryMiB) || maxMemoryMiB < 128 || maxMemoryMiB > 4096)
    throw Error('invalid native execution bounds');
  if (!Number.isInteger(outputBytes) || outputBytes < 1024 || outputBytes > (1 << 20)) throw Error('invalid native output bound');
  signal?.throwIfAborted();
  const directory = fs.mkdtempSync(path.join(workDir, 'proof-')); fs.chmodSync(directory, 0o700);
  const input = path.join(directory, 'trusted.json'), data = path.join(directory, 'witness');
  let child, timer;
  const abort = () => { if (child) void child.kill('native derivation aborted'); };
  try {
    fs.writeFileSync(input, JSON.stringify(trusted), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(data, witness, { flag: 'wx', mode: 0o600 });
    signal?.throwIfAborted();
    const command = nativeCommand(executable, [input, data], runtime);
    child = spawnOwned(command.executable, command.args, { cwd: directory, stdoutBytes: outputBytes,
      launcher: { file: '/usr/bin/prlimit', args: [`--as=${maxMemoryMiB * 1048576}`, `--cpu=${Math.ceil(timeoutMs / 1000) + 1}`, '--'] } });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => { void child.kill('native derivation deadline'); }, timeoutMs);
    const result = await child.done;
    signal?.throwIfAborted();
    if (result.reason) throw Error(result.reason);
    if (result.code !== 0) {
      let diagnostic = result.stderr.slice(-500);
      try { const refusal = JSON.parse(result.output).refused; if (typeof refusal === 'string') diagnostic = refusal.slice(0, 500); } catch {}
      throw Error(`native derivation refused (${result.code}): ${diagnostic}`);
    }
    let parsed; try { parsed = JSON.parse(result.output); } catch { throw Error('native derivation did not return one JSON result'); }
    if (parsed?.refused) throw Error('native derivation refused the witness');
    return parsed;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (child && !child.exited) { await child.kill(); await child.done; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
