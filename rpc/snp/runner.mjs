// Holds the EnclaveDeployments lease for the SEV-SNP RPC app on this host.
//
//   node rpc/snp/runner.mjs CONFIG.json            run: register, claim, renew until stopped
//   node rpc/snp/runner.mjs CONFIG.json --status   print the registry entry and deployment state
//
// CONFIG: {"keyFile": hot operator key (0x hex, mode 0600), "rpcs": [two or more Base RPCs],
//          "registry", "ledger", "endpoint", "repo", "measurement": 96 hex (SNP launch measurement),
//          "deployment": 0x id or null until the owner creates it}
// The operator key only registers this host and claims/renews; it never holds or moves funds
// beyond gas. With the owner's wallet declared as this entry's payout wallet
// (EnclaveRegistry.setPayoutWallet, signed by the owner), the ledger charges the owner's own
// deployment nothing (EnclaveDeployments._hostRate), so the lease needs no balance.
// Registry.measurement is bytes32, so it records sha256(SNP measurement); the 48-byte value is
// pinned in the catalog version config. The proof key is this operator's own address: with a
// zero rate there is no proof-of-time payment to claim.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createPublicClient, createWalletClient, fallback, http, keccak256, toBytes } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const REGISTRY_ABI = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [
    { name: 'endpoint', type: 'string' }, { name: 'repo', type: 'string' }, { name: 'measurement', type: 'bytes32' },
    { name: 'cpuPricePerSec6', type: 'uint64' }, { name: 'gpuPricePerSec6', type: 'uint64' }, { name: 'proofKey', type: 'address' }],
    outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'get', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
    { name: 'endpoint', type: 'string' }, { name: 'repo', type: 'string' }, { name: 'measurement', type: 'bytes32' },
    { name: 'operator', type: 'address' }, { name: 'registeredAt', type: 'uint64' }, { name: 'lastSeen', type: 'uint64' },
    { name: 'active', type: 'bool' }, { name: 'cpuPricePerSec6', type: 'uint64' }, { name: 'gpuPricePerSec6', type: 'uint64' },
    { name: 'proofKey', type: 'address' }, { name: 'payoutWallet', type: 'address' }] }] },
    // ^ the deployed registry's get() (Base 0x868e…ccac) returns these 11 fields; the source ABI adds caps/region.
];
const LEDGER_ABI = [
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'enclaveId', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'renew', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'rateFor', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'enclaveId', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'get', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
    { name: 'id', type: 'bytes32' }, { name: 'owner', type: 'address' }, { name: 'appRef', type: 'string' }, { name: 'ports', type: 'string' },
    { name: 'configCid', type: 'string' }, { name: 'gpuMilli', type: 'uint16' }, { name: 'cpuMilli', type: 'uint16' },
    { name: 'appPort', type: 'uint32' }, { name: 'isPublic', type: 'bool' }, { name: 'active', type: 'bool' },
    { name: 'createdAt', type: 'uint64' }, { name: 'rate', type: 'uint256' }, { name: 'balance6', type: 'uint256' },
    { name: 'spent6', type: 'uint256' }, { name: 'runner', type: 'bytes32' }, { name: 'runnerOperator', type: 'address' },
    { name: 'leaseUntil', type: 'uint64' }] }] },
];
const RENEW_BEFORE = 600;     // renew when under 10 minutes of the 30-minute lease remain
const TICK_MS = 60_000;

const log = (event, more = {}) => console.log(JSON.stringify({ event, at: new Date().toISOString(), ...more }));

export function enclaveIdOf(endpoint) { return keccak256(toBytes(endpoint)); }
export function registryMeasurement(hex96) {
  if (!/^[0-9a-f]{96}$/.test(hex96)) throw new Error('measurement must be 96 hex chars');
  return '0x' + crypto.createHash('sha256').update(Buffer.from(hex96, 'hex')).digest('hex');
}

function clients(c) {
  const key = fs.readFileSync(c.keyFile, 'utf8').trim();
  if ((fs.statSync(c.keyFile).mode & 0o077) !== 0) throw new Error('operator key file must not be group/world readable');
  const account = privateKeyToAccount(key);
  const transport = fallback(c.rpcs.map((u) => http(u, { timeout: 20_000 })));
  return { account, pub: createPublicClient({ chain: base, transport }),
    wallet: createWalletClient({ account, chain: base, transport }) };
}

async function send(pub, wallet, req, what) {
  await pub.simulateContract({ ...req, account: wallet.account });   // refuse before spending gas on a revert
  const hash = await wallet.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  log(what, { tx: hash, status: r.status, block: Number(r.blockNumber) });
  if (r.status !== 'success') throw new Error(what + ' reverted');
}

async function ensureRegistered(c, pub, wallet, enclaveId) {
  const e = await pub.readContract({ address: c.registry, abi: REGISTRY_ABI, functionName: 'get', args: [enclaveId] });
  const want = registryMeasurement(c.measurement);
  if (e.operator.toLowerCase() === wallet.account.address.toLowerCase() && e.active && e.measurement === want
      && e.repo === c.repo && e.cpuPricePerSec6 > 0n && e.proofKey !== '0x0000000000000000000000000000000000000000') return e;
  await send(pub, wallet, { address: c.registry, abi: REGISTRY_ABI, functionName: 'register',
    args: [c.endpoint, c.repo, want, 1n, 0n, wallet.account.address] }, 'registered');
  return pub.readContract({ address: c.registry, abi: REGISTRY_ABI, functionName: 'get', args: [enclaveId] });
}

async function tick(c, pub, wallet, enclaveId) {
  const deployment = JSON.parse(fs.readFileSync(c.configPath, 'utf8')).deployment;   // set once the owner creates it
  if (!deployment) return log('waiting-for-deployment');
  const d = await pub.readContract({ address: c.ledger, abi: LEDGER_ABI, functionName: 'get', args: [deployment] });
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (!d.active) return log('deployment-inactive', { deployment });
  if (d.runner === enclaveId && d.runnerOperator.toLowerCase() === wallet.account.address.toLowerCase() && d.leaseUntil >= now) {
    if (d.leaseUntil - now > BigInt(RENEW_BEFORE)) return log('leased', { deployment, leaseUntil: Number(d.leaseUntil) });
    return send(pub, wallet, { address: c.ledger, abi: LEDGER_ABI, functionName: 'renew', args: [deployment] }, 'renewed');
  }
  if (d.leaseUntil >= now) return log('leased-by-other', { deployment, runner: d.runner });
  const rate = await pub.readContract({ address: c.ledger, abi: LEDGER_ABI, functionName: 'rateFor', args: [deployment, enclaveId] });
  if (rate !== 0n) return log('not-free', { deployment, rate: String(rate), why: 'owner has not declared this entry its payout wallet' });
  return send(pub, wallet, { address: c.ledger, abi: LEDGER_ABI, functionName: 'claim', args: [deployment, enclaveId] }, 'claimed');
}

async function main(configPath, flag) {
  const c = { ...JSON.parse(fs.readFileSync(configPath, 'utf8')), configPath };
  if (!Array.isArray(c.rpcs) || c.rpcs.length < 2) throw new Error('need at least two Base RPCs');
  const { pub, wallet } = clients(c);
  const enclaveId = enclaveIdOf(c.endpoint);
  if (flag === '--status') {
    const e = await pub.readContract({ address: c.registry, abi: REGISTRY_ABI, functionName: 'get', args: [enclaveId] });
    const bal = await pub.getBalance({ address: wallet.account.address });
    console.log(JSON.stringify({ operator: wallet.account.address, balanceWei: String(bal), enclaveId,
      entry: e, measurement32: registryMeasurement(c.measurement) }, (k, v) => typeof v === 'bigint' ? String(v) : v, 1));
    return;
  }
  let stop = false;
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { stop = true; });
  await ensureRegistered(c, pub, wallet, enclaveId);
  log('runner-ready', { operator: wallet.account.address, enclaveId });
  while (!stop) {
    try { await tick(c, pub, wallet, enclaveId); } catch (e) { log('tick-error', { error: String(e.shortMessage || e.message).slice(0, 300) }); }
    for (let waited = 0; waited < TICK_MS && !stop; waited += 1000) await new Promise((r) => setTimeout(r, 1000));
  }
  log('runner-stopped');
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv[2], process.argv[3]).catch((e) => { log('fatal', { error: e.message }); process.exit(1); });
