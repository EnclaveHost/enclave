// READ-ONLY probe (no transactions, no keys): Base finality lag on the measured public RPCs, and the live 16d ledger's
// creation block (binary search on eth_getCode where the RPC serves historical state).
const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"];
const LEDGER = "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b";
const call = async (u, method, params) => { const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10000) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
const out = { at: new Date().toISOString(), finality: [] };
for (const u of RPCS) {
  try { const [l, f, s] = await Promise.all(["latest", "finalized", "safe"].map((t) => call(u, "eth_getBlockByNumber", [t, false])));
    out.finality.push({ rpc: new URL(u).host, latest: Number(l.number), finalized: Number(f.number), safe: Number(s.number), lagBlocks: Number(l.number) - Number(f.number), lagSec: Number(l.timestamp) - Number(f.timestamp) }); }
  catch (e) { out.finality.push({ rpc: new URL(u).host, error: e.message.slice(0, 120) }); }
}
for (const u of RPCS) {
  try {
    let lo = 52286274, hi = Number(await call(u, "eth_blockNumber", []));
    if ((await call(u, "eth_getCode", [LEDGER, "0x" + lo.toString(16)])) !== "0x") { out.creation = { rpc: new URL(u).host, note: "code present at the lower bound" }; break; }
    while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); ((await call(u, "eth_getCode", [LEDGER, "0x" + m.toString(16)])) !== "0x") ? hi = m : lo = m; }
    out.creation = { rpc: new URL(u).host, firstBlockWithCode: hi }; break;
  } catch (e) { out.creationErrors = [...(out.creationErrors || []), `${new URL(u).host}: ${e.message.slice(0, 100)}`]; }
}
console.log(JSON.stringify(out, null, 1));
