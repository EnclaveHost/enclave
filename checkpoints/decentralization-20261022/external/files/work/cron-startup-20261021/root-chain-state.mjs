// READ-ONLY, public, bounded (~70 s): is the API relay's route map flapping, and how close are the three leases to lapsing?
//   - the route map sampled 6x, 10 s apart (labels and pending, updatedAt)
//   - relay /health each sample
//   - the ledger rows of 59f1273d / d9798e4c / 7ae476a3 on Base (two RPCs, same block): leaseUntil - block time, runner, active
import fs from "node:fs";
import { createPublicClient, http } from "../enclave/node_modules/viem/_esm/index.js";
import { base } from "../enclave/node_modules/viem/_esm/chains/index.js";
const { ENROLLMENT } = await import("../lease-enrollment-signing/trust.mjs");
const IDS = {cron: "0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c"};
const out = { at: new Date().toISOString(), samples: [] };
const abi = JSON.parse(fs.readFileSync(new URL("../enclave/contracts/EnclaveDeployments.abi.json", import.meta.url), "utf8"));
out.leases = {};
try {
  const cs = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"].map((u) => createPublicClient({ chain: base, transport: http(u, { timeout: 15000 }) }));
  const bn = (await Promise.all(cs.map((c) => c.getBlockNumber()))).reduce((a, b) => (a < b ? a : b)) - 2n;
  const blk = await cs[0].getBlock({ blockNumber: bn });
  for (const [k, id] of Object.entries(IDS)) {
    const rows = await Promise.all(cs.map((c) => c.readContract({ address: ENROLLMENT.ledger, abi, functionName: "get", args: [id], blockNumber: bn })));
    out.leases[k] = { block: String(bn), agree: rows[0].leaseUntil === rows[1].leaseUntil && rows[0].runner === rows[1].runner, active: rows[0].active,
      runner: rows[0].runner, runnerOperator: rows[0].runnerOperator, appRef: rows[0].appRef, owner: rows[0].owner, leaseUntil: new Date(Number(rows[0].leaseUntil) * 1000).toISOString(),
      leftS: Number(rows[0].leaseUntil) - Number(blk.timestamp) };
  }
} catch (e) { out.leases.error = String(e.shortMessage || e.message).slice(0, 200); }
fs.writeFileSync(new URL("./root-chain-state.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
