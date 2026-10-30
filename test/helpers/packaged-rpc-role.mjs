// Shared by the consumer E2Es: the PACKAGED public-rpc role (network/host-services/packages/public-rpc.*) run by
// network/host-services/runner.mjs for one test host, and the hash pins of the other workers' immutable consumer code and
// binaries those E2Es import or run. A pin that does not match FAILS the test (it is never skipped or relabelled).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { keccak256, toBytes } from 'viem';
import { runHostServices } from '../../network/host-services/runner.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PKG = path.join(REPO, 'network/host-services/packages');
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const packagePin = () => fs.existsSync(path.join(PKG, 'public-rpc.package.json')) ? 'sha256:' + sha(path.join(PKG, 'public-rpc.package.json')) : null;

/** Consumer code extracted by `git archive` from another worker's immutable commit into CONSUMERS/<dir>, with its
 *  <dir>.SHA256SUMS. `sums` is the pinned sha256 of that list; every listed file must match it. -> the directory. */
export function pinnedConsumer(dir, sums) {
  const root = path.resolve(process.env.CONSUMERS || path.join(REPO, '../consumers'));
  const list = path.join(root, `${dir}.SHA256SUMS`);
  if (sha(list) !== sums) throw new Error(`${dir}.SHA256SUMS is not the pinned list ${sums}`);
  for (const line of fs.readFileSync(list, 'utf8').trim().split('\n')) {
    const [want, rel] = line.split(/\s+/);
    if (sha(path.join(root, dir, rel)) !== want) throw new Error(`${dir}/${rel} does not match its pin`);
  }
  return path.join(root, dir);
}
/** A binary or fixture at `file` must hash to `want`. -> file */
export function pinnedFile(file, want) {
  if (!file || !fs.existsSync(file)) throw new Error(`missing pinned file ${file}`);
  if (sha(file) !== want) throw new Error(`${file} is not the pinned ${want}`);
  return file;
}

/** One host's packaged public-rpc role under the runner. config: the role's config without port/bind/hostId/chainId. */
export async function startPackagedRole(name, port, config) {
  const endpoint = `https://host-${name}.public-rpc-consumer.net`, dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', `prc-${name}-`));
  const hostId = keccak256(toBytes(endpoint)).toLowerCase();
  const cfg = { format: 'enclave-host-services/v1', host: { endpoint }, platformHostPolicy: 'production', packagesDir: PKG, stateRoot: dir,
    services: [{ role: 'public-rpc', package: packagePin(), heapMiB: 96, config: { port, bind: '127.0.0.1', hostId, chainId: 8453, ...config } }] };
  const logs = [];
  const running = await runHostServices(cfg, { gate: { check: async () => {}, start() {}, stop() {}, serviceRefusal: () => null, status: () => ({}) }, log: (x) => logs.push(x), intervalMs: 300 });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + '/health')).ok) break; } catch {} await new Promise((x) => setTimeout(x, 200)); }
  return { name, url, hostId, running, logs, stop: async () => { await running.stop().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); } };
}
