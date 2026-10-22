// Builds UNSIGNED transactions and SIMULATES them with eth_call (read-only; no key, no signature, nothing sent).
import fs from 'node:fs';
const W = '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave';
const viem = await import(W + '/node_modules/viem/_esm/index.js');
const art = (f, c = f) => JSON.parse(fs.readFileSync(`${W}/contracts/foundry/out/${f}.sol/${c}.json`, 'utf8')).abi;
const CAT = art('EnclaveAppCatalog'), DEP = art('EnclaveDeployments'), SV = art('SessionVault');
const auth = JSON.parse(fs.readFileSync('../release-0.1.5/authority.json', 'utf8'));
const v4 = JSON.parse(fs.readFileSync('v4-version.json', 'utf8')).version4;
const OWNER = '0x0b2d009c0c9Af05b12100D77F3c815fea822eE61', CATALOG = auth.catalog.address, LEDGER = auth.deployment.ledger, VAULT = auth.vault.address;
const APP = auth.catalog.app.appId, DEPID = auth.deployment.id;
const CID = process.argv[2], NEXT = BigInt(auth.catalog.versions.length);
if (!/^bafybei[a-z2-7]{52}$/.test(CID)) throw new Error('cid');
const args = ['enclavedns', auth.catalog.app.name, auth.catalog.app.description, '0.1.5', CID,
  [v4.vramMb, v4.gpuGflops, v4.memMb, v4.cpuGflops], v4.ports, v4.config, 0n];
const pub = { chainId: 8453, from: OWNER, to: CATALOG, value: '0', data: viem.encodeFunctionData({ abi: CAT, functionName: 'publishVersion', args }) };
const ref = (i) => `catalog://${APP}/${i}`;
const upg = (i) => ({ chainId: 8453, from: OWNER, to: VAULT, value: '0',
  data: viem.encodeFunctionData({ abi: SV, functionName: 'ownerCall', args: [LEDGER, viem.encodeFunctionData({ abi: DEP, functionName: 'setAppRef', args: [DEPID, ref(i)] })] }) });
const cs = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'].map((u) => viem.createPublicClient({ transport: viem.http(u, { timeout: 12000 }) }));
const bn = (await Promise.all(cs.map((c) => c.getBlockNumber()))).reduce((a, b) => (a < b ? a : b)) - 3n;
const sim = async (tx, abi, fn) => { const r = await Promise.all(cs.map(async (c) => { try { const o = await c.call({ account: tx.from, to: tx.to, data: tx.data, blockNumber: bn });
  return { ok: true, decoded: fn ? viem.decodeFunctionResult({ abi, functionName: fn, data: o.data }) : o.data }; } catch (e) { return { ok: false, error: String(e.shortMessage || e.message).split('\n')[0] }; } }));
  return JSON.parse(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v.toString() : v))); };
const out = { block: Number(bn), note: 'UNSIGNED. Simulated with eth_call only. Nothing signed or sent.',
  publish: { tx: pub, call: { fn: 'publishVersion', args: JSON.parse(JSON.stringify(args, (k, v) => (typeof v === 'bigint' ? v.toString() : v))) }, expectIndex: NEXT.toString(), simulation: await sim(pub, CAT, 'publishVersion') },
  upgrade: { tx: upg(NEXT), appRef: ref(NEXT), via: 'SessionVault.ownerCall(ledger, setAppRef) - DIRECT owner tx only', simulation: await sim(upg(NEXT), SV, null) },
  rollback: { tx: upg(4), appRef: ref(4), simulation: await sim(upg(4), SV, null) },
  negativeControl: { note: 'same upgrade from a non-owner must revert', simulation: await sim({ ...upg(NEXT), from: '0x000000000000000000000000000000000000dEaD' }, SV, null) } };
fs.writeFileSync('unsigned-txs.json', JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({ block: out.block, publish: out.publish.simulation, upgrade: out.upgrade.simulation, rollback: out.rollback.simulation, negative: out.negativeControl.simulation }));
