// READ-ONLY release preparation on BASE (chainId 8453) for the composed ipns-publisher (ENS repair):
//   - two public RPCs at ONE agreed block (same hash); every read compared;
//   - the live address book -> catalog + deployments; the catalog app 0x9afd... (publisher, slug, versions, schema,
//     owner) and version index 5's config text VERBATIM (written to version-config-v5.json, sha256 checked);
//   - the composed wasm's CID computed locally with main's site-release UnixFS importer (checked first against the
//     deployed v5 artifact's known CID);
//   - publishVersion SIMULATED (eth_call + estimateGas) from the app's publisher with the v5 fields; nothing signed.
//   node release-prep.mjs <composed.wasm>
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/package.json');
const { createPublicClient, http, getAddress, encodeFunctionData, decodeFunctionResult } = require('viem');
const { importFile, cidString } = await import('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/scripts/site-release/unixfs.mjs');

const WASM = process.argv[2];
const DEPLOYED_BIN = '/home/steven/Documents/Codex/2026-10-18/wo/work/adapter-retained/bafybeiesjakstv3lnkgkbcrj3itenwubnk6wuwpkcrgmjbh64wfkr4j6ii.bin';
const APP_ID = '0x9afdfb401d6f2cfea70c446f9f5874bbca8ce7dd116e2b15715312d8d32a65ef', V5 = 5, V5_CONFIG_SHA = 'c681a628454c9ffef5522cd5e3fd570aab0480307a91d7afd735cec9fce2b2ee';
const BOOK = '0xab214342d5A490150A4A977063A2f88E21F80907';
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const APP = [{ name: 'appId', type: 'bytes32' }, { name: 'publisher', type: 'address' }, { name: 'slug', type: 'string' }, { name: 'name', type: 'string' },
  { name: 'description', type: 'string' }, { name: 'versionCount', type: 'uint32' }, { name: 'createdAt', type: 'uint64' }, { name: 'updatedAt', type: 'uint64' }, { name: 'active', type: 'bool' }];
const VER = [{ name: 'cid', type: 'string' }, { name: 'version', type: 'string' }, { name: 'vramMb', type: 'uint32' }, { name: 'gpuGflops', type: 'uint32' },
  { name: 'memMb', type: 'uint32' }, { name: 'cpuGflops', type: 'uint32' }, { name: 'createdAt', type: 'uint64' }, { name: 'verified', type: 'bool' },
  { name: 'yanked', type: 'bool' }, { name: 'ports', type: 'string' }, { name: 'approval', type: 'uint8' }, { name: 'config', type: 'string' }];
const ABI = [
  { type: 'function', name: 'all', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32[]' }, { type: 'address[]' }] },
  { type: 'function', name: 'catalogSchema', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'appCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getAppsPage', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [{ type: 'tuple[]', components: APP }] },
  { type: 'function', name: 'getVersionsPage', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }], outputs: [{ type: 'tuple[]', components: VER }] },
  { type: 'function', name: 'versionFee', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'versionConfigCid', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'uint256' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'publishVersion', stateMutability: 'nonpayable', inputs: [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'string' },
    { type: 'uint32[4]' }, { type: 'string' }, { type: 'string' }, { type: 'uint256' }], outputs: [{ type: 'bytes32' }, { type: 'uint256' }] },
];
const out = { at: new Date().toISOString(), chain: 'Base 8453', rpcs: {} };
const cs = RPCS.map((url) => ({ url, c: createPublicClient({ transport: http(url, { timeout: 20000, retryCount: 1 }) }) }));
const live = [];
for (const r of cs) { try { const [id, h] = await Promise.all([r.c.getChainId(), r.c.getBlockNumber()]); out.rpcs[r.url] = { chainId: id, head: Number(h) }; if (id === 8453) live.push({ ...r, head: h }); } catch (e) { out.rpcs[r.url] = { error: String(e.shortMessage || e.message).slice(0, 100) }; } }
const B = live.reduce((m, r) => (r.head < m ? r.head : m), live[0].head) - 5n;
const hashes = {}; for (const r of live) hashes[r.url] = (await r.c.getBlock({ blockNumber: B })).hash;
const agreeing = live.filter((r) => hashes[r.url] === hashes[live[0].url]).slice(0, 2);
out.block = { number: Number(B), hash: hashes[live[0].url], agreeing: agreeing.map((r) => r.url) };
if (agreeing.length < 2) { console.log(JSON.stringify(out, null, 1)); process.exit(2); }
// every read: both RPCs, byte-identical results required
async function rd(to, fn, args = []) {
  const data = encodeFunctionData({ abi: ABI, functionName: fn, args }); const res = [];
  for (const r of agreeing) res.push((await r.c.call({ to, data, blockNumber: B })).data);
  if (res[0] !== res[1]) throw new Error(`RPCs disagree on ${fn}`);
  return decodeFunctionResult({ abi: ABI, functionName: fn, data: res[0] });
}
const [keys, vals] = await rd(BOOK, 'all');
const book = {}; keys.forEach((k, i) => { let s = ''; for (let b = 2; b < k.length; b += 2) { const c = parseInt(k.slice(b, b + 2), 16); if (!c) break; s += String.fromCharCode(c); } book[s] = vals[i]; });
const CATALOG = book.appCatalog, DEPLOYMENTS = book.deployments;
out.addressBook = { book: BOOK, appCatalog: CATALOG, deployments: DEPLOYMENTS };
const schema = Number(await rd(CATALOG, 'catalogSchema'));
let catOwner = null; try { catOwner = await rd(CATALOG, 'owner'); } catch (e) { catOwner = 'unreadable: ' + String(e.message).slice(0, 80); }
const n = Number(await rd(CATALOG, 'appCount')); let app = null;
for (let s = 0; s < n && !app; s += 50) app = (await rd(CATALOG, 'getAppsPage', [BigInt(s), 50n])).find((a) => a.appId.toLowerCase() === APP_ID);
const vers = await rd(CATALOG, 'getVersionsPage', [APP_ID, 0n, BigInt(app.versionCount)]);
const v5 = vers[V5];
const fee5 = schema >= 5 ? await rd(CATALOG, 'versionFee', [APP_ID, BigInt(V5)]) : 0n;
const cfgCid5 = schema >= 7 ? await rd(CATALOG, 'versionConfigCid', [APP_ID, BigInt(V5)]) : '';
fs.writeFileSync('version-config-v5.json', v5.config);       // VERBATIM: the exact on-chain string, no trailing newline
const v5sha = sha(Buffer.from(v5.config, 'utf8'));
out.catalog = { address: CATALOG, schema, owner: catOwner, app: { appId: app.appId, publisher: app.publisher, slug: app.slug, name: app.name, description: app.description, versionCount: Number(app.versionCount), active: app.active },
  publisherIsCatalogOwner: typeof catOwner === 'string' && catOwner.toLowerCase?.() === app.publisher.toLowerCase(),
  versions: vers.map((v, i) => ({ index: i, version: v.version, cid: v.cid, memMb: v.memMb, cpuGflops: v.cpuGflops, vramMb: v.vramMb, gpuGflops: v.gpuGflops, ports: v.ports, approval: ['pending', 'approved', 'rejected'][v.approval] ?? v.approval, yanked: v.yanked, configSha256: sha(Buffer.from(v.config, 'utf8')) })),
  v5: { version: v5.version, cid: v5.cid, feePerSec6: String(fee5), configCid: cfgCid5, configSha256: v5sha, configMatchesRecorded: v5sha === V5_CONFIG_SHA, configFile: 'version-config-v5.json' },
  nextIndex: Number(app.versionCount) };
// the release CID: main's UnixFS importer (kubo's balanced raw-leaf layout), proven on the deployed artifact first
const deployedCid = cidString(importFile(fs.readFileSync(DEPLOYED_BIN)).cid);
const wasm = fs.readFileSync(WASM), wasmCid = cidString(importFile(wasm).cid);
out.artifact = { file: WASM, bytes: wasm.length, sha256: sha(wasm), cid: wasmCid, importerCheck: { deployedComputed: deployedCid, deployedOnChain: v5.cid, equal: deployedCid === v5.cid } };
// next label: one above the highest existing semver-ish label
const labels = vers.map((v) => v.version); const last = labels[labels.length - 1];
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(last); const next = m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : null;
out.nextVersion = { label: next, index: Number(app.versionCount), existingLabels: labels };
// simulate the publish from the app's publisher with the v5 fields (0 ETH); a revert reason is reported as is
const res = [v5.vramMb, v5.gpuGflops, v5.memMb, v5.cpuGflops];
const args = [app.slug, app.name || app.slug, app.description || '', next, wasmCid, res, v5.ports, v5.config, fee5];
const data = encodeFunctionData({ abi: ABI, functionName: 'publishVersion', args });
out.publishSimulation = { from: app.publisher, to: CATALOG, value: '0', function: 'publishVersion(slug,name,desc,version,cid,res,ports,config,feePerSec6)', args: { slug: app.slug, version: next, cid: wasmCid, res, ports: v5.ports, configSha256: v5sha, feePerSec6: String(fee5) }, dataSha256: sha(Buffer.from(data.slice(2), 'hex')) };
for (const r of agreeing) {
  try { const x = await r.c.call({ account: app.publisher, to: CATALOG, data, blockNumber: B }); const [id, idx] = decodeFunctionResult({ abi: ABI, functionName: 'publishVersion', data: x.data });
    out.publishSimulation[r.url] = { ok: true, appId: id, index: Number(idx) };
    try { out.publishSimulation[r.url].gas = String(await r.c.estimateGas({ account: app.publisher, to: CATALOG, data })); } catch (e) { out.publishSimulation[r.url].gasError = String(e.shortMessage || e.message).slice(0, 120); }
  } catch (e) { out.publishSimulation[r.url] = { ok: false, revert: String(e.shortMessage || e.details || e.message).slice(0, 200) }; }
}
console.log(JSON.stringify(out, (k, v) => typeof v === 'bigint' ? v.toString() : v, 1));
