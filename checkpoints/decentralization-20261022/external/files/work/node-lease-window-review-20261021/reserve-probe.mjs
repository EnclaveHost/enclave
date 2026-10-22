// READ-ONLY (no signing, no sends): for each app, the reserve that paid its LATEST renewal (the LeaseGasPaid log in that
// renewal's receipt), the reserve's ledger() binding, and reserveOf(id, owner): renewWindow and the rest of the app's
// policy. Input: a chain-probe JSON (its latest Renewed tx per app). Output: reserve-probe-<ts>.json.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(new URL("../enclave/package.json", import.meta.url));
const { createPublicClient, http, decodeEventLog, getAddress } = require("viem");
const { base } = require("viem/chains");
const { RESERVE_ABI } = await import(new URL("../enclave/client/lease-executor-client.mjs", import.meta.url));

const probe = JSON.parse(readFileSync(process.argv[2], "utf8"));
const src = probe.rpcs[process.argv[3] || "https://base-rpc.polkachu.com"].events;
const RPCS = ["https://base-rpc.polkachu.com", "https://base.gateway.tenderly.co"];
const out = { at: new Date().toISOString(), input: process.argv[2], rpcs: {} };
for (const url of RPCS) {
  const r = (out.rpcs[url] = { apps: {} });
  try {
    const c = createPublicClient({ chain: base, transport: http(url, { retryCount: 1, timeout: 20_000 }) });
    for (const [id, evs] of Object.entries(src)) {
      const last = [...evs].reverse().find((e) => e.kind === "Renewed"); const a = (r.apps[id] = { tx: last.tx });
      const rc = await c.getTransactionReceipt({ hash: last.tx });
      const paid = [];
      for (const l of rc.logs) {
        try { const d = decodeEventLog({ abi: RESERVE_ABI, data: l.data, topics: l.topics });
              if (d.eventName === "LeaseGasPaid") paid.push({ reserve: getAddress(l.address), owner: d.args.owner, operator: d.args.operator, kind: Number(d.args.kind) }); } catch {}
      }
      a.leaseGasPaid = paid; a.txTo = rc.to;
      if (!paid.length) continue;
      const res = paid[0].reserve;
      a.reserveLedger = await c.readContract({ address: res, abi: RESERVE_ABI, functionName: "ledger" });
      const p = await c.readContract({ address: res, abi: RESERVE_ABI, functionName: "reserveOf", args: [id, paid[0].owner] });
      a.reserveOf = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v]));
    }
  } catch (e) { r.error = String(e.shortMessage || e.message).slice(0, 300); }
}
const file = new URL(`./reserve-probe-${out.at.replace(/[:.]/g, "").slice(0, 15)}Z.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 1) + "\n"); console.log(file.pathname);
