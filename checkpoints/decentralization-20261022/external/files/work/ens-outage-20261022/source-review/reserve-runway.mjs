// READ-ONLY runway check for the 11 self-hosted lease-gas reserves (prepared for root; never executed by its author).
// Usage:  RPC=<one base rpc url> node work/ens-outage-20261022/source-review/reserve-runway.mjs
// Calls: eth_blockNumber/getBlock, reserve.reserveOf/limits/l1Oracle, oracle.getL1FeeUpperBound. No signing, no writes.
import { createRequire } from "node:module";
// viem resolves from work/enclave/node_modules (this file sits outside that tree)
const req = createRequire(new URL("../../enclave/package.json", import.meta.url));
const { createPublicClient, http } = await import(req.resolve("viem"));
const { base } = await import(req.resolve("viem/chains"));
import { RESERVE_ABI, quote, currentFees } from "../../enclave/client/lease-executor-client.mjs";

const RESERVE = "0x12a3f873041dec436daa0085b766a399a6fa3639";          // lease-enrollment-signing journals' `to`
const OWNER = "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61";            // owner of record when enrolled (reserve key)
const IDS = {
  "0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33": "s3-ipfs-adapter (catalog 0x4306e5 v17)",
  "0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a": "catalog 0x9afdfb v5 (publisher)",
  "0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9": "catalog 0xefc677 v42",
  "0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c": "catalog 0xd8ec1d v85",
  "0xe64f7cba307e2d97485bde356d75564ccb74c5e31c272b5ab3349abfe122569b": "catalog 0xa856a2 v69",
  "0xa77d0c577c1ca48510ff72545f9e050dc7d1fc9c6d1129f056494a5190cb8371": "catalog 0x550d4d v4",
  "0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77": "catalog 0x5bca36 v0",
  "0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c": "catalog 0xf1897f v3",
  "0xc13d4b6a613ba277e9a8559adb76b2f60394ef16649f7a623e8a7a6c4f097681": "catalog 0xfd4206 v5",
  "0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238": "catalog 0x093fa9 v7",
  "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c": "EnclaveDNS upstream (catalog 0x85f28c v4)",
};
if (!process.env.RPC) throw new Error("set RPC to one Base RPC URL");
const client = createPublicClient({ chain: base, transport: http(process.env.RPC) });
const fees = await currentFees(client);
const renewQ = await quote({ client, reserve: RESERVE, kind: "renew", gasPrice: fees.effective });
const claimQ = await quote({ client, reserve: RESERVE, kind: "claim", gasPrice: fees.effective });
const block = await client.getBlock();
const rows = [];
for (const [id, label] of Object.entries(IDS)) {
  const r = await client.readContract({ address: RESERVE, abi: RESERVE_ABI, functionName: "reserveOf", args: [id, OWNER] });
  const bal = BigInt(r.balanceWei);
  const renews = renewQ > 0n ? bal / renewQ : null;
  rows.push({ id: id.slice(0, 10), label, enabled: r.enabled, balanceWei: String(bal), maxPerOpWei: String(r.maxPerOpWei),
    epochCapWei: String(r.epochCapWei), epochSec: Number(r.epochSec), renewWindow: Number(r.renewWindow),
    renewAffordable: bal >= renewQ, claimAffordable: bal >= claimQ, renewsLeftAtQuote: renews == null ? null : String(renews),
    // ~2 renews per hour at leaseSec 1800 (quote is the relay's UPPER estimate; actual charges ran ~1.1-1.5e12 wei)
    approxHoursLeft: renews == null ? null : Number(renews) / 2 });
}
console.log(JSON.stringify({ block: String(block.number), at: new Date(Number(block.timestamp) * 1000).toISOString(),
  effectiveGasPrice: String(fees.effective), renewQuoteWei: String(renewQ), claimQuoteWei: String(claimQ), rows }, null, 2));
