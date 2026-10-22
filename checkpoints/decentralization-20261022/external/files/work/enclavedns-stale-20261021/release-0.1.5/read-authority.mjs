// READ-ONLY (Base mainnet; eth_call/eth_getCode only; two RPCs must agree at one pinned block). No keys, no signing.
// Who can publish EnclaveDNS 0.1.5 to catalog app 0x85f28c21… and move deployment 0x59f1273d… onto it.
import fs from 'node:fs';
const W = '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave';
const viem = await import(W + '/node_modules/viem/_esm/index.js');
const art = (n) => { const [f, c] = n.includes('/') ? n.split('/') : [n, n]; return JSON.parse(fs.readFileSync(`${W}/contracts/foundry/out/${f}.sol/${c}.json`, 'utf8')).abi; };
const [BOOKABI, CAT, DEP, SV, FAC] = ['EnclaveAddressBook', 'EnclaveAppCatalog', 'EnclaveDeployments', 'SessionVault', 'SessionVault/SessionVaultFactory'].map(art);
const BOOK = '0xab214342d5A490150A4A977063A2f88E21F80907';
const APP = '0x85f28c21b1545a05aee6661faf4b149b5dd18377fce59ad290e9f19857baab06';
const DEPID = '0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c';
const SID = '0x95bfb425bfe3ea356d08b2e8e3a2920097ad3d6de5ff60e65583f4d9ba5fcb5d';
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const cs = RPCS.map((u) => viem.createPublicClient({ transport: viem.http(u, { timeout: 12000, retryCount: 1 }) }));
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const blockNumber = (await Promise.all(cs.map((c) => c.getBlockNumber()))).reduce((a, b) => (a < b ? a : b)) - 3n;
const agree = async (label, f) => { const r = await Promise.all(cs.map(f)); if (J(r[0]) !== J(r[1])) throw new Error('RPCs disagree: ' + label); return r[0]; };
const read = (address, abi, functionName, args = []) => agree(functionName, (c) => c.readContract({ address, abi, functionName, args, blockNumber }));
const code = (address) => agree('code ' + address, (c) => c.getCode({ address, blockNumber }));
const kind = (c) => !c || c === '0x' ? 'EOA (no code)' : c.startsWith('0xef0100') ? `EIP-7702 delegated EOA -> 0x${c.slice(8, 48)}` : `contract (${(c.length - 2) / 2} bytes)`;
const out = { block: Number(blockNumber), timestamp: Number((await cs[0].getBlock({ blockNumber })).timestamp), rpcs: RPCS };
const [keys, vals] = await read(BOOK, BOOKABI, 'all');
const book = {}; keys.forEach((k, i) => { book[viem.hexToString(k, { size: 32 }).replace(/\0+$/, '')] = vals[i]; });
out.addressBook = { address: BOOK, owner: await read(BOOK, BOOKABI, 'owner'), entries: book };
const catalog = book.appCatalog, ledger = book.deployments;
const app = await read(catalog, CAT, 'getApp', [APP]);
const n = Number(await read(catalog, CAT, 'numVersions', [APP]));
const versions = [];
for (let i = 0; i < n; i++) { const v = await read(catalog, CAT, 'getVersion', [APP, BigInt(i)]);
  versions.push({ index: i, version: v.version, cid: v.cid, approval: v.approval, yanked: v.yanked, memMb: v.memMb, cpuGflops: v.cpuGflops, ports: v.ports, createdAt: v.createdAt, configBytes: (v.config || '').length,
    fee: await read(catalog, CAT, 'versionFee', [APP, BigInt(i)]) }); }
out.catalog = { address: catalog, owner: await read(catalog, CAT, 'owner'), pendingOwner: await read(catalog, CAT, 'pendingOwner'), schema: await read(catalog, CAT, 'catalogSchema'),
  importsSealed: await read(catalog, CAT, 'importsSealed'), app, versions };
out.catalog.ownerCode = kind(await code(out.catalog.owner));
const publisher = app.publisher;
out.publisherCode = kind(await code(publisher));
const d = await read(ledger, DEP, 'get', [DEPID]);
out.deployment = { ledger, id: DEPID, ...d, feeOf: await read(ledger, DEP, 'feeOf', [DEPID]).catch((e) => 'n/a') };
const vault = d.owner;
out.vault = { address: vault, code: kind(await code(vault)) };
try {
  out.vault.owner = await read(vault, SV, 'owner');
  out.vault.ownerCode = kind(await code(out.vault.owner));
  out.vault.factory = await read(vault, SV, 'factory');
  out.vault.factoryVaultForOwner = await read(out.vault.factory, FAC, 'vaultFor', [out.vault.owner]).catch((e) => 'n/a: ' + e.shortMessage);
  out.vault.held = await read(vault, SV, 'held', [DEPID]);
  out.vault.ENV = { STAGING: await read(vault, SV, 'ENV_STAGING'), PROD: await read(vault, SV, 'ENV_PROD') };
  const [s, live] = await read(vault, SV, 'sessionOf', [SID]);
  out.vault.storedSession = { sid: SID, live, state: s.state, expiresAt: s.expiresAt, actions: s.actions, envs: s.envs, balance6: s.balance6 };
} catch (e) { out.vault.error = String(e.shortMessage || e.message).split('\n')[0]; }
out.vaultIsPublisher = String(publisher).toLowerCase() === String(vault).toLowerCase();
console.log(J(out));
