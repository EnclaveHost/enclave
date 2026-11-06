#!/usr/bin/env node
// measure-posting.mjs - measure what the batcher and proposer actually spend
// on L1, from their receipts, and price the same transactions on mainnet.
//
//   docker logs enclave-l2-devnet-batcher-1 | node l2/devnet/measure-posting.mjs --l1-rpc URL \
//     --role batcher [--proposer-log FILE] [--eth-usd 2261] [--gwei 0.05,1] [--tip-gwei 0] > costs.json
//
// Reads "Transaction confirmed ... tx=0x.." and "Channel closed ... input_bytes=.. output_bytes=.."
// lines from op-batcher / op-proposer logs on stdin (and --proposer-log), fetches each
// L1 transaction and receipt, and reports gas, blobs and fees as paid on this L1.
// The mainnet projection reprices the measured gas and blob counts at each
// base fee, with blobs at the EIP-7918 reserve price (one blob >= 8192 x base fee),
// which is where an uncongested blob market sits.
import fs from "node:fs";
import { createPublicClient, http } from "viem";

const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const RPC = opt("l1-rpc") || (console.error("--l1-rpc required"), process.exit(2));
const ETH_USD = Number(opt("eth-usd", "2261"));
const GWEI = opt("gwei", "0.05,1").split(",").map(Number);
const TIP = Number(opt("tip-gwei", "0"));
const pub = createPublicClient({ transport: http(RPC) });

const confirmed = (text, role) => {
  const seen = new Set(), out = [];
  for (const line of text.split("\n")) {
    if (!/msg="Transaction confirmed"/.test(line)) continue;
    const m = line.match(/tx=(0x[0-9a-f]{64})/);
    if (m && !seen.has(m[1])) { seen.add(m[1]); out.push({ role, hash: m[1] }); }
  }
  return out;
};
const channels = (text) => [...text.matchAll(/msg="Channel closed".*?blocks_len=(\d+).*?num_frames=(\d+) input_bytes=(\d+) output_bytes=(\d+)/g)]
  .map((m) => ({ blocks: +m[1], frames: +m[2], inputBytes: +m[3], outputBytes: +m[4] }));

const batcherLog = fs.readFileSync(0, "utf8");
const proposerLog = opt("proposer-log") ? fs.readFileSync(opt("proposer-log"), "utf8") : "";
const wanted = [...confirmed(batcherLog, opt("role", "batcher")), ...confirmed(proposerLog, "proposer")];

const rows = [];
for (const w of wanted) {
  const [tx, r] = await Promise.all([pub.getTransaction({ hash: w.hash }), pub.getTransactionReceipt({ hash: w.hash })]);
  const blk = await pub.getBlock({ blockNumber: r.blockNumber });
  const blobs = tx.blobVersionedHashes?.length || 0;
  rows.push({ ...w, block: Number(r.blockNumber), time: Number(blk.timestamp), status: r.status, gasUsed: Number(r.gasUsed),
    blobs, blobGasUsed: Number(r.blobGasUsed || 0n), effectiveGasPrice: r.effectiveGasPrice.toString(),
    blobGasPrice: (r.blobGasPrice || 0n).toString(), l1BaseFee: blk.baseFeePerGas.toString(),
    paidWei: (r.gasUsed * r.effectiveGasPrice + (r.blobGasUsed || 0n) * (r.blobGasPrice || 0n)).toString() });
}

const price = (row, gwei) => {
  const base = gwei * 1e9, tip = TIP * 1e9;
  const exec = row.gasUsed * (base + tip), blob = row.blobs * 8192 * base;
  return (exec + blob) / 1e18;
};
const summarize = (role) => {
  const rs = rows.filter((r) => r.role === role && r.status === "success");
  if (!rs.length) return null;
  const span = rs.length > 1 ? rs.at(-1).time - rs[0].time : 0;
  const s = { txs: rs.length, firstBlock: rs[0].block, lastBlock: rs.at(-1).block, spanSeconds: span,
    gasUsed: { min: Math.min(...rs.map((r) => r.gasUsed)), max: Math.max(...rs.map((r) => r.gasUsed)),
      mean: Math.round(rs.reduce((a, r) => a + r.gasUsed, 0) / rs.length) },
    blobsPerTx: rs.reduce((a, r) => a + r.blobs, 0) / rs.length,
    paidOnThisL1Wei: rs.reduce((a, r) => a + BigInt(r.paidWei), 0n).toString(), mainnet: {} };
  for (const g of GWEI) {
    const per = rs.reduce((a, r) => a + price(r, g), 0) / rs.length;
    s.mainnet[`${g}gwei`] = { ethPerTx: per, usdPerTx: per * ETH_USD };
  }
  return s;
};

const ch = channels(batcherLog);
const out = { kind: "enclave.l2-posting-costs", version: 1, measuredAt: new Date().toISOString(), l1ChainId: await pub.getChainId(),
  assumptions: { ethUsd: ETH_USD, tipGwei: TIP, blobPrice: "EIP-7918 reserve: 8192 x base fee per blob" },
  batcher: summarize(opt("role", "batcher")), proposer: summarize("proposer"),
  channels: ch.length ? { count: ch.length, outputBytes: { min: Math.min(...ch.map((c) => c.outputBytes)), max: Math.max(...ch.map((c) => c.outputBytes)) },
    blocksPerChannel: { min: Math.min(...ch.map((c) => c.blocks)), max: Math.max(...ch.map((c) => c.blocks)) }, all: ch } : null,
  txs: rows };
console.log(JSON.stringify(out, null, 2));
