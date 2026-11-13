// Write PLAN.json for owner-sign/server.mjs: the owner's steps that give a deployment held by the owner's session
// vault a new version of its catalog app, where the vault is the app's publisher.
//
//   node rpc/snp/owner-sign/vault-version-plan.mjs RELEASE.json DEPLOYMENT_ID OUT_PLAN.json [VERSION_INDEX]
//
// RELEASE.json: {"owner", "version" (the new label), "cid", "component" (path of the .wasm the CID names),
//   "hostRelease" (sha256 of the image the host must load for this version), "hostMarker" (path of the record the
//   host switch writes), "journal"}. VERSION_INDEX: only when the version is already published (the plan is being
//   rewritten); it must then be this release on chain.
// The app's slug, name and description and the version's resources, ports and config are not arguments: they are
// read from the chain and repeated, so the new version differs from the one the deployment runs in its component
// and label only.
// Steps, in the order the page enables them:
//   upload   a message the wallet signs (enclave-upload:<sha256>:<expiry>); the server trades it for an upload token
//            and pins the component. Not a transaction.
//   publish  SessionVault.ownerCall(catalog, publishVersion(...))   the vault is the publisher; the version is Pending
//   approve  EnclaveAppCatalog.setApproval(appId, index, Approved)  the owner is the catalog owner
//   promote  SessionVault.promote(id, slug, vault, appRef, configCid, label, isPublic, 0, 0, "")  sent by the owner,
//            so no typed signature is needed; offered once the host loads the release
// The plan is written only if every RPC simulates publish, approve and promote in that order from the owner and
// then reads the deployment on the new version. To go back, promote the previous version the same way.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createPublicClient, decodeFunctionResult, encodeFunctionData, fallback, getAddress, http } from 'viem';
import { base } from 'viem/chains';
import { CATALOG_ABI, LEDGER_ABI, VAULT_ABI } from './abi.mjs';
import { promotedHash } from './vault-version.mjs';

const CATALOG = '0x18419ca2b502d423a8de6269aeee171a378626e3';
const LEDGER = '0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b';
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const TOKEN_URL = 'https://api.enclave.host/v1/apps/upload-token', UPLOAD_URL = 'https://ipfs.enclave.host/add-wasm';
// where the component must be readable: the upload gateway itself, and the gateway app the hosts fetch from
const GATEWAYS = ['https://ipfs.enclave.host', 'https://7ae476a3.app.enclave.host'];
const ENV_PROD = 2, APPROVED = 1, ZERO32 = '0x' + '0'.repeat(64);

const [releasePath, deployment, outPath, givenIndex] = process.argv.slice(2);
if (!/^0x[0-9a-f]{64}$/.test(deployment || '') || !outPath) throw new Error('usage: vault-version-plan.mjs RELEASE.json DEPLOYMENT_ID OUT_PLAN.json [VERSION_INDEX]');
const r = JSON.parse(fs.readFileSync(releasePath, 'utf8')), owner = getAddress(r.owner);
if (!/^[A-Za-z0-9]{10,100}$/.test(r.cid || '') || !/^[0-9a-f]{64}$/.test(r.hostRelease || '') || !r.version || !r.hostMarker || !r.journal) throw new Error('RELEASE.json is incomplete');
const component = fs.readFileSync(r.component), sha256 = crypto.createHash('sha256').update(component).digest('hex');
const pub = createPublicClient({ chain: base, transport: fallback(RPCS.map((u) => http(u, { timeout: 15000 }))) });
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

const d = await read(LEDGER, LEDGER_ABI, 'get', [deployment]), vault = getAddress(d.owner);
const ref = /^catalog:\/\/(0x[0-9a-f]{64})\/(\d+)$/.exec(d.appRef);
if (!ref) throw new Error(`the deployment runs ${d.appRef}: not a catalog version`);
const appId = ref[1], oldIndex = Number(ref[2]);
const [vaultOwner, held, catalogOwner, app, versions, prev] = await Promise.all([read(vault, VAULT_ABI, 'owner'), read(vault, VAULT_ABI, 'held', [deployment]),
  read(CATALOG, CATALOG_ABI, 'owner'), read(CATALOG, CATALOG_ABI, 'getApp', [appId]), read(CATALOG, CATALOG_ABI, 'numVersions', [appId]),
  read(CATALOG, CATALOG_ABI, 'getVersion', [appId, BigInt(oldIndex)])]);
if (getAddress(vaultOwner) !== owner) throw new Error('the deployment is not held by a vault of this owner');
if (held[0] !== ENV_PROD || held[1] !== promotedHash(d.appRef, d.configCid)) throw new Error('the vault does not hold the deployment as production on what it runs now');
if (getAddress(app.publisher) !== vault || !app.active) throw new Error('the vault is not the publisher of the app the deployment runs');
if (getAddress(catalogOwner) !== owner) throw new Error('the owner is not the catalog owner and could not approve the version');
if (prev.version === r.version || prev.cid === r.cid) throw new Error('the release is the version the deployment already runs');

const res = [prev.vramMb, prev.gpuGflops, prev.memMb, prev.cpuGflops];
const publishArgs = [app.slug, app.name, app.description, r.version, r.cid, res, prev.ports, prev.config, 0n];
let index = Number(versions);
if (givenIndex !== undefined) {
  index = Number(givenIndex);
  if (!Number.isInteger(index) || index <= oldIndex || index >= Number(versions)) throw new Error('VERSION_INDEX is not a later published version');
  const v = await read(CATALOG, CATALOG_ABI, 'getVersion', [appId, BigInt(index)]);
  if (v.cid !== r.cid || v.version !== r.version || v.config !== prev.config || v.ports !== prev.ports) throw new Error(`version ${index} on chain is not this release`);
}
const oldAppRef = d.appRef, newAppRef = `catalog://${appId}/${index}`;
const publishData = encodeFunctionData({ abi: VAULT_ABI, functionName: 'ownerCall', args: [CATALOG, encodeFunctionData({ abi: CATALOG_ABI, functionName: 'publishVersion', args: publishArgs })] });
const approveData = encodeFunctionData({ abi: CATALOG_ABI, functionName: 'setApproval', args: [appId, BigInt(index), APPROVED] });
const promoteData = encodeFunctionData({ abi: VAULT_ABI, functionName: 'promote', args: [deployment, app.slug, vault, newAppRef, d.configCid, r.version, d.isPublic, ZERO32, 0n, '0x'] });

// every RPC, from the owner, in order: (publish,) approve, promote, then the ledger's record
const getData = encodeFunctionData({ abi: LEDGER_ABI, functionName: 'get', args: [deployment] });
const calls = [...(givenIndex === undefined ? [{ to: vault, data: publishData }] : []), { to: CATALOG, data: approveData }, { to: vault, data: promoteData }, { to: LEDGER, data: getData }];
for (const url of RPCS) {
  const one = createPublicClient({ chain: base, transport: http(url, { timeout: 15000 }) });
  const [{ calls: out }] = await one.request({ method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: calls.map((c) => ({ from: owner, ...c })) }] }, 'latest'] });
  const failed = out.findIndex((c) => c.status !== '0x1');
  if (out.length !== calls.length || failed >= 0) throw new Error(`${new URL(url).host}: step ${failed + 1} of the simulation would revert`);
  const after = decodeFunctionResult({ abi: LEDGER_ABI, functionName: 'get', data: out.at(-1).returnData });
  if (after.appRef !== newAppRef || after.configCid !== d.configCid) throw new Error(`${new URL(url).host}: the deployment would not end on ${newAppRef}`);
}

const short = (h) => h.slice(0, 10) + '…' + h.slice(-4);
const step = (id, title, why, to, data, show) => ({ id, title, why, to, data, value: '0x0', valueEth: '0', show });
const plan = {
  kind: 'vault-version', title: `Move ${app.name} to ${r.version}`,
  lead: 'One message and three transactions from your owner wallet on Base. Check the details on the Trezor screen before confirming. This page never signs or sends anything by itself.',
  chainId: 8453, owner, rpcs: RPCS, journal: r.journal,
  status: { catalog: CATALOG, ledger: LEDGER, vault, appId, versionIndex: index, label: r.version, versionConfig: prev.config, ports: prev.ports, deployment,
    oldAppRef, newAppRef, configCid: d.configCid, hostRelease: r.hostRelease, hostMarker: r.hostMarker,
    upload: { file: r.component, sha256, cid: r.cid, tokenUrl: TOKEN_URL, uploadUrl: UPLOAD_URL, gateways: GATEWAYS } },
  steps: [
    { ...step('upload', `Upload the ${r.version} component`, 'Your wallet signs a short message, not a transaction: it authorizes pinning exactly this file, for ten minutes. This computer then uploads the file and checks that the gateway stored it under the CID the next steps name. Nothing running changes.',
      null, '0x', { File: r.component, Bytes: String(component.length), 'SHA-256': sha256, CID: r.cid, Message: `enclave-upload:${sha256}:<a time within ten minutes>`,
        'Sent to': `${new URL(TOKEN_URL).host} (the signature), ${new URL(UPLOAD_URL).host} (the file)` }), upload: { sha256 } },
    step('publish', `Publish ${app.name} ${r.version}`, `Adds version ${index} to the app ${app.slug}. Your vault is the app’s publisher, so the transaction goes to the vault, which calls the catalog. The version starts unapproved. Nothing running changes.`,
      vault, publishData, { Vault: vault, Call: 'ownerCall(catalog, publishVersion(…))', Catalog: CATALOG, App: appId, Slug: app.slug, Version: r.version, 'Version index': String(index), CID: r.cid,
        Resources: res.join(', ') + ' (as version ' + oldIndex + ')', Ports: prev.ports, Config: prev.config, 'Publisher fee': '0' }),
    step('approve', `Approve version ${index}`, 'You own the catalog. Hosts run only approved versions. Nothing running changes.',
      CATALOG, approveData, { App: appId, 'Version index': String(index), Call: 'setApproval(app, index, Approved)' }),
    step('promote', `Move the deployment to ${r.version}`, `Points the deployment at version ${index} and records that you approved exactly that for production; without that record its secrets are not released. Offered once the host loads the release this version needs. The host then replaces what the deployment runs. To go back, promote ${prev.version} (${oldAppRef}) the same way.`,
      vault, promoteData, { Vault: vault, Deployment: deployment, App: `${app.slug}, published by ${short(vault)}`, 'App ref': newAppRef, Was: oldAppRef, Version: r.version,
        Option: d.configCid, Public: String(d.isPublic), Call: 'promote(…), sent by the vault’s owner: no typed signature' }),
  ],
};
fs.writeFileSync(outPath, JSON.stringify(plan, null, 1) + '\n');
console.log(JSON.stringify({ wrote: outPath, vault, appId, versionIndex: index, oldAppRef, newAppRef, isPublic: d.isPublic, component: { bytes: component.length, sha256, cid: r.cid }, steps: plan.steps.map((s) => s.id) }));
