#!/usr/bin/env node
// READ-ONLY probe 2: ledger schema + an eth_estimateGas SIMULATION of the owner's create() for the minipc option, and
// the exact create calldata the CLI would send (cli/enclave.mjs depsAbiFor + deploy's argument order). No signature,
// no send. Writes logs/probe2.json.
import fs from "node:fs";
import path from "node:path";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const TREE = path.resolve(HERE, "../site-host-final-release/tree");
const P1 = JSON.parse(fs.readFileSync(path.join(HERE, "logs/probe.json"), "utf8"));
const { createPublicClient, http, encodeFunctionData } = await import(path.join(TREE, "node_modules/viem/_esm/index.js"));
const { base } = await import(path.join(TREE, "node_modules/viem/_esm/chains/index.js"));
const cliSrc = fs.readFileSync(path.join(TREE, "cli/enclave.mjs"), "utf8");
const s = cliSrc.indexOf("const depsAbiFor = (tuple, rev) => ["), e = cliSrc.indexOf("\n];", s) + 3;
const depsAbiFor = new Function(cliSrc.slice(s, e) + "; return depsAbiFor;")();
const RPCS = P1.chain.rpcs;
const clients = RPCS.map((u) => createPublicClient({ chain: base, transport: http(u, { timeout: 15000, retryCount: 1 }) }));
async function q(fn, label) {
  const got = await Promise.allSettled(clients.map((c) => fn(c)));
  const vals = got.filter((g) => g.status === "fulfilled").map((g) => JSON.stringify(g.value, (k, v) => typeof v === "bigint" ? v.toString() : v));
  const t = new Map(); for (const v of vals) t.set(v, (t.get(v) || 0) + 1);
  const best = [...t].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 2) throw new Error(`${label}: no 2-RPC agreement; errors: ${got.filter((g) => g.status === "rejected").map((g) => String(g.reason?.shortMessage || g.reason).split("\n")[0]).join(" | ")}`);
  return JSON.parse(best[0]);
}
const ledger = P1.ledger.address, owner = P1.catalog.owner;
const rev = Number(await q((c) => c.readContract({ address: ledger, abi: [{ type: "function", name: "deploymentsSchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "deploymentsSchema" }), "deploymentsSchema"));
const maxGpuMilli = Number(await q((c) => c.readContract({ address: ledger, abi: [{ type: "function", name: "maxGpuMilli", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] }], functionName: "maxGpuMilli" }), "maxGpuMilli").catch(() => 1000));
const abi = depsAbiFor([], rev).filter((f) => f.name === "create");
const appRef = `catalog://${P1.catalog.appIdOfOwnerSlug}/0`;
const options = {};
for (const [name, cpuMilli, isolation, maxRate6] of [["minipc-hyperv", 50, "hyperv-partition-per-app", 3n]]) {
  const envelope = JSON.stringify({ isolation: { require: isolation } });
  const args = [appRef, 0, cpuMilli, 8080, "", true, envelope, "0x0000000000000000000000000000000000000000", 0n, maxRate6];
  const data = encodeFunctionData({ abi, functionName: "create", args });
  let estimate;
  try { estimate = await q((c) => c.estimateGas({ account: owner, to: ledger, data }), "estimate create"); }
  catch (err) { estimate = `simulation failed: ${String(err.message).split("\n")[0]}`; }
  options[name] = { to: ledger, from: owner, function: "create(string,uint16,uint16,uint32,string,bool,string,address,uint256,uint256)",
    args: { appRef, gpuMilli: 0, cpuMilli, appPort: 8080, ports: "", isPublic: true, configCid: envelope, feeRecipient: args[7], feePerSec6: "0", maxRate6: String(maxRate6) },
    data, gasEstimate: estimate };
}
const block = await q((c) => c.getBlockNumber(), "block");
const gasPrice = await q((c) => c.getGasPrice(), "gas price");
const out = { at: new Date().toISOString(), readOnly: true, block, gasPriceWei: gasPrice, ledger, deploymentsSchema: rev, maxGpuMilli, appRef, options };
fs.writeFileSync(path.join(HERE, "logs/probe2.json"), JSON.stringify(out, (k, v) => typeof v === "bigint" ? v.toString() : v, 1) + "\n");
console.log(`probe2: deploymentsSchema ${rev}, create estimate ${JSON.stringify(options["minipc-hyperv"].gasEstimate)}, gas price ${gasPrice}`);
