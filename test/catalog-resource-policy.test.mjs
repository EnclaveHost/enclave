import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { catalogResourcePolicy, EXPLICIT_POLICY_RULE } from "../isolation/contract/catalog/policy.mjs";

const explicit = (vcpus) => ({ _isolationPolicy: { rule: EXPLICIT_POLICY_RULE, vcpus } });

test("existing valid catalog versions retain their exact bundle policy", () => {
  for (const memory of [0, 64, 128, 3072, 65536]) {
    for (const config of [undefined, "", "{}", { set: true, credentials: { accessKeyId: "${secrets.id}" } }]) {
      assert.deepEqual(catalogResourcePolicy(memory, config), {
        rule: "enclave-isolation-policy/1",
        policy: { cpuPercent: 100, memMiB: Math.max(128, memory), vcpus: 1 },
      });
    }
  }
});

test("explicit profile uses immutable memory and one core of quota per vCPU", () => {
  for (const cpus of [1, 2, 4, 8, 16]) {
    assert.deepEqual(catalogResourcePolicy(3072, JSON.stringify(explicit(cpus))), {
      rule: EXPLICIT_POLICY_RULE,
      policy: { cpuPercent: cpus * 100, memMiB: 3072, vcpus: cpus },
    });
  }
  assert.deepEqual(catalogResourcePolicy(3072n, explicit(2)), catalogResourcePolicy(3072, explicit(2)));
});

test("malformed explicit profiles never silently fall back to one core", () => {
  const bad = [null, false, [], {}, { rule: "enclave-isolation-policy/3", vcpus: 2 },
    ...[0, 17, 1.5, "2", true, null].map(vcpus => ({ rule: EXPLICIT_POLICY_RULE, vcpus })),
    { rule: EXPLICIT_POLICY_RULE, vcpus: 2, cpuPercent: 100 },
    { rule: EXPLICIT_POLICY_RULE, vcpus: 2, memMiB: 99999 }];
  for (const profile of bad) assert.throws(() => catalogResourcePolicy(3072, { _isolationPolicy: profile }));
  assert.throws(() => catalogResourcePolicy(3072, '{"_isolationPolicy":'));
});

test("independent Python reference agrees on accept/refuse and exact policies", () => {
  const cases = [];
  for (const memMb of [0, "3072", 65536, -1, 65537, 1.5, null, undefined, true, false, [], "1e3", "", " "]) {
    for (const config of ["", "{}", explicit(2), explicit(16), explicit(17), explicit("2"),
      { _isolationPolicy: null }, { _isolationPolicy: { rule: "unknown", vcpus: 4 } }])
      cases.push({ memMb, config });
  }
  cases.push({ memMb: 3072, config: '{"_isolationPolicy":{"rule":"enclave-isolation-policy/2","vcpus":2.0}}' });
  const js = cases.map(({ memMb, config }) => {
    try { return { result: catalogResourcePolicy(memMb, config) }; }
    catch { return { error: true }; }
  });
  const reference = spawnSync("python3", [new URL("../isolation/contract/catalog/policy_reference.py", import.meta.url).pathname],
    { input: JSON.stringify(cases), encoding: "utf8" });
  assert.equal(reference.status, 0, reference.stderr);
  assert.deepEqual(js, JSON.parse(reference.stdout));
});
