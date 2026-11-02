// Write PLAN.json for owner-sign/server.mjs: the owner's transactions that release the SNP RPC
// image as a version of an existing catalog app and deploy it on this host.
//
//   node rpc/snp/owner-sign/plan.mjs RELEASE.json OUT_PLAN.json
//
// RELEASE.json: {"owner", "appId", "slug", "name", "description", "version", "cid", "res": [vram,gpuGf,memMb,cpuGf],
//   "ports", "config": {...version config, measurements under snp.measurements}, "runner": operator address,
//   "runnerFundWei", "enclaveId", "appPort", "journal"}
// Steps, in the order the page enables them:
//   fund    send runnerFundWei ETH to the runner (its gas for register/claim/renew)
//   publish EnclaveAppCatalog.publishVersion  (the owner is the catalog owner, so it is approved at once)
//   payout  EnclaveRegistry.setPayoutWallet(enclaveId)  (this host charges the owner's deployment 0)
//   create  EnclaveDeployments.create(catalog://appId/index, ...)  pinned to this host, fee 0
// publish and create are simulated from the owner's address against Base before the plan is written.
import fs from 'node:fs';
import { createPublicClient, encodeFunctionData, fallback, formatEther, http } from 'viem';
import { base } from 'viem/chains';

const CATALOG = '0x18419ca2b502d423a8de6269aeee171a378626e3';
const LEDGER = '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b';
const REGISTRY = '0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac';
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const ABI = [
  { type: 'function', name: 'publishVersion', stateMutability: 'nonpayable', inputs: [
    { name: 'slug', type: 'string' }, { name: 'name', type: 'string' }, { name: 'description', type: 'string' },
    { name: 'version', type: 'string' }, { name: 'cid', type: 'string' }, { name: 'res', type: 'uint32[4]' },
    { name: 'ports', type: 'string' }, { name: 'config', type: 'string' }, { name: 'feePerSec6', type: 'uint256' }],
    outputs: [{ type: 'bytes32' }, { type: 'uint256' }] },
  { type: 'function', name: 'numVersions', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'setPayoutWallet', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'create', stateMutability: 'nonpayable', inputs: [
    { name: 'appRef', type: 'string' }, { name: 'gpuMilli', type: 'uint16' }, { name: 'cpuMilli', type: 'uint16' },
    { name: 'appPort', type: 'uint32' }, { name: 'ports', type: 'string' }, { name: 'isPublic', type: 'bool' },
    { name: 'configCid', type: 'string' }, { name: 'feeRecipient', type: 'address' }, { name: 'feePerSec6', type: 'uint256' },
    { name: 'maxRate6', type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
];

const [releasePath, outPath] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
const pub = createPublicClient({ chain: base, transport: fallback(RPCS.map((u) => http(u, { timeout: 15000 }))) });
const index = Number(await pub.readContract({ address: CATALOG, abi: ABI, functionName: 'numVersions', args: [r.appId] }));
const config = JSON.stringify(r.config);
if (Buffer.byteLength(config) > 4096) throw new Error('version config over 4096 bytes');
const appRef = `catalog://${r.appId.toLowerCase()}/${index}`;
// Other runners refuse this deployment: it is pinned to this host, and older runners reject the unknown namespace.
const envelope = JSON.stringify({ placement: { hostId: r.enclaveId }, snpVm: { app: r.slug, measurementsFrom: appRef } });
const publishArgs = [r.slug, r.name, r.description, r.version, r.cid, r.res, r.ports, config, 0n];
const createArgs = [appRef, 0, 1000, r.appPort, r.ports, true, envelope, r.owner, 0n, 1n];

for (const [fn, args, to] of [['publishVersion', publishArgs, CATALOG]]) {
  await pub.simulateContract({ address: to, abi: ABI, functionName: fn, args, account: r.owner });
}
// create cannot be simulated against an appRef that does not exist yet; its checks are length/range only
// (EnclaveDeployments._validateCreate, _initFee recipient != 0, _initCap maxRate > fee), asserted here.
if (appRef.length > 100 || envelope.length > 4096 || r.ports.length > 96) throw new Error('create argument too long');

const step = (id, title, why, to, data, value, show) => ({ id, title, why, to, data, value: '0x' + BigInt(value).toString(16),
  valueEth: formatEther(BigInt(value)), show });
const plan = {
  chainId: 8453, owner: r.owner, rpcs: RPCS, journal: r.journal,
  status: { runner: r.runner, runnerMinWei: String(BigInt(r.runnerFundWei) / 2n), catalog: CATALOG, registry: REGISTRY,
    appId: r.appId, enclaveId: r.enclaveId, versionIndex: index },
  steps: [
    step('fund', 'Fund the host runner’s gas', 'The runner key on this workstation registers the host and claims and renews the 30-minute lease. It only ever pays gas.',
      r.runner, '0x', r.runnerFundWei, { Recipient: r.runner, Amount: formatEther(BigInt(r.runnerFundWei)) + ' ETH' }),
    step('publish', `Publish ${r.name} ${r.version}`, `Adds version ${index} to your existing app ${r.slug}. You own the catalog, so it is approved immediately. Its config pins the enclave measurement consumers will accept.`,
      CATALOG, encodeFunctionData({ abi: ABI, functionName: 'publishVersion', args: publishArgs }), 0,
      { App: r.appId, Slug: r.slug, Name: r.name, Version: r.version, 'Version index': String(index), CID: r.cid,
        Resources: r.res.join(', '), Ports: r.ports, 'Launch measurement': Object.values(r.config.snp.measurements).join(', '), 'Publisher fee': '0' }),
    step('payout', 'Declare yourself payout wallet of the host', 'With your wallet as this host’s payout wallet, the ledger charges your own deployment nothing on it.',
      REGISTRY, encodeFunctionData({ abi: ABI, functionName: 'setPayoutWallet', args: [r.enclaveId] }), 0,
      { 'Host (enclave id)': r.enclaveId, Operator: r.runner }),
    step('create', 'Create the production deployment', 'Your deployment of this version, pinned to this host, at zero fee. Its id becomes the enclave’s HOST_DATA, which consumers check.',
      LEDGER, encodeFunctionData({ abi: ABI, functionName: 'create', args: createArgs }), 0,
      { 'App ref': appRef, 'CPU share': '1000 / 1000', 'App port': String(r.appPort), Public: 'yes', 'Options': envelope,
        'Fee recipient': r.owner, 'Fee': '0', 'Max rate': '1 (micro-USDC/s; free on this host)' }),
  ],
};
fs.writeFileSync(outPath, JSON.stringify(plan, null, 1) + '\n');
console.log(JSON.stringify({ wrote: outPath, versionIndex: index, appRef, steps: plan.steps.map((s) => s.id) }));
