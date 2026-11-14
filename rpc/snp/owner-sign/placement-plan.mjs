// Write PLAN.json for owner-sign/server.mjs: one transaction from the owner's wallet that pins a deployment to one
// host, or lifts the pin.
//
//   node rpc/snp/owner-sign/placement-plan.mjs OWNER DEPLOYMENT_ID HOST_ID|none JOURNAL OUT_PLAN.json
//
// The option is not an argument: it is the one the ledger holds, changed only in its placement key
// (EnclaveDeployments.setConfig). HOST_ID must be an active host in the registry. A pinned deployment is refused by
// every other host; the host that runs it stops it and releases its lease when it next renews, and the pinned host
// claims it. While the pinned host is away the deployment is down: nothing else takes it. `none` lifts the pin.
// For a deployment the owner holds directly. One held by the owner's session vault moves with SessionVault.promote.
// The plan is written only if every RPC simulates the call from the owner and then reads the new option.
import fs from 'node:fs';
import { createPublicClient, decodeFunctionResult, encodeFunctionData, fallback, getAddress, http } from 'viem';
import { base } from 'viem/chains';
import { LEDGER_ABI } from './abi.mjs';
import { placedOption } from './placement.mjs';

const LEDGER = '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b';
const REGISTRY = '0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac';
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const REG_GET = [{ type: 'function', name: 'get', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: [
  { name: 'endpoint', type: 'string' }, { name: 'repo', type: 'string' }, { name: 'measurement', type: 'bytes32' },
  { name: 'operator', type: 'address' }, { name: 'registeredAt', type: 'uint64' }, { name: 'lastSeen', type: 'uint64' },
  { name: 'active', type: 'bool' }, { name: 'cpuPricePerSec6', type: 'uint64' }, { name: 'gpuPricePerSec6', type: 'uint64' },
  { name: 'proofKey', type: 'address' }, { name: 'payoutWallet', type: 'address' }] }] }];

const [ownerArg, deployment, hostArg, journal, outPath] = process.argv.slice(2);
if (!/^0x[0-9a-f]{64}$/.test(deployment || '') || !/^(none|0x[0-9a-f]{64})$/.test(hostArg || '') || !journal || !outPath) throw new Error('usage: placement-plan.mjs OWNER DEPLOYMENT_ID HOST_ID|none JOURNAL OUT_PLAN.json');
const owner = getAddress(ownerArg), hostId = hostArg === 'none' ? null : hostArg;
const pub = createPublicClient({ chain: base, transport: fallback(RPCS.map((u) => http(u, { timeout: 15000 }))) });

const d = await pub.readContract({ address: LEDGER, abi: LEDGER_ABI, functionName: 'get', args: [deployment] });
if (getAddress(d.owner) !== owner) throw new Error(`the deployment is held by ${d.owner}, not by this owner`);
const newOption = placedOption(d.configCid, hostId);
if (newOption === d.configCid) throw new Error('the deployment’s option already says this');
if (Buffer.byteLength(newOption) > 4096) throw new Error('the option would be over 4096 bytes');
let host = null;
if (hostId) {
  host = await pub.readContract({ address: REGISTRY, abi: REG_GET, functionName: 'get', args: [hostId] });
  if (/^0x0+$/.test(host.operator) || !host.active) throw new Error('the registry has no active host under this id');
}

const data = encodeFunctionData({ abi: LEDGER_ABI, functionName: 'setConfig', args: [deployment, newOption] });
const getData = encodeFunctionData({ abi: LEDGER_ABI, functionName: 'get', args: [deployment] });
for (const url of RPCS) {
  const one = createPublicClient({ chain: base, transport: http(url, { timeout: 15000 }) });
  const [{ calls: out }] = await one.request({ method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [{ from: owner, to: LEDGER, data }, { from: owner, to: LEDGER, data: getData }] }] }, 'latest'] });
  if (out.length !== 2 || out.some((c) => c.status !== '0x1')) throw new Error(`${new URL(url).host}: the simulation would revert`);
  const after = decodeFunctionResult({ abi: LEDGER_ABI, functionName: 'get', data: out[1].returnData });
  if (after.configCid !== newOption || after.appRef !== d.appRef || after.active !== d.active) throw new Error(`${new URL(url).host}: the deployment would not end on the new option alone`);
}

const hostName = host ? host.endpoint.replace(/^.*\//, '') : null, short = deployment.slice(0, 10) + '…' + deployment.slice(-4);
const plan = {
  kind: 'placement', title: hostId ? `Pin deployment ${short} to ${hostName}` : `Lift the host pin of deployment ${short}`,
  lead: 'One transaction from your wallet on Base. Check the details on the Trezor screen before confirming. This page never signs or sends anything by itself.',
  chainId: 8453, owner, rpcs: RPCS, journal,
  status: { ledger: LEDGER, deployment, hostId, oldOption: d.configCid, newOption },
  steps: [{
    id: 'place', title: hostId ? `Pin the deployment to ${hostName}` : 'Lift the pin',
    why: hostId ? 'Writes the host into the deployment’s option. Every other host then refuses it. The host that runs it now stops it and releases its lease when it next renews, within one lease period, and the pinned host claims it. While the pinned host is away the deployment is down, because no other host takes it. To undo, lift the pin with a plan for `none`.'
      : 'Removes the host from the deployment’s option, so any host that passes the funding and hosting policy may claim it. Nothing is stopped by this.',
    to: LEDGER, data, value: '0x0', valueEth: '0',
    show: { Deployment: deployment, 'App ref': d.appRef, ...(hostId ? { Host: host.endpoint, 'Host id': hostId } : {}), 'Option now': d.configCid || '(empty)', 'Option after': newOption, Call: 'setConfig(deployment, option)' },
  }],
};
fs.writeFileSync(outPath, JSON.stringify(plan, null, 1) + '\n');
console.log(JSON.stringify({ wrote: outPath, deployment, appRef: d.appRef, host: hostName, hostId, oldOption: d.configCid, newOption,
  runner: d.runner, leaseUntil: new Date(Number(d.leaseUntil) * 1000).toISOString() }));
