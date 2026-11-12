// Write PLAN.json for owner-sign/server.mjs: the owner's transactions that move a running whole-VM deployment
// (deployment option snpVm) to a new version of its catalog app.
//
//   node rpc/snp/owner-sign/upgrade-plan.mjs RELEASE.json DEPLOYMENT_ID MANAGER_CONFIG OUT_PLAN.json [VERSION_INDEX]
//
// RELEASE.json: as for plan.mjs ({"owner", "appId", "slug", "name", "description", "version", "cid", "res", "ports",
//   "config", "journal"}). MANAGER_CONFIG: the host's vm-manager config; the page offers the stop only once its
//   binding for the deployment names the image this version measures. VERSION_INDEX: only when the version is already
//   published (the plan is being rewritten); it must then be this release on chain.
// Steps, in the order the page enables them:
//   publish EnclaveAppCatalog.publishVersion  (the owner is the catalog owner, so it is approved at once)
//   stop    EnclaveDeployments.setActive(id, false)  the host shuts the VM down and releases its lease
//   start   EnclaveDeployments.multicall([setAppRef(new), setConfig(snpVm.measurementsFrom = new), setActive(true)])
// A host launches a whole VM only on a fresh claim whose option names the version's measurements, and its in-place
// version switch is the container one. So the version changes while the deployment is stopped and unleased, in one
// transaction with its option, and the next claim launches the new image. Until the start is signed the deployment
// can go back as it was with setActive(id, true) alone.
import fs from 'node:fs';
import { createPublicClient, encodeFunctionData, fallback, http } from 'viem';
import { base } from 'viem/chains';
import { CATALOG_ABI, LEDGER_ABI } from './abi.mjs';

const CATALOG = '0x18419ca2b502d423a8de6269aeee171a378626e3';
const LEDGER = '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b';
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];

const [releasePath, deployment, managerConfig, outPath, givenIndex] = process.argv.slice(2);
if (!/^0x[0-9a-f]{64}$/.test(deployment || '') || !outPath) throw new Error('usage: upgrade-plan.mjs RELEASE.json DEPLOYMENT_ID MANAGER_CONFIG OUT_PLAN.json [VERSION_INDEX]');
const r = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
const pub = createPublicClient({ chain: base, transport: fallback(RPCS.map((u) => http(u, { timeout: 15000 }))) });
const read = (address, abi, functionName, args) => pub.readContract({ address, abi, functionName, args });
const config = JSON.stringify(r.config);
if (Buffer.byteLength(config) > 4096) throw new Error('version config over 4096 bytes');
if (r.config.runtime !== 'sev-snp-vm' || !/^[0-9a-f]{64}$/.test(r.config.image?.rootHash || '')) throw new Error('not a whole-VM release');

const [versions, d, catalogOwner] = await Promise.all([read(CATALOG, CATALOG_ABI, 'numVersions', [r.appId]),
  read(LEDGER, LEDGER_ABI, 'get', [deployment]), read(CATALOG, CATALOG_ABI, 'owner', [])]);
if (d.owner.toLowerCase() !== r.owner.toLowerCase()) throw new Error('the release owner does not own the deployment');
if (catalogOwner.toLowerCase() !== r.owner.toLowerCase()) throw new Error('the owner is not the catalog owner: the version would wait for approval');
const publishArgs = [r.slug, r.name, r.description, r.version, r.cid, r.res, r.ports, config, 0n];
let index = Number(versions);
if (givenIndex !== undefined) {
  index = Number(givenIndex);
  if (!Number.isInteger(index) || index < 0 || index >= Number(versions)) throw new Error('VERSION_INDEX is not a published version');
  const v = await read(CATALOG, CATALOG_ABI, 'getVersion', [r.appId, BigInt(index)]);
  if (v.cid !== r.cid || v.config !== config || v.version !== r.version) throw new Error(`version ${index} on chain is not this release`);
} else await pub.simulateContract({ address: CATALOG, abi: CATALOG_ABI, functionName: 'publishVersion', args: publishArgs, account: r.owner });

const prefix = `catalog://${r.appId.toLowerCase()}/`;
const oldAppRef = d.appRef, newAppRef = prefix + index;
if (!oldAppRef.startsWith(prefix) || oldAppRef === newAppRef) throw new Error(`the deployment runs ${oldAppRef}: not an earlier version of this app`);
const option = JSON.parse(d.configCid);
if (option.snpVm?.measurementsFrom !== oldAppRef) throw new Error('the deployment is not a whole-VM lease of its current version');
option.snpVm.measurementsFrom = newAppRef;
const envelope = JSON.stringify(option);
if (envelope !== d.configCid.split(oldAppRef).join(newAppRef)) throw new Error('the deployment option is not canonical JSON; refusing to rewrite it');
if (d.ports !== r.ports) throw new Error(`the deployment opens ${d.ports}, the release ${r.ports}`);

const call = (functionName, args) => encodeFunctionData({ abi: LEDGER_ABI, functionName, args });
const stopData = call('setActive', [deployment, false]);
const startData = call('multicall', [[call('setAppRef', [deployment, newAppRef]), call('setConfig', [deployment, envelope]), call('setActive', [deployment, true])]]);
for (const data of [stopData, startData]) await pub.call({ account: r.owner, to: LEDGER, data });

const step = (id, title, why, to, data, show) => ({ id, title, why, to, data, value: '0x0', valueEth: '0', show });
const measurement = Object.values(r.config.snp.measurements).join(', ');
const plan = {
  kind: 'upgrade', title: `Move ${r.name} to ${r.version}`,
  lead: 'Each step is one transaction from your owner wallet on Base. Check the details on the Trezor screen before confirming. This page never signs or sends anything by itself. Between the stop and the new VM answering, the app is down.',
  chainId: 8453, owner: r.owner, rpcs: RPCS, journal: r.journal,
  status: { catalog: CATALOG, ledger: LEDGER, appId: r.appId, versionIndex: index, cid: r.cid, versionConfig: config, deployment,
    oldAppRef, newAppRef, imageRootHash: r.config.image.rootHash, managerConfig },
  steps: [
    step('publish', `Publish ${r.name} ${r.version}`, `Adds version ${index} to your existing app ${r.slug}. You own the catalog, so it is approved immediately. Nothing running changes.`,
      CATALOG, encodeFunctionData({ abi: CATALOG_ABI, functionName: 'publishVersion', args: publishArgs }),
      { App: r.appId, Slug: r.slug, Name: r.name, Version: r.version, 'Version index': String(index), CID: r.cid,
        Resources: r.res.join(', '), Ports: r.ports, 'Launch measurement': measurement, 'Image root hash': r.config.image.rootHash,
        'Browser address': r.config.endpoints?.web ? 'yes: the VM asks its host for a certificate for its app name' : 'none', 'Publisher fee': '0' }),
    step('stop', 'Stop the running deployment', `Switches the deployment off. Its host shuts the VM down cleanly and releases the lease. The page offers this only once the host is set up to launch the new image. To go back instead of forward, switch it on again (setActive true) without the next step.`,
      LEDGER, stopData, { Deployment: deployment, Running: oldAppRef, Call: 'setActive(deployment, false)' }),
    step('start', `Start it as ${r.version}`, 'One transaction: point the deployment at the new version, name that version’s measurements in its option, and switch it on. Its host then claims it and launches the new image. Offered once the old lease is released.',
      LEDGER, startData, { Deployment: deployment, 'App ref': newAppRef, Option: envelope, Call: 'multicall([setAppRef, setConfig, setActive(true)])' }),
  ],
};
fs.writeFileSync(outPath, JSON.stringify(plan, null, 1) + '\n');
console.log(JSON.stringify({ wrote: outPath, versionIndex: index, oldAppRef, newAppRef, steps: plan.steps.map((s) => s.id) }));
