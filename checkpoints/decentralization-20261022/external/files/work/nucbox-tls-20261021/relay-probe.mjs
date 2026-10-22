// READ-ONLY, public, bounded (~70 s): is the API relay's route map flapping, and how close are the three leases to lapsing?
//   - the route map sampled 6x, 10 s apart (labels and pending, updatedAt)
//   - relay /health each sample
//   - the ledger rows of 59f1273d / d9798e4c / 7ae476a3 on Base (two RPCs, same block): leaseUntil - block time, runner, active
import fs from "node:fs";
import { createPublicClient, http } from "../enclave/node_modules/viem/_esm/index.js";
import { base } from "../enclave/node_modules/viem/_esm/chains/index.js";
const { ENROLLMENT } = await import("../lease-enrollment-signing/trust.mjs");
const IDS = { "59f1273d": "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c",
  "d9798e4c": "0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a", "7ae476a3": "0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33" };
const out = { at: new Date().toISOString(), samples: [] };
const get = async (u) => { const t0 = Date.now(); try { const r = await fetch(u, { signal: AbortSignal.timeout(15000) }); return { status: r.status, json: await r.json().catch(() => null), s: (Date.now() - t0) / 1000 }; } catch (e) { return { error: e.message, s: (Date.now() - t0) / 1000 }; } };
for (let i = 0; i < 6; i++) {
  if (i) await new Promise((r) => setTimeout(r, 10_000));
  const [rm, h] = await Promise.all([get("https://api.enclave.host/v1/network/routes"), get("https://api.enclave.host/health")]);
  out.samples.push({ at: new Date().toISOString().slice(11, 19), routes: rm.json ? { updatedAt: rm.json.updatedAt?.slice(11, 19), labels: Object.keys(rm.json.labels || {}),
    pending: (rm.json.pending || []).map((p) => `${p.id.slice(2, 10)}:${p.reason}`) } : rm, health: h.json ? { ok: h.json.ok, enclaves: h.json.enclaves, of: h.json.of } : h });
}
const abi = JSON.parse(fs.readFileSync(new URL("../enclave/contracts/EnclaveDeployments.abi.json", import.meta.url), "utf8"));
out.leases = {};
try {
  const cs = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"].map((u) => createPublicClient({ chain: base, transport: http(u, { timeout: 15000 }) }));
  const bn = (await Promise.all(cs.map((c) => c.getBlockNumber()))).reduce((a, b) => (a < b ? a : b)) - 2n;
  const blk = await cs[0].getBlock({ blockNumber: bn });
  for (const [k, id] of Object.entries(IDS)) {
    const rows = await Promise.all(cs.map((c) => c.readContract({ address: ENROLLMENT.ledger, abi, functionName: "get", args: [id], blockNumber: bn })));
    out.leases[k] = { block: String(bn), agree: rows[0].leaseUntil === rows[1].leaseUntil && rows[0].runner === rows[1].runner, active: rows[0].active,
      runnerIsNucbox: rows[0].runner.toLowerCase().startsWith("0x2fcef48d"), leaseUntil: new Date(Number(rows[0].leaseUntil) * 1000).toISOString(),
      leftS: Number(rows[0].leaseUntil) - Number(blk.timestamp) };
  }
} catch (e) { out.leases.error = String(e.shortMessage || e.message).slice(0, 200); }
fs.writeFileSync(new URL("./relay-probe.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
