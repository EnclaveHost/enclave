// ONE bounded read-only probe for root's publication request (2026-10-23): at most 12 JSON-RPC requests, hard-capped
// here; no broad scan, no signing, no write. Both reviewed RPCs, one block number (the lower head minus 2):
//   2 eth_blockNumber, 2 book.addr("appCatalog"), 2 book.addr("deployments"), 2 eth_getCode(catalog) (hashed, never
//   stored), 2 catalog.numVersions(keccak(admin‖slug)), 2 catalog.cidStatus(component CID). -> evidence/live-readonly.json
import fs from "node:fs";
import { encodeFunctionData, decodeFunctionResult, keccak256, stringToHex } from "viem";
import { PRODUCTION as P, CATALOG_ABI, request, httpRpc } from "../lib/publish.mjs";

const MAX = 12, counter = { n: 0 };
const base = httpRpc(15_000, counter);
const rpc = (u, m, p) => { if (counter.n >= MAX) throw new Error("request budget exhausted"); return base(u, m, p); };
const both = (m, p) => Promise.all(P.rpcs.map((u) => rpc(u, m, p)));
const BOOK = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] }];
const heads = (await both("eth_blockNumber", [])).map(BigInt);
const n = (heads[0] < heads[1] ? heads[0] : heads[1]) - 2n, tag = "0x" + n.toString(16);
const call = async (to, abi, fn, args) => (await both("eth_call", [{ to, data: encodeFunctionData({ abi, functionName: fn, args }) }, tag]))
  .map((d) => decodeFunctionResult({ abi, functionName: fn, data: d }));
const s = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? v.toString() : v));
const appCatalog = await call(P.book, BOOK, "addr", [stringToHex("appCatalog", { size: 32 })]);
const deployments = await call(P.book, BOOK, "addr", [stringToHex("deployments", { size: 32 })]);
const codes = (await both("eth_getCode", [P.catalog, tag])).map((c) => keccak256(c));
const appId = request().appId;
const versions = await call(P.catalog, CATALOG_ABI, "numVersions", [appId]);
const cid = await call(P.catalog, CATALOG_ABI, "cidStatus", [P.request.cid]);
const agree = (a) => s(a[0]) === s(a[1]);
const out = {
  at: new Date().toISOString(), readOnly: true, requests: counter.n, rpcs: P.rpcs.map((u) => new URL(u).host), block: n.toString(),
  book: { address: P.book, appCatalog: appCatalog.map((x) => x.toLowerCase()), deployments: deployments.map((x) => x.toLowerCase()) },
  catalog: { address: P.catalog, codeHash: codes, codeHashMatchesReviewed: codes.every((h) => h === P.catalogCodeHash) },
  listing: { slug: P.request.slug, appId, numVersions: versions.map(String), cidListed: cid.map((r) => r[0]) },
  agree: { appCatalog: agree(appCatalog), deployments: agree(deployments), codeHash: agree(codes), numVersions: agree(versions), cid: agree(cid) },
};
out.ok = Object.values(out.agree).every(Boolean) && out.book.appCatalog[0] === P.catalog && out.book.deployments[0] === P.ledger
  && out.catalog.codeHashMatchesReviewed && out.listing.numVersions[0] === "0" && out.listing.cidListed[0] === false;
fs.writeFileSync(new URL("../evidence/live-readonly.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
