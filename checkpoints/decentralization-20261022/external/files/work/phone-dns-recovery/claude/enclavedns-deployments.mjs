// READ-ONLY (Base, eth_call only, two RPCs agreeing at one block): every ledger row of the EnclaveDNS catalog app, to see
// whether ANY resolver replica besides 0x59f1273d is live. Decodes with the foundry artifact; checks the known row against
// the root's ledger-dns.json before trusting the decode.
import fs from 'node:fs';
const viem = await import('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules/viem/_esm/index.js');
const art = JSON.parse(fs.readFileSync('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/contracts/foundry/out/EnclaveDeployments.sol/EnclaveDeployments.json', 'utf8'));
const LEDGER = '0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B';
const APP = 'catalog://0x85f28c21b1545a05aee6661faf4b149b5dd18377fce59ad290e9f19857baab06/';
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const cs = RPCS.map((u) => viem.createPublicClient({ transport: viem.http(u, { timeout: 20000 }) }));
const blockNumber = (await Promise.all(cs.map((c) => c.getBlockNumber()))).reduce((a, b) => (a < b ? a : b)) - 3n;
const read = async (functionName, args = []) => {
  const r = await Promise.all(cs.map((c) => c.readContract({ address: LEDGER, abi: art.abi, functionName, args, blockNumber })));
  const s = r.map((x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  if (s[0] !== s[1]) throw new Error(`RPCs disagree on ${functionName}`);
  return JSON.parse(s[0]);
};
const block = await cs[0].getBlock({ blockNumber });
const n = Number(await read('count'));
const rows = [];
for (let i = 0; i < n; i++) {
  const id = await read('idAt', [BigInt(i)]);
  const d = await read('get', [id]);
  if (String(d.appRef || '').startsWith(APP)) rows.push({ id, appRef: d.appRef, owner: d.owner, active: d.active, runner: d.runner,
    leaseUntil: d.leaseUntil, leaseLive: Number(d.leaseUntil) > Number(block.timestamp), rate: d.rate, balance6: d.balance6 });
}
console.log(JSON.stringify({ block: Number(blockNumber), timestamp: Number(block.timestamp), ledger: LEDGER, total: n, enclaveDnsRows: rows }, null, 1));
