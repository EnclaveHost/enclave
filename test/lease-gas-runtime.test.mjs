// Configuration mistakes must never turn an app-funded request into a charge to the host's operator wallet.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { base } from "viem/chains";
import { loadLeaseGasConfig, leaseGasConfigured, configuredLeaseSender } from "../network/lease-gas-runtime.mjs";

const address = (byte) => "0x" + byte.repeat(20);
const record = { format: "enclave-lease-gas-deployment/v1", chainId: 8453, reserve: address("11"), executor: address("22"),
  ledger: address("33"), registry: address("44"), reserveCodeHash: "0x" + "55".repeat(32), executorCodeHash: "0x" + "66".repeat(32) };
const bytes = Buffer.from(JSON.stringify(record));
const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
const values = { FILE: "reviewed-deployment.json", DIGEST: digest, RPCS: "https://one.example,https://two.example,https://three.example",
  RELAYS: "https://relay-a.example,https://relay-b.example" };
const bindings = { chain: base, ledger: record.ledger, registry: record.registry };
const environment = (prefix) => Object.fromEntries(Object.entries(values).map(([k, v]) => [prefix + k, v]));
const load = (env) => loadLeaseGasConfig({ env, ...bindings, readFile: (file) => {
  assert.equal(file, values.FILE); return bytes;
} });

test("only entirely absent configuration is feature-off; both platform prefixes load the same pins and quorum", () => {
  assert.equal(leaseGasConfigured({}), false);
  assert.equal(load({}), null);
  const linux = load(environment("LEASE_GAS_")), windows = load(environment("ENCLAVE_LEASE_GAS_"));
  assert.deepEqual(linux.deployment, windows.deployment);
  assert.deepEqual(linux.relays, windows.relays);
  assert.equal(linux.quorum, 2);
  assert.equal(linux.clients.length, 3);
});

for (const missing of ["FILE", "DIGEST", "RPCS", "RELAYS"]) {
  test(`missing ${missing} refuses configuration instead of enabling operator-paid fallback`, () => {
    const env = environment("LEASE_GAS_"); delete env["LEASE_GAS_" + missing];
    assert.equal(leaseGasConfigured(env), true);
    assert.throws(() => load(env), /require.*LEASE_GAS_/);
  });
}

test("legacy reserve alone, untrusted bytes, mismatched bindings, conflicting aliases, and invalid peer sets refuse", () => {
  assert.throws(() => load({ LEASE_GAS_RESERVE: record.reserve }), /require.*FILE/);
  assert.throws(() => load({ ...environment("LEASE_GAS_"), LEASE_GAS_DIGEST: "sha256:" + "00".repeat(32) }), /not the reviewed/);
  for (const wrong of [{ chain: { ...base, id: 1 } }, { ledger: address("77") }, { registry: address("88") }])
    assert.throws(() => loadLeaseGasConfig({ env: environment("LEASE_GAS_"), ...bindings, ...wrong, readFile: () => bytes }), /differs/);
  assert.throws(() => load({ ...environment("LEASE_GAS_"), ENCLAVE_LEASE_GAS_FILE: "other.json" }), /conflicting/);
  assert.throws(() => load({ ...environment("LEASE_GAS_"), LEASE_GAS_RESERVE: address("99") }), /differs/);
  for (const rpcs of ["https://one.example", "https://one.example/a,https://one.example/b", "http://public.example,https://two.example"])
    assert.throws(() => load({ ...environment("LEASE_GAS_"), LEASE_GAS_RPCS: rpcs }));
  assert.throws(() => load({ ...environment("LEASE_GAS_"), LEASE_GAS_RELAYS: "https://user:secret@relay.example" }), /credentials/);
  assert.throws(() => load({ ...environment("LEASE_GAS_"), LEASE_GAS_RELAYS: "https://relay.example/a,https://relay.example/b" }), /repeat/);
  assert.throws(() => load({ ...environment("LEASE_GAS_"), LEASE_GAS_QUORUM: "1" }), /strict majority/);
});

test("an administrator's binding migration stops every send before RPC or wallet access until pins are updated", () => {
  let signatures = 0;
  const account = { address: address("aa"),
    signAuthorization: () => { signatures++; throw new Error("must not sign"); },
    signTypedData: () => { signatures++; throw new Error("must not sign"); } };
  const config = load(environment("LEASE_GAS_"));
  let current = bindings;
  const s = configuredLeaseSender({ config, account, getBindings: () => current });
  current = { ...bindings, ledger: address("bb") };
  for (const send of [() => s.claim("id", "enclave"), () => s.renew("id"), () => s.release("id"),
    () => s.asClaimTx("claim", ["id", "enclave"])]) assert.throws(send, /current ledger or registry/);
  assert.equal(signatures, 0);
  assert.throws(() => configuredLeaseSender({ config: null, account, getBindings: () => bindings }), /complete reviewed/);
});
