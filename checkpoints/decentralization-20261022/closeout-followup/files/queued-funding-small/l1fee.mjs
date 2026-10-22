// l1fee.mjs: READ-ONLY - Base GasPriceOracle getL1FeeUpperBound for the proposal's unsigned size (call data + 100-byte envelope bound)
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module"; import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url)); const req = createRequire(path.resolve(HERE, "../../enclave/package.json"));
const { createPublicClient, http, parseAbi } = await import(req.resolve("viem")); const { base } = await import(req.resolve("viem/chains"));
const p = JSON.parse(fs.readFileSync(path.join(HERE, "batch-proposal.json"), "utf8")); const size = BigInt((p.data.length - 2) / 2 + 100);
const abi = parseAbi(["function getL1FeeUpperBound(uint256) view returns (uint256)"]);
const out = [];
for (const url of ["https://mainnet.base.org", "https://base-rpc.polkachu.com"]) {
  const c = createPublicClient({ chain: base, transport: http(url, { retryCount: 0, timeout: 20000 }) });
  try { const b = await c.getBlockNumber(); out.push({ rpc: url, block: String(b), sizeBytes: String(size), l1FeeUpperBoundWei: String(await c.readContract({ address: "0x420000000000000000000000000000000000000F", abi, functionName: "getL1FeeUpperBound", args: [size], blockNumber: b })) }); }
  catch (e) { out.push({ rpc: url, error: String(e?.shortMessage || e?.message).slice(0, 160) }); }
}
fs.writeFileSync(path.join(HERE, "l1-fee.json"), JSON.stringify({ at: new Date().toISOString(), out }, null, 2) + "\n"); console.log(JSON.stringify(out));
