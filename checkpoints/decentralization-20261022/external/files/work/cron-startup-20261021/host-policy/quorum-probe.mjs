// Public, read-only measurement of the EXACT quorum mechanism the host wallet policy uses (network/lease-reader.mjs
// LeaseReader.agreed, the same defaults: 5 RPCs, confirmations 2, maxBlockAge 90 s, deadline 30 s, 14 s per request, retry
// only on 429), from warden-host, which shares minipc's single public egress IP (so the same per-IP RPC limits). One light
// read per round (the address book's all(), a public view call). Records outcome, time and the per-RPC FAILURE reasons
// that the production error message drops. No key, no write, no host contact.
import { LeaseReader } from "../../enclave/network/lease-reader.mjs";
const RPCS = ["https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co", "https://base-public.nodies.app", "https://base.drpc.org", "https://mainnet.base.org"];
const BOOK = "0xab214342d5A490150A4A977063A2f88E21F80907";
const ABI = [{ type: "function", name: "all", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32[]" }, { type: "address[]" }] }];
const rounds = Number(process.argv[2] || 16), gapMs = Number(process.argv[3] || 15000);
const r = new LeaseReader({ rpc: RPCS, addressBook: BOOK });
const out = [];
for (let i = 0; i < rounds; i++) {
  const failures = [], t0 = Date.now();
  try {
    const v = await r.agreed(async (c, blockNumber) => { const [k] = await c.readContract({ address: BOOK, abi: ABI, functionName: "all", blockNumber }); return { keys: k.length }; }, failures);
    out.push({ at: new Date(t0).toISOString(), ok: true, ms: Date.now() - t0, block: v.blockNumber, failures });
  } catch (e) { out.push({ at: new Date(t0).toISOString(), ok: false, ms: Date.now() - t0, error: e.message, failures }); }
  const l = out.at(-1); console.log(`${l.at} ${l.ok ? "OK " : "ERR"} ${l.ms}ms ${l.error || ""} failures=${JSON.stringify(l.failures).slice(0, 300)}`);
  if (i < rounds - 1) await new Promise((res) => setTimeout(res, gapMs));
}
// per-RPC head health, sequential, once each (the head step the "chain quorum unavailable" message is about)
const heads = [];
for (const u of RPCS) {
  const t0 = Date.now();
  try { const res = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] }]), signal: AbortSignal.timeout(14000) });
    const txt = await res.text(); heads.push({ host: new URL(u).host, status: res.status, ms: Date.now() - t0, body: txt.slice(0, 160).replace(/0x[0-9a-f]{6,}/gi, "0x…") }); }
  catch (e) { heads.push({ host: new URL(u).host, error: e.name + ": " + String(e.message).slice(0, 120), ms: Date.now() - t0 }); }
}
console.log(JSON.stringify(heads, null, 1));
const fs = await import("node:fs");
fs.writeFileSync(new URL("./quorum-probe.json", import.meta.url), JSON.stringify({ rpcs: RPCS.map((u) => new URL(u).host), rounds: out, heads }, null, 1) + "\n");
