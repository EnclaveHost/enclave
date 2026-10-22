// find-cutover-block.mjs - READ-ONLY: the cutover marker for audit-chain.mjs. Given the time 20-activate.ps1 finished
// (activatedAt, from its own log line, the minipc clock), find through the RPC quorum the FIRST Base block whose timestamp
// is at or after it (binary search; each probed header agreed by the quorum). Clocks differ between minipc, the workstation
// and the chain, so the marker is defined by the chain's own timestamps, never "the next block I saw".
//   node find-cutover-block.mjs --activated-at 2026-10-21T09:00:00Z [--expectations expectations.json] [--out cutover.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = process.env.ENCLAVE_MAIN || path.resolve(HERE, "../enclave");
const imp = (p) => import(pathToFileURL(path.join(MAIN, p)).href);
const viem = await imp("node_modules/viem/_esm/index.js");
const { leaseRpcSet } = await imp("client/lease-executor-authority.mjs");

export async function findCutoverBlock({ clients, quorum, activatedAt, allowLoopbackHttp = false, timeoutMs = 30_000 }) {
  const t = Math.ceil(Date.parse(activatedAt) / 1000);
  if (!Number.isFinite(t)) throw new Error("--activated-at must be an ISO time");
  const rpc = leaseRpcSet(clients, { quorum, allowLoopbackHttp, timeoutMs });
  const header = async (n) => (await rpc.agree(rpc.peers, async (p) => { const b = await p.client.getBlock(n === null ? {} : { blockNumber: BigInt(n) }); return { number: Number(b.number), timestamp: Number(b.timestamp), hash: String(b.hash).toLowerCase() }; }, `block ${n ?? "head"}`)).value;
  const head = await header(null);
  if (head.timestamp < t) throw new Error(`no block at or after ${activatedAt} yet (head ${head.number} at ${new Date(head.timestamp * 1000).toISOString()}): wait and retry`);
  let lo = 0, hi = head.number;   // invariant: header(hi).timestamp >= t
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if ((await header(mid)).timestamp >= t) hi = mid; else lo = mid + 1; }
  const b = await header(hi);
  return { cutoverBlock: b.number, cutoverBlockHash: b.hash, cutoverBlockTime: new Date(b.timestamp * 1000).toISOString(), activatedAt: new Date(Date.parse(activatedAt)).toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2), opt = {}; for (let i = 0; i < a.length; i += 2) opt[a[i].replace(/^--/, "")] = a[i + 1];
  if (!opt["activated-at"]) { console.error("refused: --activated-at <ISO time 20-activate.ps1 printed ACTIVATED> is required"); process.exit(2); }
  const expect = JSON.parse(fs.readFileSync(opt.expectations || path.join(HERE, "expectations.json"), "utf8"));
  const clients = expect.rpcs.map((url) => viem.createPublicClient({ transport: viem.http(url, { retryCount: 0, timeout: 30_000 }) }));
  const m = await findCutoverBlock({ clients, quorum: expect.quorum, activatedAt: opt["activated-at"] });
  if (opt["activate-started-at"]) m.activateStartedAt = new Date(Date.parse(opt["activate-started-at"])).toISOString();
  const text = JSON.stringify(m, null, 1) + "\n";
  if (opt.out) fs.writeFileSync(opt.out, text, { flag: "wx" });
  console.log(text);
}
