// READ-ONLY: the three nucbox leases on Base (two RPCs, same block): leaseUntil, seconds left, runner, active.
import fs from "node:fs";
import { createPublicClient, http } from "../enclave/node_modules/viem/_esm/index.js";
import { base } from "../enclave/node_modules/viem/_esm/chains/index.js";
const { ENROLLMENT } = await import("../lease-enrollment-signing/trust.mjs");
const IDS = { "59f1273d": "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c", "7ae476a3": "0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33",
  "d9798e4c": "0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a" };
const abi = JSON.parse(fs.readFileSync(new URL("../enclave/contracts/EnclaveDeployments.abi.json", import.meta.url), "utf8"));
const cs = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"].map((u) => createPublicClient({ chain: base, transport: http(u, { timeout: 15000 }) }));
const bn = (await Promise.all(cs.map((c) => c.getBlockNumber()))).reduce((a, b) => (a < b ? a : b)) - 2n, blk = await cs[0].getBlock({ blockNumber: bn });
const out = { block: String(bn), blockTime: new Date(Number(blk.timestamp) * 1000).toISOString().slice(11, 19) };
for (const [k, id] of Object.entries(IDS)) {
  const r = await Promise.all(cs.map((c) => c.readContract({ address: ENROLLMENT.ledger, abi, functionName: "get", args: [id], blockNumber: bn })));
  out[k] = { agree: r[0].leaseUntil === r[1].leaseUntil, active: r[0].active, runnerNucbox: r[0].runner.toLowerCase().startsWith("0x2fcef48d"),
             leaseUntil: new Date(Number(r[0].leaseUntil) * 1000).toISOString().slice(11, 19), leftS: Number(r[0].leaseUntil) - Number(blk.timestamp) };
}
fs.appendFileSync(new URL("./lease-check.jsonl", import.meta.url), JSON.stringify({ at: new Date().toISOString(), ...out }) + "\n");
console.log(JSON.stringify(out));
