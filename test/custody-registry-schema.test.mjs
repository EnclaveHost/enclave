// The custodians read EnclaveRegistry.get for the lease holder's operator. The live Base registry is an OLDER schema than
// contracts/EnclaveRegistry.sol (it lacks the appended caps/region), and decoding the full schema-5 tuple against it threw,
// so every custodian refused every release (2026-10-14, the first hardware canary). custody/chain.mjs now decodes the
// schema-1 prefix, which every schema keeps at the same offsets.
//   run: node --test test/custody-registry-schema.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionResult, encodeAbiParameters } from "viem";
import { REGISTRY_ABI } from "../custody/chain.mjs";

const V1 = [{ name: "endpoint", type: "string" }, { name: "repo", type: "string" }, { name: "measurement", type: "bytes32" },
  { name: "operator", type: "address" }, { name: "registeredAt", type: "uint64" }, { name: "lastSeen", type: "uint64" }, { name: "active", type: "bool" }];
const V5 = [...V1, { name: "cpuPricePerSec6", type: "uint64" }, { name: "gpuPricePerSec6", type: "uint64" },
  { name: "proofKey", type: "address" }, { name: "payoutWallet", type: "address" }, { name: "caps", type: "uint64" }, { name: "region", type: "string" }];
const SCHEMAS = { 1: V1, 2: V5.slice(0, 9), 3: V5.slice(0, 10), 4: V5.slice(0, 11), 5: V5 };
const OPERATOR = "0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB";
const row = { endpoint: "https://api.enclave.host/t/metal0", repo: "EnclaveHost/enclave", measurement: "0x" + "ab".repeat(32),
  operator: OPERATOR, registeredAt: 1790000000n, lastSeen: 1792000000n, active: true, cpuPricePerSec6: 7n, gpuPricePerSec6: 0n,
  proofKey: "0x" + "11".repeat(20), payoutWallet: "0x" + "22".repeat(20), caps: 3n, region: "us-west" };

for (const [rev, components] of Object.entries(SCHEMAS)) {
  test(`a schema-${rev} registry entry decodes to its operator and active flag`, () => {
    const data = encodeAbiParameters([{ type: "tuple", components }], [Object.fromEntries(components.map((c) => [c.name, row[c.name]]))]);
    const got = decodeFunctionResult({ abi: REGISTRY_ABI, functionName: "get", data });
    assert.equal(got.operator, OPERATOR);
    assert.equal(got.active, true);
    assert.equal(got.endpoint, row.endpoint);
  });
}

test("the full schema-5 tuple does NOT decode a schema-4 entry (why the reader takes the prefix)", () => {
  const data = encodeAbiParameters([{ type: "tuple", components: SCHEMAS[4] }], [Object.fromEntries(SCHEMAS[4].map((c) => [c.name, row[c.name]]))]);
  const full = [{ ...REGISTRY_ABI[0], outputs: [{ type: "tuple", components: V5 }] }];
  assert.throws(() => decodeFunctionResult({ abi: full, functionName: "get", data }));
});
