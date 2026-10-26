// lease-consumer-seams r3 (PREPARED; run only by the root job): the REAL Windows host module windows/node/chain.mjs with its
// REAL windows/node/lease-gas-runtime.bundle.mjs (rebuilt in the candidate; the committed one in the base) - no fixture
// redirect, no anvil. r2 run 0121 showed the r1 fixture never reached a chain read (no operator key: loadOperator() was never
// called; empty bindings: `addresses` was never set), so every claim refused before any HTTP. This fixture meets the real
// prerequisites the host itself sets (host.mjs): the operator key, the address-book bindings equal to the reviewed record,
// and an explicit relay policy. An in-process JSON-RPC stub (globalThis.fetch; no socket is opened) answers the HEALTHY reads - eth_chainId 8453,
// eth_blockNumber, a fresh eth_getBlockByNumber - and refuses every state read (eth_getCode / eth_call). So a claim proceeds
// through verifiedLeaseAuthority's head, block and freshness stages and refuses at EXACTLY its next stage, the binding read:
//   "lease-gas RPC quorum did not agree on the pinned reserve, executor and ledger bindings"
// (client/lease-executor-authority.mjs). The recorded hosts and methods show WHICH client carried those healthy reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { generatePrivateKey } from "viem/accounts";

const hostUrl = new URL("../windows/node/chain.mjs", import.meta.url).href;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lease-seams-win-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const REC = { format: "enclave-lease-gas-deployment/v1", chainId: 8453, reserve: "0x12A3f873041Dec436DaA0085B766a399A6fA3639",
  executor: "0x8900BACA2167873BA2F8a8bAE8b4876E6396d343", reserveCodeHash: "0xcc00efe9c79c17b34ef9edc2720939030834bf168abc52cea14dcb224304a979",
  executorCodeHash: "0xdd893cd48b7c102dc266949d027c33d396a7f8884533ee81b3b2275048ec9ab2", ledger: "0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B",
  registry: "0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC" };
const RECORD = Buffer.from(JSON.stringify(REC));
const DIGEST = "sha256:" + createHash("sha256").update(RECORD).digest("hex");
const RECORD_FILE = path.join(tmp, "deployment.json");
fs.writeFileSync(RECORD_FILE, RECORD);
const LEASE_RPC_HOSTS = ["lease-rpc-one.example", "lease-rpc-two.example", "lease-rpc-three.example"];
const VERIFIER = "http://127.0.0.1:59321/", VERIFIER_HOST = "127.0.0.1:59321";
const ID = "0x" + "ab".repeat(32), ENCLAVE = "0x" + "cd".repeat(32);
const BINDINGS_REFUSAL = "app-funded claim not sent: lease-gas RPC quorum did not agree on the pinned reserve, executor and ledger bindings; this host's ETH is never used instead";
const UNREADABLE = "app-funded claim not sent: lease-gas RPC quorum cannot read the configured chain; this host's ETH is never used instead";

const seen = [];                                  // {host, method}
const HEAD = 0x1234567n;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  const one = (req) => {
    seen.push({ host: url.host, method: req.method });
    const ok = (result) => ({ jsonrpc: "2.0", id: req.id, result });
    if (req.method === "eth_chainId") return ok("0x2105");
    if (req.method === "eth_blockNumber") return ok("0x" + HEAD.toString(16));
    if (req.method === "eth_getBlockByNumber") {
      const n = String(req.params?.[0] ?? "0x" + HEAD.toString(16));
      const num = /^0x[0-9a-f]+$/i.test(n) ? n : "0x" + HEAD.toString(16);
      return ok({ number: num, hash: "0x" + createHash("sha256").update(num).digest("hex"), parentHash: "0x" + "00".repeat(32),
        timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16), baseFeePerGas: "0x1", gasLimit: "0x1c9c380", transactions: [] });
    }
    return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: `lease-seams stub: ${req.method} is not served` } };
  };
  const out = Array.isArray(body) ? body.map(one) : one(body);
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
};
process.on("exit", () => { globalThis.fetch = realFetch; });

const BASE_ENV = { ...process.env };
let serial = 0;
async function host(extra) {
  for (const k of Object.keys(process.env)) if (/^(ENCLAVE_)?LEASE_GAS_|^ENCLAVE_CHAIN_/.test(k)) delete process.env[k];
  Object.assign(process.env, {
    BASE_RPCS: "https://base-rpc-host.example", NODE_OPERATOR_KEY: generatePrivateKey(),
    ENCLAVE_LEASE_GAS_FILE: RECORD_FILE, ENCLAVE_LEASE_GAS_DIGEST: DIGEST,
    ENCLAVE_LEASE_GAS_RPCS: LEASE_RPC_HOSTS.map((h) => `https://${h}`).join(","),
    ENCLAVE_LEASE_GAS_RELAYS: "https://relay-a.example.org,https://relay-b.example.net",
  }, extra);
  const c = await import(hostUrl + "?seams-r3=" + ++serial);
  // what host.mjs establishes before any lease operation: the operator key, the address-book bindings, the relay policy
  assert.ok(c.loadOperator(), "operator key loaded");
  c.addresses.deployments = REC.ledger; c.addresses.registry = REC.registry;
  c.setLeaseRelayPolicy(null);                     // explicitly off
  assert.equal(c.leaseGasActive(), true);
  return c;
}
const hostsOf = () => [...new Set(seen.map((s) => s.host))].sort();
const methodsAt = (h) => new Set(seen.filter((s) => s.host === h).map((s) => s.method));
const restore = () => { for (const k of Object.keys(process.env)) if (!(k in BASE_ENV)) delete process.env[k]; Object.assign(process.env, BASE_ENV); };

test("Windows r3: verifier authority carries the HEALTHY lease reads and refuses at the binding stage; ENCLAVE_LEASE_GAS_RPCS never contacted", { timeout: 60_000 }, async () => {
  seen.length = 0;
  try {
    const c = await host({ ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: VERIFIER });
    await assert.rejects(c.claimDeployment(ID, ENCLAVE), (e) => { assert.equal(e.message, BINDINGS_REFUSAL); return true; });
    assert.deepEqual(hostsOf(), [VERIFIER_HOST], `only the verifier was contacted: ${JSON.stringify(seen)}`);
    for (const m of ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode"]) assert.ok(methodsAt(VERIFIER_HOST).has(m), `verifier served ${m}`);
  } finally { restore(); }
});

test("Windows r3: an invalid chain-authority selection refuses at the head read with NO HTTP at all (fail closed, no fallback)", { timeout: 60_000 }, async () => {
  seen.length = 0;
  try {
    const c = await host({ ENCLAVE_CHAIN_AUTHORITY: "verifier" });          // verifier without its URL: invalid
    await assert.rejects(c.claimDeployment(ID, ENCLAVE), (e) => { assert.equal(e.message, UNREADABLE); return true; });
    assert.deepEqual(seen, [], "the refusing authority answers every read itself: nothing leaves the process");
  } finally { restore(); }
});

test("Windows r3: legacy (no chain authority) carries the same healthy reads on the ENCLAVE_LEASE_GAS_RPCS quorum (compatibility)", { timeout: 60_000 }, async () => {
  seen.length = 0;
  try {
    const c = await host({});
    await assert.rejects(c.claimDeployment(ID, ENCLAVE), (e) => { assert.equal(e.message, BINDINGS_REFUSAL); return true; });
    const lease = hostsOf().filter((h) => LEASE_RPC_HOSTS.includes(h));
    assert.ok(lease.length >= 2, `a quorum of the configured lease RPCs carried the reads: ${JSON.stringify(seen)}`);
    assert.equal(hostsOf().includes(VERIFIER_HOST), false);
    for (const h of lease) for (const m of ["eth_chainId", "eth_blockNumber"]) assert.ok(methodsAt(h).has(m), `${h} served ${m}`);
  } finally { restore(); }
});
