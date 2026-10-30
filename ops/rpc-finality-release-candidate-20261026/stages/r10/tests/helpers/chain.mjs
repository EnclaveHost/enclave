// Test helper (PREPARED; run only by root's job): a synthetic Isthmus-shaped L2 header chain whose hashes and output roots are
// computed with the REVIEWED vendor functions, plus a JSON-RPC answerer over it. Used by the JS tests and (via `node chain.mjs`
// --json) by the Python tests' loopback stub. keccak comes from the pinned @noble/hashes (ANCHOR_DEPS_ROOT, see the runner).
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { headerHash, outputRootV0 } from "../../vendor/anchor-bootstrap.mjs";

const root = process.env.ANCHOR_DEPS_ROOT;
if (!root) throw new Error("ANCHOR_DEPS_ROOT must name the dependency root (no implicit resolution)");
const noble = path.join(path.resolve(root), "node_modules/@noble/hashes");     // the same file the harness's authenticate() imports
if (JSON.parse(fs.readFileSync(path.join(noble, "package.json"), "utf8")).version !== "1.8.0") throw new Error("@noble/hashes is not the pinned 1.8.0");
const { keccak_256 } = await import(pathToFileURL(path.join(noble, "sha3.js")).href);
export const keccak = (b) => keccak_256(b);

const h32 = (seed) => "0x" + Buffer.from(keccak(new TextEncoder().encode(String(seed)))).toString("hex");
export function header(n, parentHash, salt = "") {
  return { parentHash, sha3Uncles: h32("u"), miner: "0x4200000000000000000000000000000000000011", stateRoot: h32(`s${n}${salt}`),
    transactionsRoot: h32(`t${n}${salt}`), receiptsRoot: h32(`r${n}${salt}`), logsBloom: "0x" + "00".repeat(256), difficulty: "0x0",
    number: "0x" + n.toString(16), gasLimit: "0x1c9c380", gasUsed: "0x5208", timestamp: "0x" + (1_700_000_000 + 2 * n).toString(16),
    extraData: "0x", mixHash: h32(`m${n}`), nonce: "0x0000000000000000", baseFeePerGas: "0x1", withdrawalsRoot: h32(`w${n}${salt}`),
    blobGasUsed: "0x0", excessBlobGas: "0x0", parentBeaconBlockRoot: h32(`b${n}`), requestsHash: h32("q") };
}
/** headers lo..hi linked by recomputed hashes; `fork` = {at, salt}: from block `at` up, a different (but self-consistent) chain */
export function makeChain(lo, hi, { fork } = {}) {
  const byN = new Map(); let parent = h32(`genesis-parent-${lo}`);
  for (let n = lo; n <= hi; n++) {
    const h = header(n, parent, fork && n >= fork.at ? fork.salt : "");
    const hash = headerHash(h, keccak); byN.set(n, { ...h, hash }); parent = hash;
  }
  return byN;
}
export const outputRootOf = (h) => outputRootV0({ stateRoot: h.stateRoot, messagePasserStorageRoot: h.withdrawalsRoot, blockHash: headerHash(h, keccak) }, keccak);
/** io.l2 over a chain map; `log` records every call; overrides: {chainId, at: {n: header|null}} */
export function rpcOver(byN, { chainId = "0x2105", at = {}, log = [] } = {}) {
  return { log, l2: async (method, params) => {
    log.push([method, ...params]);
    if (method === "eth_chainId") return chainId;
    const n = Number(BigInt(params[0]));
    if (n in at) return at[n];
    return byN.has(n) ? { ...byN.get(n) } : null;
  } };
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href && process.argv[2] === "--json") {
  // node chain.mjs --json LO HI [forkAt salt]: {headers: {n: header}, outputRoots: {n: root}} for the Python stub
  const [lo, hi, at, salt] = process.argv.slice(3);
  const c = makeChain(+lo, +hi, at ? { fork: { at: +at, salt } } : {});
  const out = { headers: {}, outputRoots: {} };
  for (const [n, h] of c) { out.headers[n] = h; out.outputRoots[n] = outputRootOf(h); }
  process.stdout.write(JSON.stringify(out));
}
