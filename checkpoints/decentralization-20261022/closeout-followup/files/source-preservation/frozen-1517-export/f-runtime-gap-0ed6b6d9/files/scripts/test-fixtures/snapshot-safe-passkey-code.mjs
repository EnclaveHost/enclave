// READ-ONLY snapshot of the PINNED Safe v1.4.1 / Safe passkey signer v0.2.1 / Safe4337Module / EntryPoint v0.7 / MultiSend
// runtime code on Base (site/js/core/account-providers.js PROVIDERS["safe-passkey"].contracts), plus the passkey signer
// singleton the pinned WebAuthn signer factory names, for etching onto a LOCAL test chain (test/helpers/safe-passkey-code.mjs).
// Tests never read Base; this script is the only network path, run by hand. Same rules as snapshot-safe-code.mjs:
// eth_chainId / eth_blockNumber / eth_getCode / eth_call only, at ONE block, to TWO public RPCs that must return identical
// bytes; every pinned contract's keccak256 must equal its reviewed codeHash pin, and the signer singleton's address must be
// embedded in the pinned factory's code, or nothing is written. Every request is bounded (10 s, 2 MiB). No key, no transaction.
//   usage: node scripts/test-fixtures/snapshot-safe-passkey-code.mjs   (writes test/fixtures/base-code/safe-passkey-code-base.json)
import fs from "node:fs";
import crypto from "node:crypto";
import { keccak256, toBytes } from "viem";

const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];
const SRC = new URL("../../site/js/core/account-providers.js", import.meta.url);
const src = fs.readFileSync(SRC, "utf8");
const block0 = src.indexOf('"safe-passkey": Object.freeze({'), end = src.indexOf("sources:", block0);
if (block0 < 0 || end < 0) throw new Error("safe-passkey provider block not found in account-providers.js");
const pins = [...src.slice(block0, end).matchAll(/(\w+):\s*\{\s*address:\s*"(0x[0-9a-f]{40})",\s*codeHash:\s*"(0x[0-9a-f]{64})"\s*\}/g)]
  .map((m) => ({ name: m[1], address: m[2], codeHash: m[3] }));
if (pins.length < 10) throw new Error("expected the pinned safe-passkey contracts, found " + pins.length);
const pinBlock = Number(/export const PIN_BLOCK = (\d+);/.exec(src)?.[1]);

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
const entry = (address, code) => { const bytes = Buffer.from(code.slice(2), "hex");
  return { address, runtimeBytes: bytes.length, keccak256: keccak256(code), sha256: crypto.createHash("sha256").update(bytes).digest("hex"), code }; };
const out = { at: new Date().toISOString(), chainId: 8453, block: Number(BigInt(block)), rpcs: RPCS,
  pinsFrom: `site/js/core/account-providers.js PROVIDERS["safe-passkey"].contracts (PIN_BLOCK ${pinBlock})`, contracts: {} };
for (const p of pins) {
  const code = await agree("eth_getCode", [p.address, block]);
  if (!code || code === "0x") throw new Error(`${p.name} has no code at ${block}`);
  const e = entry(p.address, code);
  if (e.keccak256 !== p.codeHash) throw new Error(`${p.name}: code ${e.keccak256} is not the pinned ${p.codeHash}; nothing written`);
  out.contracts[p.name] = { codeHashPin: p.codeHash, ...e };
}
// the signer singleton: no pin of its own; its address is the pinned factory's immutable SINGLETON (checked in the factory's
// pinned code), its bytes are recorded with the same two-RPC agreement
const factory = out.contracts.webauthnSignerFactory;
const ret = await agree("eth_call", [{ to: factory.address, data: keccak256(toBytes("SINGLETON()")).slice(0, 10) }, block]);
const singleton = "0x" + ret.slice(26);
if (!factory.code.toLowerCase().includes(singleton.slice(2).toLowerCase())) throw new Error("the singleton address is not embedded in the pinned factory code");
const scode = await agree("eth_getCode", [singleton, block]);
if (!scode || scode === "0x") throw new Error("the signer singleton has no code");
out.signerSingleton = { via: "webauthnSignerFactory.SINGLETON() at the snapshot block; address embedded in the factory's pinned code", codeHashPin: null, ...entry(singleton, scode) };
fs.writeFileSync(new URL("../../test/fixtures/base-code/safe-passkey-code-base.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
for (const [n, c] of Object.entries(out.contracts)) console.log(n, c.address, c.runtimeBytes, "bytes", c.keccak256, "= pin");
console.log("signerSingleton", singleton, out.signerSingleton.runtimeBytes, "bytes", out.signerSingleton.keccak256, "block", out.block);
