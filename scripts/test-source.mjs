// One explicit split between checkout-local tests and native RPC qualification.
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rpcQualificationFiles } from '../test/helpers/rpc-qualification-files.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const qualify = args[0] === '--rpc-qualification';
const storage = args[0] === '--storage-qualification';
if (qualify || storage) args.shift();
const external = new Set(rpcQualificationFiles.map(f => `test/${f}`));
for (const f of external) if (!existsSync(f)) throw Error(`Missing qualification source: ${f}`);
let files;
if (storage) {
  if (!process.env.STORAGE_PACKAGE_TARBALL || !existsSync(process.env.STORAGE_PACKAGE_TARBALL))
    throw Error('Storage qualification requires STORAGE_PACKAGE_TARBALL: the reviewed PostgreSQL/indexd package');
  files = ['test/storage-indexer-host.test.mjs'];
} else if (qualify) {
  const routes = readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
  if (routes.length) throw Error('RPC qualification requires an offline network namespace: unshare -r -n');
  for (const name of ['HELIOS_BIN', 'HELIOS_BASE_BIN', 'HELIOS_COMPAT_BIN', 'OPSTACK_SERVER_BIN', 'WITNESS_CHECK_BIN', 'BASE_HEADS_DIR', 'BASE_FIXTURE_DIR']) {
    if (!process.env[name] || !existsSync(process.env[name])) throw Error(`RPC qualification requires ${name} pointing to its pinned input`);
  }
  if (!existsSync('artifacts/enclave-base-head-listener')) throw Error('RPC qualification requires the pinned native head listener');
  files = [...external];
} else {
  files = ['test', 'test/wallet-release', 'network/test'].flatMap(dir =>
    readdirSync(dir).filter(f => f.endsWith('.test.mjs')).map(f => `${dir}/${f}`)).filter(f => !external.has(f) && f !== 'test/storage-indexer-host.test.mjs').sort();
  console.error(`Running ${files.length} source test files; ${external.size} native RPC qualification files plus storage-indexer-host (test:storage-qualification) are outside this run. RPC files require npm run test:rpc-qualification (not covered by this run).`);
}
const result = spawnSync(process.execPath, ['--test', storage ? '--test-timeout=900000' : '--test-timeout=600000', '--test-concurrency=2', ...args, ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
