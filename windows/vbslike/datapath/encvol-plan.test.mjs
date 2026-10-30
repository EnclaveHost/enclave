// Encrypted volumes (encVolumes) on the Windows partition tier: refused, never dropped, unless the partition manager
// states supports.encVolumes AND the domain is a secret (V6/V7) one (the only kind with egress to an S3 endpoint).
import test from "node:test";
import assert from "node:assert/strict";
import { DERIVATION_V6 } from "../manager/derive.mjs";
import { isolationPlan, encVolumesNamed } from "./node-bridge.mjs";

const id = "0x" + "ab".repeat(32), rt = "cd".repeat(32), cid = "bafybeiftk3zeblrku6wr5cxd77szxcgg7icanbotl7ivu5lp6yadvlpi7i";
const enc = { encVolumes: [{ name: "docs", endpoint: "https://s3.example.com", bucket: "b", unlock: "wallet" }] };
const input = (over = {}) => ({ deploymentId: id, deployment: { cpuMilli: 250, gpuMilli: 0, isPublic: true },
  version: { appId: id, index: 1, cid, memMb: 2048, ports: "" }, appConfig: enc, hasSecrets: true, waf: {}, volumes: [],
  runtimeId: rt, require: "hyperv-partition-per-app", appConfigCid: "",
  manager: { backend: "hyperv-partition-per-app", catalog: { derivations: [DERIVATION_V6] }, supports: { config: true, secrets: true, encVolumes: true } },
  ...over });

test("encVolumesNamed follows the manager's truthiness", () => {
  for (const c of [{}, { encVolumes: [] }, { encVolumes: false }, { encVolumes: null }, { encVolumes: {} }, "", "not json", { other: 1 }])
    assert.equal(encVolumesNamed(typeof c === "string" ? c : JSON.stringify(c)), false, JSON.stringify(c));
  for (const c of [enc, { encVolumes: [{}] }, { encVolumes: { a: 1 } }, { encVolumes: "x" }])
    assert.equal(encVolumesNamed(JSON.stringify(c)), true, JSON.stringify(c));
});

test("a partition image without the capability refuses encVolumes rather than starting the app without them", () => {
  const p = isolationPlan(input({ manager: { ...input().manager, supports: { config: true, secrets: true } } }));
  assert.equal(p.ok, false);
  assert.equal(p.input, "appConfig.encVolumes");
  assert.match(p.why, /does not carry them/);
});

test("a non-secret domain refuses encVolumes (no egress to the S3 endpoint on this tier)", () => {
  const p = isolationPlan(input({ hasSecrets: false }));
  assert.equal(p.ok, false);
  assert.equal(p.input, "appConfig.encVolumes");
});

test("with the capability and a secret domain the plan proceeds, the config measured unchanged", () => {
  const p = isolationPlan(input());
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(JSON.parse(p.spawn.derive.config).encVolumes[0].name, "docs");
});

test("the partition's memory must hold every volume (the monitor's rule, before any claim)", () => {
  // the default 1024 MiB volume is 1041 MiB of tmpfs; plus 128 for the runtime and app
  const at = (memMb) => isolationPlan(input({ version: { ...input().version, memMb } }));
  assert.equal(at(1168).ok, false);
  assert.match(at(1168).why, /need 1041 MiB of the partition's 1168 MiB/);
  assert.equal(at(1169).ok, true, JSON.stringify(at(1169)));
});

test("a config without encVolumes is judged exactly as before", () => {
  const plain = input({ appConfig: { autostart: false }, manager: { ...input().manager, supports: { config: true, secrets: true } } });
  assert.equal(isolationPlan(plain).ok, true);
});

test("the partition manager states encVolumes only with secret domains and the operator's flag", async () => {
  const { Manager } = await import("../manager/server.mjs");
  const mk = (o) => new Manager({ runtimeId: rt, fetchComponent: async () => Buffer.alloc(0), fetchConfig: async () => "", ...o });
  assert.equal(mk({ configEnabled: true, secretsEnabled: true, encVolumes: true }).health().supports.encVolumes, true);
  assert.equal(mk({ configEnabled: true, secretsEnabled: false, encVolumes: true }).health().supports.encVolumes, false);
  assert.equal(mk({ configEnabled: true, secretsEnabled: true }).health().supports.encVolumes, false);
});
