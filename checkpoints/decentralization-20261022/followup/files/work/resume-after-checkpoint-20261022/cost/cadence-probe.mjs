// READ-ONLY public-chain probe (no signing, no sends, no keys): for each self-hosted app, the ledger's rate, the
// reserve's renewWindow/minExtension for the owner of record, and the recent Renewed history, so the renewal cadence of
// rate-0 vs paid leases is measured, not assumed. Output: cadence-probe-<ts>.json beside this file.
// Run: node cadence-probe.mjs   (resolves viem from ../../enclave/node_modules)
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(new URL("../../enclave/package.json", import.meta.url));
const { createPublicClient, http, parseAbi, parseAbiItem } = require("viem");
const { base } = require("viem/chains");
const O = await import(new URL("../../enclave/network/lease-gas-owner.mjs", import.meta.url).href);

const LEDGER = "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b";
const RESERVE = "0x12A3f873041Dec436DaA0085B766a399A6fA3639";
const IDS = [
  "0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77", "0xe64f7cba307e2d97485bde356d75564ccb74c5e31c272b5ab3349abfe122569b",
  "0xa77d0c577c1ca48510ff72545f9e050dc7d1fc9c6d1129f056494a5190cb8371", "0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238",
  "0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33", "0xc13d4b6a613ba277e9a8559adb76b2f60394ef16649f7a623e8a7a6c4f097681",
  "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c", "0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a",
  "0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c"];
const RPCS = ["https://base-rpc.polkachu.com", "https://base.gateway.tenderly.co"];
const RENEWED = parseAbiItem("event Renewed(bytes32 indexed id, bytes32 indexed enclaveId, uint64 leaseUntil, uint256 burned6)");
const CLAIMED = parseAbiItem("event Claimed(bytes32 indexed id, bytes32 indexed enclaveId, address indexed operator, uint64 leaseUntil, uint256 burned6)");
const LEASE = parseAbi(["function leaseSec() view returns (uint64)"]);
const LOOKBACK = BigInt(process.env.LOOKBACK_BLOCKS || 5400);     // ~3 h at 2 s
const out = { at: new Date().toISOString(), ledger: LEDGER, reserve: RESERVE, readOnly: true, rpc: null, apps: {} };
let lastErr = null;
for (const url of RPCS) {
  try {
    const c = createPublicClient({ chain: base, transport: http(url, { retryCount: 1, timeout: 20_000 }) });
    const head = await c.getBlock(); const blockNumber = head.number;
    out.rpc = url; out.head = { number: String(head.number), timestamp: Number(head.timestamp) };
    out.leaseSec = Number(await c.readContract({ address: LEDGER, abi: LEASE, functionName: "leaseSec", blockNumber }));
    const from = head.number - LOOKBACK; out.fromBlock = String(from);
    const logs = [];
    for (let a = from; a <= head.number; a += 1000n) {
      const b = a + 999n > head.number ? head.number : a + 999n;
      for (const ev of [RENEWED, CLAIMED]) logs.push(...(await c.getLogs({ address: LEDGER, event: ev, args: { id: IDS }, fromBlock: a, toBlock: b })));
    }
    const ts = new Map();
    const tsOf = async (n) => { if (!ts.has(n)) ts.set(n, Number((await c.getBlock({ blockNumber: n })).timestamp)); return ts.get(n); };
    for (const id of IDS) {
      const d = await c.readContract({ address: LEDGER, abi: O.LEDGER_ABI, functionName: "get", args: [id], blockNumber });
      const r = await c.readContract({ address: RESERVE, abi: O.OWNER_ABI, functionName: "reserveOf", args: [id, d.owner], blockNumber });
      out.apps[id] = { rate6: String(d.rate), balance6: String(d.balance6), leaseUntil: Number(d.leaseUntil), renewWindow: Number(r.renewWindow),
        minExtension: Number(r.minExtension), enabled: r.enabled, events: [] };
    }
    for (const l of logs.sort((x, y) => Number(x.blockNumber - y.blockNumber) || x.logIndex - y.logIndex)) {
      const t = await tsOf(l.blockNumber);
      out.apps[l.args.id.toLowerCase()]?.events.push({ kind: l.eventName, block: String(l.blockNumber), t, leaseUntil: Number(l.args.leaseUntil), newRemaining: Number(l.args.leaseUntil) - t });
    }
    for (const a of Object.values(out.apps)) {
      const ev = a.events, cycles = [], lead = [], gained = [];
      for (let i = 1; i < ev.length; i++) {
        if (ev[i].kind !== "Renewed" || ev[i - 1].leaseUntil < ev[i].t) continue;   // only renewals of a still-live lease
        lead.push(ev[i - 1].leaseUntil - ev[i].t); cycles.push(ev[i].t - ev[i - 1].t); gained.push(ev[i].leaseUntil - ev[i - 1].leaseUntil);
      }
      const st = (xs) => xs.length ? { n: xs.length, min: Math.min(...xs), max: Math.max(...xs), median: [...xs].sort((x, y) => x - y)[xs.length >> 1] } : null;
      a.summary = { landingLeadSec: st(lead), cycleSec: st(cycles), leaseUntilAdvanceSec: st(gained), newRemainingSec: st(ev.filter((e) => e.kind === "Renewed").map((e) => e.newRemaining)) };
      delete a.events;   // the summary is the evidence; the raw logs are re-readable from the block range
    }
    lastErr = null; break;
  } catch (e) { lastErr = String(e.shortMessage || e.message).slice(0, 300); out.errors = [...(out.errors || []), { url, error: lastErr }]; }
}
const file = new URL(`./cadence-probe-${out.at.replace(/[:.]/g, "").slice(0, 15)}Z.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
console.log(file.pathname, lastErr ? "ERROR " + lastErr : "ok");
