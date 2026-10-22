// READ-ONLY: which eth_getLogs block ranges the measured public RPCs accept for the live ledger's lease events.
const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"];
const LEDGER = "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b";
const T = ["0xa8cc21eb0ec0b0b7328426babbe37866c627edfd2ae57aeaed4f54abc0534bc0", "0xc3f167f2092d6942fb4264b1759de5eda7eedc20287375c9eddd62e98a560b3e", "0x0e334fd11ab7bea6d2bda89338c0f25674e099b70dd28aaaee262fbecba48882"];
const call = async (u, method, params) => { const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20000) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { throw new Error(`HTTP ${r.status} ${t.slice(0, 80)}`); } if (j.error) throw new Error(`${j.error.code}: ${j.error.message}`); return j.result; };
const out = [];
const head = 52858000, start = 52515705;
for (const u of RPCS) for (const span of [1000, 2000, 5000, 10000]) {
  const lo = head - span + 1;
  try { const r = await call(u, "eth_getLogs", [{ address: LEDGER, fromBlock: "0x" + lo.toString(16), toBlock: "0x" + head.toString(16), topics: [T] }]); out.push({ rpc: new URL(u).host, span, ok: true, logs: r.length }); }
  catch (e) { out.push({ rpc: new URL(u).host, span, ok: false, error: e.message.slice(0, 140) }); }
  await new Promise((r) => setTimeout(r, 300));
}
for (const u of RPCS.slice(0, 2)) {   // the oldest history: the ledger's first 1000 blocks
  try { const r = await call(u, "eth_getLogs", [{ address: LEDGER, fromBlock: "0x" + start.toString(16), toBlock: "0x" + (start + 999).toString(16), topics: [T] }]); out.push({ rpc: new URL(u).host, oldest: true, ok: true, logs: r.length }); }
  catch (e) { out.push({ rpc: new URL(u).host, oldest: true, ok: false, error: e.message.slice(0, 140) }); }
}
console.log(JSON.stringify(out, null, 1));
