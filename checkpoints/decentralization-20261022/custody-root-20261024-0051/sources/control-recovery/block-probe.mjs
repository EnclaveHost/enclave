#!/usr/bin/env node
// READ-ONLY, bounded diagnosis (root's 22:08 review): one block, two RPCs, two requests each, 15 s timeout. Prints the fields
// only one side has and the fields whose values differ (values cut to 80 chars). No key, no transaction.
//   node block-probe.mjs https://A https://B [rounds <= 10, 3 s apart]
const [a, b, k = "1"] = process.argv.slice(2);
const rounds = Math.min(10, Math.max(1, Number(k) | 0));
if (!a || !b || a === b || ![a, b].every((u) => /^https:\/\//.test(u))) throw new Error("two distinct https RPCs");
const call = async (url, method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000), redirect: "error" });
  const j = await r.json(); if (j.error) throw new Error(`${new URL(url).host} ${method}: ${j.error.message}`); return j.result;
};
for (let i = 0; i < rounds; i++) {
if (i) await new Promise((r) => setTimeout(r, 3000));
const heads = (await Promise.all([a, b].map((u) => call(u, "eth_blockNumber", [])))).map(BigInt);
const n = "0x" + ((heads[0] < heads[1] ? heads[0] : heads[1]) - 2n).toString(16);
const [x0, y0] = await Promise.all([a, b].map((u) => call(u, "eth_getBlockByNumber", [n, false])));
if (!x0 || !y0) { console.log(JSON.stringify({ round: i, block: n, heads: heads.map(String), nullA: !x0, nullB: !y0 })); continue; }
const x = x0, y = y0;
const cut = (v) => { const s = JSON.stringify(v); return s === undefined ? "(absent)" : s.length > 80 ? s.slice(0, 80) + `…(${s.length})` : s; };
const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
console.log(JSON.stringify({ round: i, block: n, heads: heads.map(String), orderEqual: JSON.stringify(Object.keys(x)) === JSON.stringify(Object.keys(y)),
  onlyA: keys.filter((k) => !(k in y)), onlyB: keys.filter((k) => !(k in x)),
  differing: Object.fromEntries(keys.filter((k) => k in x && k in y && JSON.stringify(x[k]) !== JSON.stringify(y[k])).map((k) => [k, { a: cut(x[k]), b: cut(y[k]) }])),
  canonical: Object.fromEntries(["number", "hash", "timestamp", "parentHash"].map((k) => [k, x[k] === y[k]])) }));
}
