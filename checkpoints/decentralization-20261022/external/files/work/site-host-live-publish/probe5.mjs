#!/usr/bin/env node
// READ-ONLY: the catalog's runtime code hash (pinned by the site handoff), agreed by 2 of 4 public RPCs. Writes logs/probe5.json.
import fs from "node:fs";
import path from "node:path";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const { createPublicClient, http, keccak256 } = await import(path.resolve(HERE, "../enclave/node_modules/viem/_esm/index.js"));
const RPCS = ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base", "https://mainnet.base.org"];
const CATALOG = "0x18419CA2b502D423A8de6269AEeE171a378626e3";
const got = await Promise.allSettled(RPCS.map((u) => createPublicClient({ transport: http(u, { timeout: 15000 }) }).getCode({ address: CATALOG })));
const hashes = got.map((g) => g.status === "fulfilled" && g.value ? keccak256(g.value) : null);
const t = {}; for (const h of hashes) if (h) t[h] = (t[h] || 0) + 1;
const best = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
if (!best || best[1] < 2) throw new Error("no 2-RPC agreement on the catalog code");
fs.writeFileSync(path.join(HERE, "logs/probe5.json"), JSON.stringify({ at: new Date().toISOString(), catalog: CATALOG, codeHash: best[0], agree: best[1], of: RPCS.length }) + "\n");
console.log("probe5: catalog code hash", best[0], "agree", best[1]);
