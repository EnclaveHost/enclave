// READ-ONLY fresh evidence collector for batch-topup.mjs (prepared for ROOT; never executed against a chain by its author).
// Usage: node collect-evidence.mjs <manifest.json> <rpcUrl1> <rpcUrl2> [rpcUrl3...] > evidence.json
// Reads, at ONE block (min head - 2) on every RPC: chainId, block hash/timestamp, keccak(code) of canonical Multicall3,
// the reserve and the ledger, reserve.paused(), and per manifest row ledger.get(id) + reserveOf(id, CURRENT owner) +
// blockedDeployment(id). No signing, no transaction, no state change. batch-topup.mjs decides; this only reports.
import { createRequire } from "node:module";
import fs from "node:fs";
import { RESERVE, LEDGER, MULTICALL3, CHAIN_ID, EVIDENCE_FORMAT } from "./batch-topup.mjs";

const req = createRequire(new URL("../../enclave/package.json", import.meta.url));
const { keccak256 } = await import(req.resolve("viem"));
const { OWNER_ABI, LEDGER_ABI } = await import(new URL("../../enclave/network/lease-gas-owner.mjs", import.meta.url));

/** clients: [{ url, client }] where client has viem PublicClient's getChainId/getBlockNumber/getBlock/getCode/readContract. */
export async function collectEvidence({ manifest, clients, now = () => new Date() }) {
  const heads = await Promise.allSettled(clients.map(async ({ client }) => {
    if (await client.getChainId() !== CHAIN_ID) throw new Error("chain mismatch");
    return client.getBlockNumber();
  }));
  const live = heads.flatMap((h, i) => (h.status === "fulfilled" ? [{ i, head: h.value }] : []));
  if (live.length < 2) throw new Error("fewer than two RPCs answered");
  const blockNumber = live.reduce((n, x) => (x.head < n ? x.head : n), live[0].head) - 2n;
  const reads = await Promise.all(clients.map(async ({ url, client: c }, i) => {
    if (!live.some((x) => x.i === i)) return { rpc: url, error: String(heads[i].reason?.message || heads[i].reason).slice(0, 160) };
    try {
      const at = { blockNumber };
      const rd = (address, abi, functionName, args = []) => c.readContract({ address, abi, functionName, args, ...at });
      const [b, mc, rc, lcode, paused] = await Promise.all([c.getBlock(at), c.getCode({ address: MULTICALL3, ...at }),
        c.getCode({ address: RESERVE, ...at }), c.getCode({ address: LEDGER, ...at }), rd(RESERVE, OWNER_ABI, "paused")]);
      const rows = [];
      for (const r of manifest.rows) {
        const d = await rd(LEDGER, LEDGER_ABI, "get", [r.id]);
        const [rv, blocked] = await Promise.all([rd(RESERVE, OWNER_ABI, "reserveOf", [r.id, d.owner]), rd(RESERVE, OWNER_ABI, "blockedDeployment", [r.id])]);
        rows.push({ id: r.id, ledgerId: d.id, owner: d.owner, active: d.active, enabled: rv.enabled, blocked, balanceWei: String(rv.balanceWei) });
      }
      return { rpc: url, chainId: CHAIN_ID, blockNumber: String(blockNumber), blockHash: b.hash, timestamp: String(b.timestamp),
        multicall3CodeHash: keccak256(mc || "0x"), reserveCodeHash: keccak256(rc || "0x"), ledgerCodeHash: keccak256(lcode || "0x"),
        reservePaused: paused, rows };
    } catch (e) { return { rpc: url, error: String(e?.shortMessage || e?.message || e).slice(0, 160) }; }
  }));
  return { format: EVIDENCE_FORMAT, chainId: CHAIN_ID, collectedAt: now().toISOString(), reads };
}

if (process.argv[1] && new URL(import.meta.url).pathname === fs.realpathSync(process.argv[1])) {
  const [manifestPath, ...urls] = process.argv.slice(2);
  if (!manifestPath || urls.length < 2) { console.error("usage: collect-evidence.mjs <manifest.json> <rpc1> <rpc2> [rpc3...]"); process.exit(2); }
  const { createPublicClient, http } = await import(req.resolve("viem"));
  const { base } = await import(req.resolve("viem/chains"));
  const clients = urls.map((url) => ({ url, client: createPublicClient({ chain: base, transport: http(url, { retryCount: 0, timeout: 10_000 }) }) }));
  const ev = await collectEvidence({ manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")), clients });
  console.log(JSON.stringify(ev, null, 2));
}
