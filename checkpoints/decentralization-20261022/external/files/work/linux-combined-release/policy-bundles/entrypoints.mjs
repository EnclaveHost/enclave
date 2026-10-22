// The GENERATED entrypoints vs their sources: policy bindings/defaults (Windows bundle exports resolveHostPolicyConfig) and the
// metal policy delivery surface (validate/prepare/install). Run with cwd = main. Writes only under a fresh os.tmpdir() dir.
import assert from "node:assert/strict"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const M = process.cwd(), imp = (p) => import(path.join(M, p));
const WB = await imp("windows/node/host-admission.bundle.mjs"), WS = await imp("network/host-admission-runtime.mjs");
const MB = await imp("metal/guest/host-policy.bundle.mjs"), MS = await imp("network/metal-host-policy.mjs");
const C = await imp("network/platform-host-policy-config.mjs");
assert.deepEqual(Object.keys(WB).sort(), Object.keys(WS).sort()); assert.deepEqual(Object.keys(MB).sort(), Object.keys(MS).sort());
console.log("EXPORTS-MATCH windows", Object.keys(WB).length, "metal", Object.keys(MB).length);
const BOOK = C.PRODUCTION_BOOK, cases = {
  productionDefault: { env: {}, chainId: 8453, book: BOOK },
  explicitProduction: { env: { ENCLAVE_PLATFORM_HOST_POLICY: "production" }, chainId: 1, book: null },
  explicitOff: { env: { ENCLAVE_PLATFORM_HOST_POLICY: "off" }, chainId: 8453, book: BOOK },
  extraMirror: { env: { ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS: "https://mirror.example/platform-policy" }, chainId: 8453, book: BOOK },
  requiredActivation: { env: { ENCLAVE_PLATFORM_HOST_POLICY_ACTIVATION: "required" }, chainId: 8453, book: BOOK },
  otherChain: { env: {}, chainId: 31337, book: "0x" + "11".repeat(20) },
};
const run = (f, a) => { try { return { ok: f(a) }; } catch (e) { return { error: e.message }; } };
for (const [name, a] of Object.entries(cases)) {
  const b = run(WB.resolveHostPolicyConfig, a), s = run(WS.resolveHostPolicyConfig, a);
  assert.deepEqual(b, s, name); console.log("BINDING", name, JSON.stringify(b).slice(0, 260));
}
const d = WB.resolveHostPolicyConfig(cases.productionDefault);
assert.equal(d.on, true); assert.equal(d.config.activation, "anchor", "production default stays anchor-activated (admin anchors)");
assert.equal(d.config.book, BOOK); assert.equal(d.config.hostOwnership, "0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7", "original ownership contract");
assert.deepEqual(d.config.mirrors, [...C.PRODUCTION_MIRRORS]); assert.equal(d.config.mirrors.length, 4);
assert.equal(WB.resolveHostPolicyConfig(cases.explicitOff).on, false);
console.log("PRODUCTION-DEFAULT activation=anchor book", BOOK, "ownership 0xbbd885d3... mirrors", d.config.mirrors.length, "rpcs", (d.config.rpcs || []).length, "minAgree", d.config.minAgree);
// metal delivery surface: identical acceptance/refusal and identical installed files
const hostId = "0x" + "ab".repeat(32), ownershipContract = "0x" + "11".repeat(20);
const contracts = Object.fromEntries(["registry", "deployments", "appCatalog", "proofOfTime", "enclavePay", "verificationFees", "sessionVaultFactory", "secretVaultV2"].map((k, i) => [k, "0x" + String(i + 1).repeat(40)]));
const wire = { version: 1, hostId, ownershipContract, pins: { version: 1, chainId: 8453, contracts }, policies: [], policyOrigins: [] };
for (const w of [wire, null, {}, { ...wire, registryKey: "private" }, { ...wire, pins: { ...wire.pins, chainId: 1 } }])
  assert.deepEqual(run(MB.validateMetalHostPolicy, w), run(MS.validateMetalHostPolicy, w));
assert.equal(MB.prepareMetalHostPolicy(undefined), null); assert.deepEqual(MB.installMetalHostPolicy(undefined), {});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-entry-"));
try {
  const eb = MB.installMetalHostPolicy(wire, { directory: path.join(tmp, "b") }), es = MS.installMetalHostPolicy(wire, { directory: path.join(tmp, "s") });
  const norm = (e, k) => JSON.parse(JSON.stringify(e).split(path.join(tmp, k)).join("<dir>"));
  assert.deepEqual(norm(eb, "b"), norm(es, "s"));
  assert.equal(fs.readFileSync(eb.ENCLAVE_CONTRACT_PINS_FILE, "utf8"), fs.readFileSync(es.ENCLAVE_CONTRACT_PINS_FILE, "utf8"));
  console.log("METAL-BUNDLE == SOURCE validate/prepare/install", Object.keys(eb).join(","));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log("ENTRYPOINTS-OK");
