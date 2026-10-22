#!/usr/bin/env node
// Read-only compatibility probe of the owner-chosen public Base RPCs, with plain Node HTTPS (not the wasm path):
// chain identity, heads, agreement on one block, EIP-1898 reads ({blockHash, requireCanonical}) of a pinned contract's
// code and state, and the refusal of an unknown blockHash (a provider that answered it from "latest" would break
// hash-bound authority). No keys, no transactions.
//
//   node probe/rpc-probe.mjs [--profile FILE] [--out FILE] [--confirmations N]
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO, WORKSPACE_PROFILE } from "../lib/paths.mjs";
const WS = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(REPO, "package.json"));
const { keccak256 } = require("viem");

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const profilePath = arg("--profile", WORKSPACE_PROFILE);
const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const CONF = Number(arg("--confirmations", "6"));
const ledger = profile.contracts.deployments;
const SCHEMA_SEL = keccak256(new TextEncoder().encode("deploymentsSchema()")).slice(0, 10);

let id = 1;
async function call(url, method, params) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { return { ok: false, ms: Date.now() - t0, http: r.status, error: `non-JSON (${text.slice(0, 80)})` }; }
    if (j.error) return { ok: false, ms: Date.now() - t0, http: r.status, error: `${j.error.code}: ${String(j.error.message).slice(0, 160)}` };
    return { ok: true, ms: Date.now() - t0, http: r.status, result: j.result };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e?.cause?.code ?? e?.message ?? e).slice(0, 160) };
  }
}

const hosts = profile.review.rpcHosts;
const out = { kind: "rpc-probe", path: "native-node-https (fetch/undici, OS resolver, direct TCP; NOT wasm, NOT fleet SOCKS)",
  profile: { file: profilePath.replace(WS + "/", ""), chainId: profile.chainId, rpcHosts: hosts },
  pinned: { contract: "deployments", address: ledger.address, codeHash: ledger.codeHash, expectSchema: ledger.immutable.deploymentsSchema },
  confirmations: CONF, startedAt: new Date().toISOString(), providers: {} };

// A. identity and heads
for (const h of hosts) {
  const url = `https://${h}`;
  const p = (out.providers[h] = { url });
  p.chainId = await call(url, "eth_chainId", []);
  p.head = await call(url, "eth_blockNumber", []);
  p.clientVersion = await call(url, "web3_clientVersion", []);
}
const heads = hosts.map((h) => out.providers[h].head).filter((x) => x.ok).map((x) => Number(BigInt(x.result))).sort((a, b) => b - a);
out.heads = heads;
const k = 2;
const target = heads.length >= k ? heads[k - 1] - CONF : null;
out.target = target;

// B. agreement on the target block; C. EIP-1898 reads by its hash
const blocks = {};
for (const h of hosts) {
  const p = out.providers[h];
  if (target == null) break;
  const b = await call(p.url, "eth_getBlockByNumber", ["0x" + target.toString(16), false]);
  p.block = b.ok && b.result ? { ok: true, ms: b.ms, number: Number(BigInt(b.result.number)), hash: b.result.hash, timestamp: Number(BigInt(b.result.timestamp)) } : b;
  if (p.block.ok) blocks[p.block.hash] = (blocks[p.block.hash] ?? 0) + 1;
}
out.blockAgreement = blocks;
const agreed = Object.entries(blocks).find(([, n]) => n >= k)?.[0] ?? null;
out.agreedHash = agreed;
for (const h of hosts) {
  const p = out.providers[h];
  if (!agreed) break;
  const at = { blockHash: agreed, requireCanonical: true };
  const code = await call(p.url, "eth_getCode", [ledger.address, at]);
  p.codeByHash = code.ok ? { ok: true, ms: code.ms, bytes: (code.result.length - 2) / 2, codeHash: keccak256(code.result), matchesPin: keccak256(code.result) === ledger.codeHash } : code;
  const st = await call(p.url, "eth_call", [{ to: ledger.address, data: SCHEMA_SEL }, at]);
  p.callByHash = st.ok ? { ok: true, ms: st.ms, deploymentsSchema: Number(BigInt(st.result)) } : st;
  // the same call without requireCanonical (plain EIP-1898 hash form)
  const st2 = await call(p.url, "eth_call", [{ to: ledger.address, data: SCHEMA_SEL }, { blockHash: agreed }]);
  p.callByHashNoCanonicalFlag = st2.ok ? { ok: true, deploymentsSchema: Number(BigInt(st2.result)) } : st2;
  // an unknown block hash MUST be refused, not answered from latest
  const bogus = "0x" + "ab".repeat(32);
  const neg = await call(p.url, "eth_call", [{ to: ledger.address, data: SCHEMA_SEL }, { blockHash: bogus, requireCanonical: true }]);
  // only a "no such block" answer counts as the refusal; a rate limit or transport error proves nothing
  const notFound = (e) => /block not found|unknown block|header not found|not found/i.test(e ?? "");
  p.unknownHashRefused = neg.ok ? { refused: false, answered: neg.result } : { refused: notFound(neg.error), error: neg.error };
  const negCode = await call(p.url, "eth_getCode", [ledger.address, { blockHash: bogus, requireCanonical: true }]);
  p.unknownHashCodeRefused = negCode.ok ? { refused: false, answeredBytes: (negCode.result.length - 2) / 2 } : { refused: notFound(negCode.error), error: negCode.error };
}
out.finishedAt = new Date().toISOString();
const ends = Math.floor(Date.now() / 1000);
const ts = Object.values(out.providers).find((p) => p.block?.ok && p.block.hash === agreed)?.block.timestamp;
out.agreedBlockAgeAtEndSecs = ts ? ends - ts : null;
out.verdict = Object.fromEntries(hosts.map((h) => {
  const p = out.providers[h];
  const ok = p.chainId.ok && Number(BigInt(p.chainId.result)) === profile.chainId && p.block?.ok && p.block.hash === agreed &&
    p.codeByHash?.matchesPin && p.callByHash?.deploymentsSchema === Number(ledger.immutable.deploymentsSchema) && p.unknownHashRefused?.refused && p.unknownHashCodeRefused?.refused;
  return [h, ok ? "compatible" : "NOT compatible"];
}));
const file = arg("--out", null);
if (file) writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
