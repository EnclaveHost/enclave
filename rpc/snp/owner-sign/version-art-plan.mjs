// Write PLAN.json for owner-sign/server.mjs: the owner's steps that give a catalog app a thumbnail and a banner.
//
//   node rpc/snp/owner-sign/version-art-plan.mjs OWNER APP_ID LABEL THUMBNAIL BANNER JOURNAL OUT_PLAN.json
//
// THUMBNAIL, BANNER: image files (SVG, PNG, JPEG, WebP or GIF, under 256 KiB each). LABEL: the new version's label.
// Steps, in the order the page enables them:
//   thumbnail, banner  a message the wallet signs per file (enclave-upload:<sha256>:<expiry>); the server trades it
//                      for an upload token and pins the file. Not a transaction.
//   publish            EnclaveAppCatalog.publishVersion: the app's newest version again (component, resources, ports,
//                      name, description as the catalog holds them), its config differing in `_media` alone
// The store draws the newest approved version's art, so the owner must be the publisher and the catalog owner (the
// version is then approved at once). No deployment moves. The plan is written only if every RPC simulates the publish
// and then reads the new version back with exactly this config.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createPublicClient, decodeFunctionResult, encodeFunctionData, getAddress, http } from 'viem';
import { base } from 'viem/chains';
import { CATALOG_ABI } from './abi.mjs';
import { rawCid, withArt } from './version-art.mjs';

const CATALOG = '0x18419ca2b502d423a8de6269aeee171a378626e3';
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const TOKEN_URL = 'https://api.enclave.host/v1/apps/upload-token', UPLOAD_URL = 'https://ipfs.enclave.host/add-image';
const GATEWAYS = ['https://ipfs.enclave.host'];   // where the store reads app art from
const TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

const [ownerArg, appId, label, thumbPath, bannerPath, journal, outPath] = process.argv.slice(2);
if (!/^0x[0-9a-f]{64}$/.test(appId || '') || !label || !outPath) throw new Error('usage: version-art-plan.mjs OWNER APP_ID LABEL THUMBNAIL BANNER JOURNAL OUT_PLAN.json');
const owner = getAddress(ownerArg);
const file = (p) => {
  const bytes = fs.readFileSync(p), contentType = TYPES[path.extname(p).toLowerCase()];
  if (!contentType) throw new Error(`${p}: not an image type the gateway takes`);
  return { file: path.resolve(p), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), cid: rawCid(bytes), contentType,
    svg: contentType === 'image/svg+xml', tokenUrl: TOKEN_URL, uploadUrl: UPLOAD_URL, gateways: GATEWAYS };
};
const thumbnail = file(thumbPath), banner = file(bannerPath);

const clients = RPCS.map((url) => createPublicClient({ chain: base, transport: http(url, { timeout: 15000 }) }));
const read = (functionName, args = []) => clients[0].readContract({ address: CATALOG, abi: CATALOG_ABI, functionName, args });
const [app, catalogOwner, versions] = await Promise.all([read('getApp', [appId]), read('owner'), read('numVersions', [appId])]);
if (getAddress(app.publisher) !== owner) throw new Error('the owner is not the app’s publisher');
if (getAddress(catalogOwner) !== owner) throw new Error('the owner is not the catalog owner: the version would wait for approval and the store would not draw it');
const index = Number(versions), prev = await read('getVersion', [appId, BigInt(index - 1)]);
if (prev.yanked || prev.approval !== 1) throw new Error(`version ${index - 1}, the newest, is not an approved live version`);
const media = { thumbnail: thumbnail.cid, ...(thumbnail.svg ? { thumbnailSvg: true } : {}), banner: banner.cid, ...(banner.svg ? { bannerSvg: true } : {}) };
const config = withArt(prev.config, media);
if (config === prev.config) throw new Error('the newest version already carries this art');

const res = [prev.vramMb, prev.gpuGflops, prev.memMb, prev.cpuGflops];
const data = encodeFunctionData({ abi: CATALOG_ABI, functionName: 'publishVersion', args: [app.slug, app.name, app.description, label, prev.cid, res, prev.ports, config, 0n] });
const getData = encodeFunctionData({ abi: CATALOG_ABI, functionName: 'getVersion', args: [appId, BigInt(index)] });
for (const [i, one] of clients.entries()) {
  const host = new URL(RPCS[i]).host;
  const [{ calls: out }] = await one.request({ method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [{ from: owner, to: CATALOG, data }, { from: owner, to: CATALOG, data: getData }] }] }, 'latest'] });
  if (out.length !== 2 || out.some((c) => c.status !== '0x1')) throw new Error(`${host}: the simulation would revert`);
  const v = decodeFunctionResult({ abi: CATALOG_ABI, functionName: 'getVersion', data: out[1].returnData });
  if (v.version !== label || v.cid !== prev.cid || v.config !== config || v.ports !== prev.ports || v.memMb !== prev.memMb || v.approval !== 1) throw new Error(`${host}: version ${index} would not be this one, approved`);
}

const up = (id, what, u) => ({ id, title: `Upload the ${what}`, why: 'Your wallet signs a short message, not a transaction: it authorizes pinning exactly this file, for ten minutes. This computer then uploads it and checks the gateway stored it under the CID the publish names. Nothing running changes.',
  to: null, data: '0x', value: '0x0', valueEth: '0', upload: { sha256: u.sha256 },
  show: { File: u.file, Bytes: String(u.bytes), 'SHA-256': u.sha256, CID: u.cid, Message: `enclave-upload:${u.sha256}:<a time within ten minutes>`,
    'Sent to': `${new URL(TOKEN_URL).host} (the signature), ${new URL(UPLOAD_URL).host} (the file)` } });
const plan = {
  kind: 'version-art', title: `Give ${app.name} its logo and banner`,
  lead: 'Two messages and one transaction from your owner wallet on Base. Check the details on the Trezor screen before confirming. This page never signs or sends anything by itself.',
  chainId: 8453, owner, rpcs: RPCS, journal,
  status: { catalog: CATALOG, appId, versionIndex: index, label, cid: prev.cid, config, uploads: { thumbnail, banner } },
  steps: [up('thumbnail', 'logo (the catalog tile)', thumbnail), up('banner', 'banner (the app page)', banner),
    { id: 'publish', title: `Publish ${app.name} ${label}`, why: `Adds version ${index}: version ${index - 1} (${prev.version}) again, with the art in its config. You own the catalog, so it is approved at once and the store draws its art. No deployment moves or restarts: each keeps the version it runs.`,
      to: CATALOG, data, value: '0x0', valueEth: '0',
      show: { Catalog: CATALOG, App: appId, Slug: app.slug, Version: label, 'Version index': String(index), 'Same as': `version ${index - 1} (${prev.version}) but for the art`, CID: prev.cid,
        Resources: res.join(', '), Ports: prev.ports, Thumbnail: thumbnail.cid, Banner: banner.cid, Config: config, 'Publisher fee': '0', Network: 'Base (chain 8453)' } }],
};
fs.writeFileSync(outPath, JSON.stringify(plan, null, 1) + '\n');
console.log(JSON.stringify({ wrote: outPath, appId, versionIndex: index, label, copies: prev.version, thumbnail: thumbnail.cid, banner: banner.cid, configBytes: Buffer.byteLength(config), steps: plan.steps.map((s) => s.id) }));
