// PHASE 3 (ROOT EXECUTES, read-only, minutes before activate.py): node work/custody-recipient-activation-20261023/preflight.mjs
// The reviewed linux-lease-root-release/live-preflight.mjs logic (quorum-verified lease authority, each app's ledger row,
// reserve, renew budget and runner's registry entry), with two corrections: the lease modules are imported from the restore
// repo at a6b1378c and asserted byte-equal to PRODUCTION's release (~/enclave-prod/metal-deabf8f90), not work/enclave's
// (whose lease-gas-owner/lease-executor-client differ); the apps are the explicit two ids, not a funding-proposal slice.
// Output: a NEW file evidence/lease-preflight.json (plus a timestamped copy). Reads public chain state only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../custody-recipient-restore-20261023/repo'), PROD = '/home/steven/enclave-prod/metal-deabf8f90';
const MODS = ['client/lease-executor-authority.mjs', 'network/lease-gas-owner.mjs', 'client/lease-executor-client.mjs'];
const h = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
for (const m of MODS) if (h(path.join(REPO, m)) !== h(path.join(PROD, m))) throw new Error(`${m} differs from the production release`);
const imp = (m) => import(pathToFileURL(path.join(REPO, m)).href);
const { createPublicClient, http } = await import(pathToFileURL(path.join(REPO, 'node_modules/viem/_esm/index.js')).href);
const { verifiedLeaseAuthority } = await imp(MODS[0]);
const { parseDeploymentRecord, LEDGER_ABI, OWNER_ABI, REGISTRY_ABI } = await imp(MODS[1]);
const { STATUS, KIND } = await imp(MODS[2]);
const IDS = ['0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9', '0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c'];
const deployment = parseDeploymentRecord(fs.readFileSync('/home/steven/enclave-prod/lease-gas/deployment.json'),
  { expectedDigest: 'sha256:1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089' });
const urls = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base-mainnet.public.blastapi.io'];
const clients = urls.map((url) => createPublicClient({ transport: http(url, { timeout: 12000, retryCount: 0 }) }));
const a = await verifiedLeaseAuthority({ clients, deployment, quorum: 2 });
const rows = [];
for (const id of IDS) {
  const dep = await a.client.readContract({ address: a.pins.ledger, abi: LEDGER_ABI, functionName: 'get', args: [id] });
  const [reserve, renew, host] = await Promise.all([
    a.client.readContract({ address: a.pins.reserve, abi: OWNER_ABI, functionName: 'reserveOf', args: [id, dep.owner] }),
    a.client.readContract({ address: a.pins.reserve, abi: OWNER_ABI, functionName: 'statusOf', args: [id, KIND.renew, dep.runner, dep.runnerOperator] }),
    a.client.readContract({ address: a.pins.registry, abi: REGISTRY_ABI, functionName: 'get', args: [dep.runner] })]);
  rows.push({ id, owner: dep.owner, active: dep.active, runner: dep.runner, runnerOperator: dep.runnerOperator, leaseUntil: dep.leaseUntil,
    leaseRemainingSeconds: dep.leaseUntil - a.block.timestamp, reserve, renewStatus: STATUS[Number(renew[0])],
    renewBudget: { availableWei: renew[1], epochLeftWei: renew[2], maxPerOpWei: renew[3] }, hostActive: host.active, hostOperator: host.operator });
}
const data = { at: new Date().toISOString(), readOnly: true, modules: Object.fromEntries(MODS.map((m) => [m, h(path.join(REPO, m))])),
  quorum: a.quorum, agreeing: a.agreeing, block: a.block, rows };
const text = JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n';
fs.mkdirSync(path.join(HERE, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'evidence', `lease-preflight-${data.at.replace(/[:.]/g, '')}.json`), text);
fs.writeFileSync(path.join(HERE, 'evidence', 'lease-preflight.json'), text);
console.log(JSON.stringify({ at: data.at, block: String(a.block.number), agreeing: a.agreeing,
  rows: rows.map((r) => ({ id: r.id.slice(0, 10), leaseRemainingSeconds: String(r.leaseRemainingSeconds), enabled: r.reserve.enabled,
    balanceWei: String(r.reserve.balanceWei), renewStatus: r.renewStatus, hostActive: r.hostActive })) }));
