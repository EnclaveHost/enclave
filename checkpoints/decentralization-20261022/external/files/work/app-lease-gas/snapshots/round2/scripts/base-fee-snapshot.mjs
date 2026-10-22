// READ-ONLY Base snapshot for the lease-gas cost model: ONE pinned block, TWO public RPCs that must agree.
// Only eth_blockNumber / eth_getBlockByNumber / eth_call. No transaction, no signature, no key.
//   - the block's base fee (and each RPC's eth_maxPriorityFeePerGas, informational);
//   - the LIVE ledger's leaseSec and its ETH/USD feed (answer, updatedAt) - labelled with the block, never a forecast;
//   - Base's GasPriceOracle (0x420000000000000000000000000000000000000F): the L1 data fee of the ACTUAL representative
//     transactions captured by the local end-to-end runs (getL1Fee(bytes)) and the upper bound the reserve can use
//     on chain (getL1FeeUpperBound(size)), plus the scalars.
// usage: node scripts/base-fee-snapshot.mjs   (cwd work/app-lease-gas)  -> fixtures/base-fee-snapshot.json
import fs from "node:fs";
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";

const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];
const LEDGER = "0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B";   // live rev 16d (contracts/deployments/source-verification-base.json)
const GPO = "0x420000000000000000000000000000000000000F";
const LEDGER_ABI = parseAbi(["function leaseSec() view returns (uint64)", "function ethUsdFeed() view returns (address)"]);
const FEED_ABI = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"]);
const GPO_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)", "function getL1FeeUpperBound(uint256) view returns (uint256)",
  "function isFjord() view returns (bool)", "function l1BaseFee() view returns (uint256)", "function blobBaseFee() view returns (uint256)",
  "function baseFeeScalar() view returns (uint32)", "function blobBaseFeeScalar() view returns (uint32)"]);

const rpc = async (url, method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${url} ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};
const head = BigInt(await rpc(RPCS[0], "eth_blockNumber", []));
const block = "0x" + (head - 32n).toString(16);
const agree = async (method, params) => {
  const xs = await Promise.all(RPCS.map((u) => rpc(u, method, params)));
  const key = (x) => JSON.stringify(x);
  if (xs.some((x) => key(x) !== key(xs[0]))) throw new Error(`RPCs disagree on ${method}`);
  return xs[0];
};
const call = async (to, abi, functionName, args = []) => decodeFunctionResult({ abi, functionName,
  data: await agree("eth_call", [{ to, data: encodeFunctionData({ abi, functionName, args }) }, block]) });

const blocks = await Promise.all(RPCS.map((u) => rpc(u, "eth_getBlockByNumber", [block, false])));
const pick = (x) => JSON.stringify([x.hash, x.baseFeePerGas, x.timestamp]);   // providers add different extra fields
if (blocks.some((x) => pick(x) !== pick(blocks[0]))) throw new Error("RPCs disagree on the block (hash, base fee, timestamp)");
const b = blocks[0];
const out = { readOnly: true, rpcs: RPCS, block: Number(BigInt(block)), blockHash: b.hash, timestamp: Number(BigInt(b.timestamp)),
  at: new Date(Number(BigInt(b.timestamp)) * 1000).toISOString(), baseFeePerGas: BigInt(b.baseFeePerGas).toString() };
out.maxPriorityFeePerGasByRpc = Object.fromEntries(await Promise.all(RPCS.map(async (u) => [u, BigInt(await rpc(u, "eth_maxPriorityFeePerGas", [])).toString()])));
out.ledger = { address: LEDGER, leaseSec: (await call(LEDGER, LEDGER_ABI, "leaseSec")).toString() };
const feed = await call(LEDGER, LEDGER_ABI, "ethUsdFeed");
const [roundId, answer, , updatedAt] = await call(feed, FEED_ABI, "latestRoundData");
out.ethUsd = { feed, decimals: await call(feed, FEED_ABI, "decimals"), roundId: roundId.toString(), answer: answer.toString(),
  updatedAt: Number(updatedAt), ageAtBlockSec: out.timestamp - Number(updatedAt) };
out.gasPriceOracle = { address: GPO, isFjord: await call(GPO, GPO_ABI, "isFjord"), l1BaseFee: (await call(GPO, GPO_ABI, "l1BaseFee")).toString(),
  blobBaseFee: (await call(GPO, GPO_ABI, "blobBaseFee")).toString(), baseFeeScalar: Number(await call(GPO, GPO_ABI, "baseFeeScalar")),
  blobBaseFeeScalar: Number(await call(GPO, GPO_ABI, "blobBaseFeeScalar")) };
out.l1 = {};
for (const [file, design] of [["fixtures/representative-txs.json", "B"], ["fixtures/representative-aa-txs.json", "A"]]) {
  if (!fs.existsSync(file)) continue;
  const f = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [label, raw] of Object.entries(f.txs)) {
    const bytes = (raw.length - 2) / 2;
    const fee = await call(GPO, GPO_ABI, "getL1Fee", [raw]);
    const upper = await call(GPO, GPO_ABI, "getL1FeeUpperBound", [BigInt(bytes)]);
    out.l1[`${design}:${label}`] = { rawBytes: bytes, l1FeeWei: fee.toString(), upperBoundWei: upper.toString(),
      l2GasEquivalentAtBaseFee: (BigInt(b.baseFeePerGas) > 0n ? fee / BigInt(b.baseFeePerGas) : 0n).toString() };
  }
}
fs.writeFileSync("fixtures/base-fee-snapshot.json", JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out, null, 1));
