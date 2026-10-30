// lease-consumer-seams (PREPARED; run only by the root job): the REAL Windows host module windows/node/chain.mjs with the REAL
// (rebuilt) windows/node/lease-gas-runtime.bundle.mjs - no fixture redirect, no anvil. Every outbound HTTP request of the
// process is observed through a recording fetch (answering a JSON-RPC error), so the test shows WHERE a lease read goes:
//   * ENCLAVE_CHAIN_AUTHORITY=verifier + ENCLAVE_CHAIN_VERIFIER: lease reads go to the verifier; the configured
//     ENCLAVE_LEASE_GAS_RPCS hosts are never contacted (no fallback);
//   * an invalid selection (verifier without a URL): the claim refuses and no lease RPC host is contacted (fail closed);
//   * legacy (no chain authority): the lease RPC hosts ARE contacted, as before (this also proves the observer sees lease reads).
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
const RECORD = Buffer.from('{"format":"enclave-lease-gas-deployment/v1","chainId":8453,"reserve":"0x12A3f873041Dec436DaA0085B766a399A6fA3639","executor":"0x8900BACA2167873BA2F8a8bAE8b4876E6396d343","reserveCodeHash":"0xcc00efe9c79c17b34ef9edc2720939030834bf168abc52cea14dcb224304a979","executorCodeHash":"0xdd893cd48b7c102dc266949d027c33d396a7f8884533ee81b3b2275048ec9ab2","ledger":"0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B","registry":"0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC"}');
const DIGEST = "sha256:" + createHash("sha256").update(RECORD).digest("hex");
const RECORD_FILE = path.join(tmp, "deployment.json");
fs.writeFileSync(RECORD_FILE, RECORD);
const LEASE_RPC_HOSTS = ["lease-rpc-one.example", "lease-rpc-two.example", "lease-rpc-three.example"];
const VERIFIER = "http://127.0.0.1:59321/";
const ID = "0x" + "ab".repeat(32), ENCLAVE = "0x" + "cd".repeat(32);

const seen = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  seen.push(url.host);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "lease-seams test: no chain here" } }),
    { status: 200, headers: { "content-type": "application/json" } });
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
  const c = await import(hostUrl + "?seams=" + ++serial);
  if (typeof c.setLeaseRelayPolicy === "function") c.setLeaseRelayPolicy(null);   // the host's policy explicitly off
  return c;
}
const leaseHostsContacted = () => seen.filter((h) => LEASE_RPC_HOSTS.includes(h));

test("Windows: verifier authority routes lease reads to the verifier only; ENCLAVE_LEASE_GAS_RPCS is never contacted", { timeout: 60_000 }, async () => {
  seen.length = 0;
  const c = await host({ ENCLAVE_CHAIN_AUTHORITY: "verifier", ENCLAVE_CHAIN_VERIFIER: VERIFIER });
  assert.equal(c.leaseGasActive(), true);
  await assert.rejects(c.claimDeployment(ID, ENCLAVE), "the verifier answers no chain: the claim refuses");
  assert.deepEqual(leaseHostsContacted(), [], `no public lease RPC fallback (contacted: ${seen.join(", ")})`);
  assert.ok(seen.includes(new URL(VERIFIER).host), `the lease read went to the verifier (contacted: ${seen.join(", ")})`);
});

test("Windows: an invalid chain-authority selection fails closed: the claim refuses, no lease RPC host is contacted", { timeout: 60_000 }, async () => {
  seen.length = 0;
  const c = await host({ ENCLAVE_CHAIN_AUTHORITY: "verifier" });          // verifier without its URL: invalid
  await assert.rejects(c.claimDeployment(ID, ENCLAVE));
  assert.deepEqual(leaseHostsContacted(), [], `no public lease RPC fallback (contacted: ${seen.join(", ")})`);
});

test("Windows: legacy (no chain authority) keeps the configured lease RPC quorum (compatibility; validates the observer)", { timeout: 60_000 }, async () => {
  seen.length = 0;
  const c = await host({});
  await assert.rejects(c.claimDeployment(ID, ENCLAVE));
  assert.ok(leaseHostsContacted().length > 0, `legacy lease reads use ENCLAVE_LEASE_GAS_RPCS (contacted: ${seen.join(", ")})`);
  assert.equal(seen.includes(new URL(VERIFIER).host), false);
  for (const k of Object.keys(process.env)) if (!(k in BASE_ENV)) delete process.env[k];
});
