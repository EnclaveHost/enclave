// The Windows manager's half of the shared contract, tested without a partition - which is the
// point: everything except the launch is finished, and a launch that cannot happen must fail
// closed and say why rather than degrade into something that looks like success.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Manager, policyFor, refuseUnsupported, POLICY_RULE } from "./server.mjs";
import { HyperVPartitionBackend, BACKEND } from "./backend.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(fs.readFileSync(path.join(HERE, "../../../isolation/contract/catalog/derive_vectors.json"), "utf8"));
const component = Buffer.from(v.component_hex, "hex");
const REC = v.ok[0].mapping.record;
const RT = REC.runtimeId;

const mk = (over = {}) => new Manager({ runtimeId: RT, fetchComponent: async () => component, ...over });
const spawnBody = (over = {}) => ({ derive: REC, isPublic: true, hasSecrets: false, ...over });

test("/health states the backend, refuses everything it cannot honour, and admits it cannot start", () => {
  const h = mk().health();
  assert.equal(h.backend, BACKEND);
  assert.equal(h.backend, "hyperv-partition-per-app", "the name agreed with the SNP lane");
  for (const k of ["gpu", "secrets", "egress", "config", "ports", "configCid"])
    assert.equal(h.supports[k], false, `supports.${k} must be false`);
  assert.deepEqual(h.catalog.derivations, ["enclave-catalog-bundle/1"]);
  assert.equal(h.catalog.runtimeId, RT);
  assert.equal(h.policyRule, POLICY_RULE);
  assert.equal(h.canStart, false, "no launch path on this host, and it says so");
  assert.match(h.cannotStart.supportedPath, /Msvm_VirtualSystemSettingData\.FirmwareFile/);
});

test("the pinned policy is the version's memMb with a floor, one vcpu, the whole core", () => {
  assert.deepEqual(policyFor({ memMb: 512 }), { vcpus: 1, memMiB: 512, cpuPercent: 100 });
  assert.deepEqual(policyFor({ memMb: 64 }), { vcpus: 1, memMiB: 128, cpuPercent: 100 }, "floor 128");
  assert.throws(() => policyFor({}), /no memMb/, "a missing declaration is refused, never defaulted");
});

test("a spawn derives the contract's AppID, and it is the shared one", async () => {
  const r = await mk().spawn(spawnBody());
  assert.equal(r.appId, v.ok[0].mapping.appId, "the same AppID Go and Python derive");
  assert.equal(r.recordSha256, v.ok[0].mapping.recordSha256);
  assert.equal(r.policy.vcpus, 1);
});

test("a domain that did not start is failed, says why, and carries NO attestation", async () => {
  const r = await mk().spawn(spawnBody());
  assert.equal(r.state, "failed");
  assert.match(r.reason, /custom IGVM|Hyper-V role|IgvmFilePath/);
  assert.equal("attestation" in r, false, "no evidence is invented for a domain that never ran");
  assert.ok(r.prerequisites, "and the prerequisite is named rather than guessed at");
  assert.equal(r.state === "running", false);
});

test("the seam works when a host can launch, and a booted guest is not a running app", async () => {
  const booted = new HyperVPartitionBackend({ launch: async () => ({ pid: 4242, appReady: false, guest: { booted: true, bytes: 9, head: "hi" }, stop: async () => {} }) });
  const r = await mk({ backend: booted }).spawn(spawnBody());
  assert.equal(r.state, "guest-booted", "console output is not evidence the app is serving");
  assert.equal(r.appReady, false);
  assert.match(r.reason, /no app-readiness handshake/);
  assert.equal("attestation" in r, false, "still none: booted is not attested either");
  // and when a backend CAN prove the app is up, the word is earned
  const ready = new HyperVPartitionBackend({ launch: async () => ({ pid: 1, appReady: true, guest: { booted: true, bytes: 9 }, stop: async () => {} }) });
  const r2 = await mk({ backend: ready }).spawn(spawnBody());
  assert.equal(r2.state, "running");
});

test("everything this backend cannot honour is refused again on this side of the wire", async () => {
  const cases = [
    [{ gpuMilli: 10 }, /GPU/], [{ config: "{}" }, /app config/], [{ appConfigCid: "bafy" }, /app config/],
    [{ hasSecrets: true }, /staged secrets/], [{ hasSecrets: undefined }, /unverified secret state/],
    [{ firewall: ["tcp:22"] }, /declared ports/], [{ volumes: ["m"] }, /model volumes/],
    [{ isPublic: false }, /private deployment/], [{ waf: { rate: 1 } }, /protection rules/],
  ];
  for (const [over, re] of cases) {
    const body = spawnBody(over);
    if ("hasSecrets" in over && over.hasSecrets === undefined) delete body.hasSecrets;
    await assert.rejects(() => mk().spawn(body), re, JSON.stringify(over));
  }
});

test("a mapping pinned to another runtime, or another derivation, is refused", async () => {
  await assert.rejects(() => mk().spawn(spawnBody({ derive: { ...REC, runtimeId: "aa".repeat(32) } })), /pinned to runtime/);
  await assert.rejects(() => mk().spawn(spawnBody({ derive: { ...REC, derivation: "enclave-catalog-bundle/2" } })), /unknown derivation/);
});

test("the lifecycle is readable: list, get, delete", async () => {
  const m = mk();
  const r = await m.spawn(spawnBody({ id: "d1" }));
  assert.equal(m.list().length, 1);
  assert.equal(m.get("d1").appId, r.appId);
  assert.equal(await m.remove("d1"), true);
  assert.equal(m.get("d1"), null);
  assert.equal(await m.remove("d1"), false);
});

test("the backend takes the REAL launcher, and a domain started through it is running", async () => {
  const { WmiHyperVLauncher } = await import("./wmi-launcher.mjs");
  const SHA = "2d7353760b89b81b6f47759382bb2e83c325d73ed0825734f30fc4051183dfb3";
  const answer = (script) => script.includes("$r.vmms") ? { vmms: true, namespace: true, module: true, firmwareField: true, hypervisor: true }
    : script.includes("Get-FileHash") ? { present: true, sha256: SHA, bytes: 124962164 }
    : script.includes("New-VM") ? { id: "GUID", version: "12.0", name: "x" }
    : script.includes("ModifySystemSettings") ? { returnValue: 0, jobState: null, firmwareFile: "C:\\img.bin", guestFeatureSet: 0x201 }
    : script.includes("Start-VM") ? { state: "Running" }
    : script.includes("NamedPipeClientStream") ? { connected: true, bytes: 42, head: "guest output" } : { ok: true };
  const launcher = new WmiHyperVLauncher({
    run: async (s) => ({ code: 0, stdout: JSON.stringify(answer(s)), stderr: "" }),
    imagePath: "C:\\img.bin", imageSha256: SHA, prefix: "enclave-app-t-" });
  const backend = new HyperVPartitionBackend({ launcher });
  const r = await mk({ backend }).spawn(spawnBody());
  assert.equal(r.state, "guest-booted", "the guest booted; no app-readiness handshake exists, so not \"running\"");
  assert.equal(r.appReady, false);
  assert.equal("attestation" in r, false, "a VM that started is still not an attested one");
  const pre = await backend.preflight();
  assert.equal(pre.ok, true, "and the backend can ask the host what it has");
});
