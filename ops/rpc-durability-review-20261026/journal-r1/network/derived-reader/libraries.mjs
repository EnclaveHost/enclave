// Optional explicit loader for accepted images with an older glibc. The
// allowlist is shared with the existing RPC runtime; configuration cannot add
// library digests. The image's other tools/Node still belong to its measured TCB.
import fs from 'node:fs';
import path from 'node:path';
import { PINNED_GLIBC_RUNTIMES } from '../rpc-runtime.mjs';
import { stageBinary } from './process.mjs';

export async function stageLibraries(config, directory) {
  if (config == null) return null;
  if (!config || Object.keys(config).sort().join(',') !== 'build,dir' || !path.isAbsolute(config.dir) ||
      !Object.hasOwn(PINNED_GLIBC_RUNTIMES, config.build)) throw Error('unreviewed native library closure');
  const pins = PINNED_GLIBC_RUNTIMES[config.build], dir = path.join(directory, 'libraries');
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const [name, digest] of Object.entries(pins))
    await stageBinary(path.join(config.dir, name), digest, dir, { [digest]: config.build }, name);
  return Object.freeze({ loader: path.join(dir, 'ld-linux-x86-64.so.2'), dir });
}
export function nativeCommand(executable, args, runtime) {
  return runtime ? { executable: runtime.loader, args: ['--inhibit-cache', '--library-path', runtime.dir, executable, ...args] }
    : { executable, args };
}
