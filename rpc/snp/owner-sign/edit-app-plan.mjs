// Write PLAN.json for owner-sign/server.mjs: one transaction from the publisher's wallet that changes the name and
// description the catalog shows for an app.
//
//   node rpc/snp/owner-sign/edit-app-plan.mjs OWNER APP_ID TEXT.json JOURNAL OUT_PLAN.json
//
// TEXT.json: {"description", "name"?}; a release.json of rpc/snp/release.py serves. Without "name" the app keeps its
// name. The slug is not an argument: it is the one the catalog records for APP_ID.
// editApp is display only: no version is published and nothing running changes.
// The plan is written only if OWNER is the app's publisher, the text differs from what the catalog holds, and every
// RPC simulates the call from OWNER and then reads the app back with exactly the new text.
import fs from 'node:fs';
import { createPublicClient, decodeFunctionResult, encodeFunctionData, getAddress, http } from 'viem';
import { base } from 'viem/chains';
import { CATALOG_ABI } from './abi.mjs';
import { checkedText } from './edit-app.mjs';

const CATALOG = '0x18419ca2b502d423a8de6269aeee171a378626e3';
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];

const [ownerArg, appId, textPath, journal, outPath] = process.argv.slice(2);
if (!/^0x[0-9a-f]{64}$/.test(appId || '') || !journal || !outPath) throw new Error('usage: edit-app-plan.mjs OWNER APP_ID TEXT.json JOURNAL OUT_PLAN.json');
const owner = getAddress(ownerArg), text = JSON.parse(fs.readFileSync(textPath, 'utf8'));
const clients = RPCS.map((url) => createPublicClient({ chain: base, transport: http(url, { timeout: 15000 }) }));

const app = await clients[0].readContract({ address: CATALOG, abi: CATALOG_ABI, functionName: 'getApp', args: [appId] });
if (/^0x0+$/.test(app.publisher)) throw new Error('the catalog has no app under this id');
if (getAddress(app.publisher) !== owner) throw new Error('the owner is not the app’s publisher; only the publisher may edit it');
const { name, description } = checkedText(text.name ?? app.name, text.description);
if (name === app.name && description === app.description) throw new Error('the catalog already shows this name and description');

const data = encodeFunctionData({ abi: CATALOG_ABI, functionName: 'editApp', args: [app.slug, name, description] });
const getData = encodeFunctionData({ abi: CATALOG_ABI, functionName: 'getApp', args: [appId] });
for (const [i, one] of clients.entries()) {
  const host = new URL(RPCS[i]).host;
  const [{ calls: out }] = await one.request({ method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [{ from: owner, to: CATALOG, data }, { from: owner, to: CATALOG, data: getData }] }] }, 'latest'] });
  if (out.length !== 2 || out.some((c) => c.status !== '0x1')) throw new Error(`${host}: the simulation would revert`);
  const after = decodeFunctionResult({ abi: CATALOG_ABI, functionName: 'getApp', data: out[1].returnData });
  if (after.name !== name || after.description !== description || after.versionCount !== app.versionCount || after.active !== app.active) throw new Error(`${host}: the app would not end on the new text alone`);
}

const plan = {
  kind: 'edit-app', title: `Change what the catalog shows for ${app.name}`,
  lead: 'One transaction from your wallet on Base. Check the details on the Trezor screen before confirming. This page never signs or sends anything by itself.',
  chainId: 8453, owner, rpcs: RPCS, journal,
  status: { catalog: CATALOG, appId, oldName: app.name, oldDescription: app.description, newName: name, newDescription: description },
  steps: [{
    id: 'edit', title: name === app.name ? `Replace the description of ${app.name}` : `Rename ${app.name} to ${name} and replace its description`,
    why: 'Changes only the text the catalog shows. No version is published and nothing running changes or restarts.',
    to: CATALOG, data, value: '0x0', valueEth: '0',
    show: { Catalog: CATALOG, App: appId, Slug: app.slug, Call: 'editApp(slug, name, description)', Name: name === app.name ? `${name} (unchanged)` : `${name} (was ${app.name})`,
      'New description': description, 'Old description': app.description, Network: 'Base (chain 8453)' },
  }],
};
fs.writeFileSync(outPath, JSON.stringify(plan, null, 1) + '\n');
console.log(JSON.stringify({ wrote: outPath, appId, slug: app.slug, name, descriptionBytes: new TextEncoder().encode(description).length, steps: plan.steps.map((s) => s.id) }));
