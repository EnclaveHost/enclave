// READ-ONLY public-chain probe (no signing, no sends): the live lease quantum, each running app's lease, and its recent
// Renewed history, from two independent keyless Base RPCs. Output: chain-probe-<ts>.json beside this file.
// Run: node chain-probe.mjs   (resolves viem from ../enclave/node_modules)
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(new URL("../enclave/package.json", import.meta.url));
const { createPublicClient, http, parseAbi, parseAbiItem } = require("viem");
const { base } = require("viem/chains");

const LEDGER = "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b";   // outputs/contract-change-audit/live.json book.entries.deployments
const IDS = process.argv.slice(2).length ? process.argv.slice(2) : [
  "0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77", "0xe64f7cba307e2d97485bde356d75564ccb74c5e31c272b5ab3349abfe122569b",
  "0xa77d0c577c1ca48510ff72545f9e050dc7d1fc9c6d1129f056494a5190cb8371", "0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238",
  "0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33", "0xc13d4b6a613ba277e9a8559adb76b2f60394ef16649f7a623e8a7a6c4f097681",
  "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c", "0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a",
  "0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c"];
const RPCS = ["https://base.gateway.tenderly.co", "https://base-rpc.polkachu.com"];
const RENEWED = parseAbiItem("event Renewed(bytes32 indexed id, bytes32 indexed enclaveId, uint64 leaseUntil, uint256 burned6)");
const CLAIMED = parseAbiItem("event Claimed(bytes32 indexed id, bytes32 indexed enclaveId, address indexed operator, uint64 leaseUntil, uint256 burned6)");
const VIEW = parseAbi(["function leaseSec() view returns (uint64)"]);
const LOOKBACK = BigInt(process.env.LOOKBACK_BLOCKS || 5400);     // ~3 h at 2 s
const out = { at: new Date().toISOString(), ledger: LEDGER, rpcs: {} };
for (const url of RPCS) {
  const r = (out.rpcs[url] = {});
  try {
    const c = createPublicClient({ chain: base, transport: http(url, { retryCount: 1, timeout: 20_000 }) });
    const head = await c.getBlock(); r.head = { number: String(head.number), timestamp: Number(head.timestamp) };
    r.leaseSec = String(await c.readContract({ address: LEDGER, abi: VIEW, functionName: "leaseSec" }));
    // FROM_BLOCK/TO_BLOCK: an older fixed range (e.g. across the node's last restart) instead of the recent LOOKBACK
    const to = process.env.TO_BLOCK ? BigInt(process.env.TO_BLOCK) : head.number;
    const from = process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : head.number - LOOKBACK; r.fromBlock = String(from); r.toBlock = String(to);
    const logs = [];
    for (let a = from; a <= to; a += 1000n) {
      const b = a + 999n > to ? to : a + 999n;
      for (const ev of [RENEWED, CLAIMED])
        logs.push(...(await c.getLogs({ address: LEDGER, event: ev, args: { id: IDS }, fromBlock: a, toBlock: b })));
    }
    const blockTs = new Map();
    const ts = async (n) => { if (!blockTs.has(n)) blockTs.set(n, Number((await c.getBlock({ blockNumber: n })).timestamp)); return blockTs.get(n); };
    r.events = {};
    for (const l of logs.sort((x, y) => Number(x.blockNumber - y.blockNumber) || x.logIndex - y.logIndex)) {
      const t = await ts(l.blockNumber);
      (r.events[l.args.id] ||= []).push({ kind: l.eventName, block: String(l.blockNumber), blockTime: t, tx: l.transactionHash,
        leaseUntil: Number(l.args.leaseUntil), remainingAtSendSec: null, newRemainingSec: Number(l.args.leaseUntil) - t, enclaveId: l.args.enclaveId });
    }
    // remaining at the renewal = previous leaseUntil - the renewal block time (what the host's lead actually was)
    for (const evs of Object.values(r.events)) for (let i = 1; i < evs.length; i++) evs[i].remainingAtSendSec = evs[i - 1].leaseUntil - evs[i].blockTime;
  } catch (e) { r.error = String(e.shortMessage || e.message).slice(0, 300); }
}
const file = new URL(`./chain-probe-${out.at.replace(/[:.]/g, "").slice(0, 15)}Z${process.env.FROM_BLOCK ? "-range" : ""}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
console.log(file.pathname);
