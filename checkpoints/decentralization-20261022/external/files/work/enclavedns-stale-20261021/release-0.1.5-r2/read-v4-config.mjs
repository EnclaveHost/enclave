// READ-ONLY: catalog app 0x85f28c21 version 4 config/name/desc text (public on-chain), two RPCs agreeing.
const W = '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave';
const fs = await import('node:fs');
const viem = await import(W + '/node_modules/viem/_esm/index.js');
const CAT = JSON.parse(fs.readFileSync(W + '/contracts/foundry/out/EnclaveAppCatalog.sol/EnclaveAppCatalog.json', 'utf8')).abi;
const cs = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'].map((u) => viem.createPublicClient({ transport: viem.http(u, { timeout: 12000 }) }));
const bn = (await Promise.all(cs.map((c) => c.getBlockNumber()))).reduce((a, b) => (a < b ? a : b)) - 3n;
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const r = await Promise.all(cs.map((c) => c.readContract({ address: '0x18419CA2b502D423A8de6269AEeE171a378626e3', abi: CAT, functionName: 'getVersion', args: ['0x85f28c21b1545a05aee6661faf4b149b5dd18377fce59ad290e9f19857baab06', 4n], blockNumber: bn })));
if (J(r[0]) !== J(r[1])) throw new Error('disagree');
console.log(J({ block: Number(bn), version4: r[0] }));
