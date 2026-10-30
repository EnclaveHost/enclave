// READ-ONLY snapshot of the canonical Safe v1.4.1 (SafeL2 singleton + SafeProxyFactory) runtime code on Base, for etching
// onto a LOCAL test chain (the owner CLI's Safe path is tested against the real Safe code, not a mock). Only
// eth_blockNumber / eth_chainId / eth_getCode / eth_call, at ONE pinned block, to TWO public RPCs; both must return
// identical bytes or nothing is written. Every request is bounded (10 s, 2 MiB). No transaction, no signature, no key.
//   usage: node scripts/test-fixtures/snapshot-safe-code.mjs   (writes test/fixtures/base-code/safe-code-base.json)
import fs from "node:fs";
import crypto from "node:crypto";
import { keccak256 } from "viem";

const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];
const ADDR = {   // safe-global/safe-deployments v1.4.1, canonical (same address on every chain)
  safeL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  safeProxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
};
const rpc = async (url, method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const text = await r.text();
  if (text.length > 2 * 1024 * 1024) throw new Error(`${url}: response too large`);
  const j = JSON.parse(text);
  if (j.error) throw new Error(`${url} ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};
const chainIds = await Promise.all(RPCS.map((u) => rpc(u, "eth_chainId", [])));
if (chainIds.some((c) => c !== "0x2105")) throw new Error("not Base: " + chainIds);
const head = BigInt(await rpc(RPCS[0], "eth_blockNumber", []));
const block = "0x" + (head - 64n).toString(16);
const agree = async (method, params) => {
  const xs = await Promise.all(RPCS.map((u) => rpc(u, method, params)));
  if (xs.some((x) => x !== xs[0])) throw new Error(`RPCs disagree on ${method} ${JSON.stringify(params)}`);
  return xs[0];
};
const out = { at: new Date().toISOString(), chainId: 8453, block: Number(BigInt(block)), rpcs: RPCS, contracts: {} };
for (const [name, address] of Object.entries(ADDR)) {
  const code = await agree("eth_getCode", [address, block]);
  if (!code || code === "0x") throw new Error(`${name} has no code at ${block}`);
  const bytes = Buffer.from(code.slice(2), "hex");
  out.contracts[name] = { address, runtimeBytes: bytes.length, keccak256: keccak256(code), sha256: crypto.createHash("sha256").update(bytes).digest("hex"), code };
}
// SafeProxyFactory.proxyCreationCode() (0x53e5d935): the proxy's init code, as the factory itself deploys it
const ret = await agree("eth_call", [{ to: ADDR.safeProxyFactory, data: "0x53e5d935" }, block]);
const len = Number(BigInt("0x" + ret.slice(66, 130)));
out.proxyCreationCode = "0x" + ret.slice(130, 130 + len * 2);
// VERSION() (0xffa1ad74) of the singleton, for the record
const v = await agree("eth_call", [{ to: ADDR.safeL2, data: "0xffa1ad74" }, block]);
out.version = Buffer.from(v.slice(130, 130 + Number(BigInt("0x" + v.slice(66, 130))) * 2), "hex").toString("utf8");
fs.writeFileSync(new URL("../../test/fixtures/base-code/safe-code-base.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
for (const [n, c] of Object.entries(out.contracts)) console.log(n, c.address, c.runtimeBytes, "bytes", c.keccak256);
console.log("version", out.version, "block", out.block, "proxy init", (out.proxyCreationCode.length - 2) / 2, "bytes");
