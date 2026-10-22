// READ-ONLY snapshot of the canonical ERC-4337 v0.8 EntryPoint, its SenderCreator and Simple7702Account runtime code
// on Base, for etching onto a LOCAL test chain. Only eth_blockNumber / eth_getCode / eth_call are sent, at ONE pinned
// block, to TWO public RPCs already referenced by the repo; both must return identical bytes or nothing is written.
// No transaction, no signature, no key.   usage: node scripts/snapshot-aa-code.mjs   (cwd: work/app-lease-gas)
import fs from "node:fs";
import crypto from "node:crypto";

const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];
const ADDR = {
  entryPoint08: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",   // the address the repo pins (relay/host-sponsor.mjs, windows/node/sponsor.mjs)
  simple7702Account: "0xe6Cae83BdE06E4c305530e199D7217f42808555B",
};
const rpc = async (url, method, params) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${url} ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};
const head = BigInt(await rpc(RPCS[0], "eth_blockNumber", []));
const block = "0x" + (head - 64n).toString(16);   // a little behind the head, so both RPCs have it
const chainIds = await Promise.all(RPCS.map((u) => rpc(u, "eth_chainId", [])));
if (chainIds.some((c) => c !== "0x2105")) throw new Error("not Base: " + chainIds);
const agree = async (method, params) => {
  const xs = await Promise.all(RPCS.map((u) => rpc(u, method, params)));
  if (xs.some((x) => x !== xs[0])) throw new Error(`RPCs disagree on ${method} ${JSON.stringify(params)}`);
  return xs[0];
};
// EntryPoint v0.8: senderCreator() (selector 0x09ccb880) is an immutable the runtime embeds
const scWord = await agree("eth_call", [{ to: ADDR.entryPoint08, data: "0x09ccb880" }, block]);
ADDR.senderCreator = "0x" + scWord.slice(-40);
const out = { at: new Date().toISOString(), chainId: 8453, block: Number(BigInt(block)), rpcs: RPCS, contracts: {} };
for (const [name, address] of Object.entries(ADDR)) {
  const code = await agree("eth_getCode", [address, block]);
  if (!code || code === "0x") throw new Error(`${name} has no code at ${block}`);
  const bytes = Buffer.from(code.slice(2), "hex");
  out.contracts[name] = { address, runtimeBytes: bytes.length,
    keccak256: null, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), code };
}
// keccak via viem (the codehash an EXTCODEHASH would return)
const { keccak256 } = await import("viem");
for (const c of Object.values(out.contracts)) c.keccak256 = keccak256(c.code);
fs.writeFileSync("fixtures/aa-code-base.json", JSON.stringify(out, null, 1) + "\n");
for (const [n, c] of Object.entries(out.contracts)) console.log(n, c.address, c.runtimeBytes, "bytes", c.keccak256);
console.log("block", out.block);
