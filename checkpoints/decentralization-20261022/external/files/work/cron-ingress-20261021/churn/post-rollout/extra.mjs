// READ-ONLY: ledger get(0x59f1273d) on two Base RPCs agreeing at one block (eth_call only), plus the block time.
import fs from 'node:fs';
const W = '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave';
const viem = await import(W + '/node_modules/viem/_esm/index.js');
const DEP = JSON.parse(fs.readFileSync(W + '/contracts/foundry/out/EnclaveDeployments.sol/EnclaveDeployments.json', 'utf8')).abi;
const cs = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'].map((u) => viem.createPublicClient({ transport: viem.http(u, { timeout: 10000 }) }));
const bn = (await Promise.all(cs.map((c) => c.getBlockNumber()))).reduce((a, b) => (a < b ? a : b)) - 3n;
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const r = await Promise.all(cs.map((c) => c.readContract({ address: '0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B', abi: DEP, functionName: 'get', args: ['0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c'], blockNumber: bn })));
if (J(r[0]) !== J(r[1])) throw new Error('RPCs disagree');
const ts = Number((await cs[0].getBlock({ blockNumber: bn })).timestamp);
const d = r[0];
console.log(J({ block: Number(bn), blockTime: new Date(ts * 1000).toISOString(), appRef: d.appRef, active: d.active, isPublic: d.isPublic, runner: d.runner, runnerOperator: d.runnerOperator,
  leaseUntil: new Date(Number(d.leaseUntil) * 1000).toISOString(), leaseLiveAtBlock: Number(d.leaseUntil) > ts, balance6: d.balance6 }));
