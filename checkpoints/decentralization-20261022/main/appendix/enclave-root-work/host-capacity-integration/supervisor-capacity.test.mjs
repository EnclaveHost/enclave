// Integration test for supervisor.patch: run it in a tree WITH the patch applied
//   node --test work/host-capacity-integration/supervisor-capacity.test.mjs
// It boots the real supervisor.js (its HOST_CAPACITY_SELFTEST seam, on an ephemeral loopback port, no chain, no relay)
// and checks that GET /v1/host/capacity is this host's own /availability document, signed by its registry operator key
// for the endpoint it registered, and that a host that is not registered, or does not advertise, signs nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { privateKeyToAccount } from "viem/accounts";
import { verifyHostCapacity, hostIdOf } from "../../network/host-capacity.mjs";
const exec = promisify(execFile), root = new URL("../../", import.meta.url);
const KEY = "0x" + "01".repeat(32), operator = privateKeyToAccount(KEY).address.toLowerCase(), registry = "0x" + "a1".repeat(20);
const pins = { registry, deployments: "0x" + "a2".repeat(20), appCatalog: "0x" + "a3".repeat(20), proofOfTime: "0x" + "a4".repeat(20), enclavePay: "0x" + "00".repeat(20),
  verificationFees: "0x" + "00".repeat(20), sessionVaultFactory: "0x" + "00".repeat(20), secretVaultV2: "0x" + "00".repeat(20) };

const CONFIRMED = { registered: true, confirmed: true, registeredOn: "current" };
async function boot(t, selftest, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capacity-sup-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "pins.json"); fs.writeFileSync(file, JSON.stringify({ version: 1, chainId: 8453, contracts: pins }));
  // a clean environment (test/direct-only-supervisor.test.mjs): nothing from the caller's shell reaches the supervisor
  const env = { PATH: process.env.PATH, SECRET: "capacity-test-secret", ENABLE_MPS: "0", STATE_FILE: path.join(dir, "state.json"), PROVISION_BACKEND: "vm",
    ENCLAVE_CONTRACT_PINS_FILE: file, ADDRESS_BOOK_ADDRESS: "", SECRETS_API: "", DOMAINS_API: "", CERTS_API: "", DNS_API: "", APP_CERT_DOMAIN: "",
    REGISTRY_ENABLED: "1", REGISTRY_PRIVATE_KEY: KEY, ENCLAVE_REPO: "independent/host", HOST_CAPACITY_SELFTEST: JSON.stringify(selftest), ...extra };
  const { stdout } = await exec(process.execPath, ["supervisor.js"], { cwd: root, timeout: 90_000, env, maxBuffer: 8 << 20 }).catch((e) => { throw new Error(e.stderr || e.message); });
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

test("the supervisor serves its own /availability, signed by its registry operator for its registered endpoint", { timeout: 120_000 }, async (t) => {
  const endpoint = "https://host.independent.example";
  const out = await boot(t, { endpoint, ...CONFIRMED });
  assert.equal(out.availability.status, 200); assert.equal(out.capacity.status, 200, JSON.stringify(out.capacity.body));
  const v = await verifyHostCapacity(out.capacity.body, { pins: { chainId: 8453, registry }, entry: { endpoint, operator, active: true } });
  assert.equal(v.record.endpoint, endpoint); assert.equal(v.record.hostId, hostIdOf(endpoint)); assert.equal(v.record.operator, operator);
  assert.ok(v.record.expiresAt - v.record.issuedAt <= 15 * 60_000);
  // the same document the relay reads: same fields, same values except those that move between two reads
  assert.deepEqual(Object.keys(v.availability).sort(), Object.keys(out.availability.body).sort());
  for (const k of Object.keys(v.availability)) if (!["updatedAt", "instanceSweep"].includes(k) && typeof v.availability[k] !== "number")
    assert.deepEqual(v.availability[k], out.availability.body[k], k);
  // another operator registered for the endpoint: the record is refused
  await assert.rejects(verifyHostCapacity(out.capacity.body, { pins: { chainId: 8453, registry }, entry: { endpoint, operator: "0x" + "99".repeat(20), active: true } }), /current registry operator/);
});

// Every state registerOnChain can leave behind, as the seam sets it: only a CONFIRMED registration on the CURRENT
// registry signs. registered = its once-guard (set BEFORE the register transaction lands), confirmed = that transaction
// succeeded (_enclaveId), registeredOn = the registry it went to (the address book can repoint REGISTRY_ADDRESS).
const EP = "https://host.independent.example";
const STATES = [
  ["never registered", { endpoint: null, registered: false, confirmed: false, registeredOn: null }],
  ["register transaction in flight, an endpoint already known", { endpoint: EP, registered: true, confirmed: false, registeredOn: "current" }],
  ["registration failed or was reset, endpoint and id left behind", { endpoint: EP, registered: false, confirmed: true, registeredOn: null }],
  ["the address book repointed the registry since it registered", { endpoint: EP, registered: true, confirmed: true, registeredOn: "0x" + "77".repeat(20) }],
  ["the once-guard is down though a registry and a landed id are still recorded", { endpoint: EP, registered: false, confirmed: true, registeredOn: "current" }],
  ["the endpoint now known is not the one the register transaction landed for", { endpoint: EP, registered: true, confirmed: true, registeredOn: "current",
    confirmedFor: "https://previous.independent.example" }],
  ["a landed id is recorded but no endpoint is known", { endpoint: null, registered: true, confirmed: true, registeredOn: "current", confirmedFor: EP }],
];
for (const [name, state] of STATES)
  test(`no capacity record while ${name}`, { timeout: 120_000 }, async (t) => {
    const out = await boot(t, state);
    assert.equal(out.availability.status, 200, "/availability is unchanged");
    assert.equal(out.capacity.status, 503, JSON.stringify(out.capacity.body)); assert.match(out.capacity.body.error, /not registered yet/);
  });

test("a host that does not advertise signs nothing; a bad directory list is ignored, never fatal or defaulted", { timeout: 120_000 }, async (t) => {
  let out = await boot(t, { endpoint: EP, ...CONFIRMED }, { REGISTRY_ENABLED: "0" });
  assert.equal(out.availability.status, 200); assert.equal(out.capacity.status, 503); assert.equal(out.capacity.body.code, "not_advertised");
  out = await boot(t, { endpoint: EP, ...CONFIRMED }, { HOST_CAPACITY_DIRECTORIES: "https://dir.example/path" });
  assert.equal(out.capacity.status, 200);
});
