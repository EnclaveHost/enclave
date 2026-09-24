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
const DEP = "0x" + "e6".repeat(32);
// the body the node client actually sends: guestd's contract, name included
const spawnBody = (over = {}) => ({ derive: REC, name: DEP, isPublic: true, hasSecrets: false, ...over });

test("/health states the backend, refuses everything it cannot honour, and admits it cannot start", () => {
  const h = mk().health();
  assert.equal(h.backend, BACKEND);
  assert.equal(h.backend, "hyperv-partition-per-app", "the name agreed with the SNP lane");
  for (const k of ["gpu", "secrets", "egress", "config", "ports", "configCid"])
    assert.equal(h.supports[k], false, `supports.${k} must be false`);
  assert.deepEqual(h.catalog.derivations, ["enclave-catalog-bundle/1"],
                   "the GATE list: only what this backend can actually serve");
  assert.deepEqual(h.catalog.derives, ["enclave-catalog-bundle/1", "enclave-catalog-bundle/2"],
                   "what it can COMPUTE is separate information, and /2 is byte-exact here");
  assert.equal(h.runtime.v2SocketServer, false, "deriving /2 is not serving it, and health says which");
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
  assert.equal(r.status, "failed");
  assert.match(r.reason, /custom IGVM|Hyper-V role|IgvmFilePath/);
  assert.equal("attestation" in r, false, "no evidence is invented for a domain that never ran");
  assert.ok(r.prerequisites, "and the prerequisite is named rather than guessed at");
  assert.equal(r.status === "running", false);
});

test("the seam works when a host can launch, and a booted guest is not a running app", async () => {
  const booted = new HyperVPartitionBackend({ launch: async () => ({ pid: 4242, appReady: false, guest: { booted: true, bytes: 9, head: "hi" }, stop: async () => {} }) });
  const r = await mk({ backend: booted }).spawn(spawnBody());
  assert.equal(r.status, "starting", "console output is not evidence the app is serving, and 'starting' is a word the supervisor knows");
  assert.equal(r.appReady, false);
  assert.match(r.reason, /no app-readiness handshake/);
  assert.equal("attestation" in r, false, "still none: booted is not attested either");
  // and when a backend CAN prove the app is up, the word is earned
  const ready = new HyperVPartitionBackend({ launch: async () => ({ pid: 1, appReady: true, guest: { booted: true, bytes: 9 }, stop: async () => {} }) });
  const r2 = await mk({ backend: ready }).spawn(spawnBody());
  assert.equal(r2.status, "running");
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
  // /2 is a KNOWN rule now, so an unknown one has to be a genuinely unknown one
  await assert.rejects(() => mk().spawn(spawnBody({ derive: { ...REC, derivation: "enclave-catalog-bundle/9" } })), /unknown derivation/);
});

test("the lifecycle is readable: list, get, delete", async () => {
  const m = mk();
  const r = await m.spawn(spawnBody({ id: "d1" }));
  assert.equal(m.list().length, 1);
  assert.equal(m.get("d1").appId, r.appId);
  assert.deepEqual(await m.remove("d1"), { removed: true, absent: false });
  assert.equal(m.get("d1"), null);
  assert.deepEqual(await m.remove("d1"), { removed: false, absent: true });
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
  assert.equal(r.status, "starting", "the guest booted; no app-readiness handshake exists, so not \"running\"");
  assert.equal(r.appReady, false);
  assert.equal("attestation" in r, false, "a VM that started is still not an attested one");
  const pre = await backend.preflight();
  assert.equal(pre.ok, true, "and the backend can ask the host what it has");
});

test("a /2 app is REFUSED rather than approximated, even though its AppID is right", async () => {
  const { DERIVATION_V2, derive } = await import("./derive.mjs");
  const rec2 = { ...REC, derivation: DERIVATION_V2, http: 8000 };
  // the identity is correct here - that is the point of implementing the rule at all
  assert.equal(derive({ record: rec2, component }).appId.length, 64);
  // and the manager still will not take it, because serving one needs a runtime it does not have
  await assert.rejects(() => mk().spawn(spawnBody({ derive: rec2 })),
                       /derives enclave-catalog-bundle\/2 but cannot serve it yet/);
});

test("a rule we cannot serve is absent from the gate list, not merely refused later", () => {
  const h = mk().health();
  assert.equal(h.catalog.derivations.includes("enclave-catalog-bundle/2"), false,
    "listing it would pass the claim gate: the node takes the lease ON CHAIN, then this process "
    + "refuses, and the deployment churns through claim, fail and release while a box that can "
    + "serve it sits free. Silence is the refusal the gate understands.");
  assert.equal(h.catalog.derives.includes("enclave-catalog-bundle/2"), true,
    "but the capability is still reported, so nobody has to guess whether the identity would match");
});

/** A backend whose guest boots but has no readiness handshake: the ordinary case on this tier. */
const bootedBackend = () => new HyperVPartitionBackend({
  launch: async () => ({ pid: 4242, appReady: false, guest: { booted: true, bytes: 9, head: "hi" }, stop: async () => {} }),
});

/* ---- defects 4, 5 and 6, and guestd's vocabulary ---------------------------------------------- *
 * All found by enclave-99 by reading the sources against supervisor.js and isolation/m4/guestd. */

test("defect 6: a second spawn for a live deployment is a 409 naming the instance to adopt", async () => {
  const m = mk({ backend: bootedBackend() });
  const first = await m.spawn(spawnBody());
  const e = await m.spawn(spawnBody()).then(() => null, (x) => x);
  assert.ok(e, "a live name must not be silently overwritten");
  assert.equal(e.status, 409);
  assert.equal(e.id, first.id, "the 409 names WHICH instance to adopt, or the caller cannot adopt it");
  assert.equal(m.list().length, 1, "and the first handle is not forgotten");
});

test("defect 6: an explicit duplicate id is a 409 too, never an overwrite", async () => {
  const m = mk({ backend: bootedBackend() });
  await m.spawn(spawnBody({ id: "hvdeadbeef" }));
  const e = await m.spawn(spawnBody({ id: "hvdeadbeef", name: "0x" + "ff".repeat(32) })).then(() => null, (x) => x);
  assert.equal(e && e.status, 409);
  assert.equal(m.list().length, 1);
});

test("ids are the manager's own shape, and the record names the deployment", async () => {
  const r = await mk({ backend: bootedBackend() }).spawn(spawnBody());
  assert.match(r.id, /^hv[0-9a-f]{8}$/, "hv + 8 hex, as 5d's supervisor and datapath expect");
  assert.equal(r.name, DEP, "adoption after a restart matches on name");
});

test("defect 4: the record carries what the data plane needs to route, and the boundary word", async () => {
  const withRoute = { supports: {}, backend: "hv", BOUNDARY: { tier: "t0-hv", partition: "hcs-child", hostExcluded: false, attested: false },
    start: async () => ({ name: "vm", state: "Running", guest: { booted: true, bytes: 12, head: "MON" },
                          appReady: false, boundary: { tier: "t0-hv", partition: "hcs-child", hostExcluded: false, attested: false },
                          domainId: 1, guestPort: 40001, tcpPort: 19101, image: "ab".repeat(32) }) };
  const r = await mk({ backend: withRoute }).spawn(spawnBody());
  assert.deepEqual(r.relay, { host: "127.0.0.1", port: 19101 }, "without a relay port nothing can be routed");
  assert.equal(r.domainId, 1);
  assert.equal(r.guestPort, 40001);
  assert.equal(r.image, "ab".repeat(32), "the splice admits on image + transportKeySha256");
  assert.equal(r.boundary.hostExcluded, false, "carried verbatim: this is the word that must never be lost");
  assert.equal(r.hostExcluded, false);
  assert.equal(r.tier, "t0-hv");
});

test("defect 5: a stop that FAILED is not a removal, and the domain stays listed", async () => {
  const stubborn = { supports: {}, backend: "hv",
    start: async () => ({ name: "vm", state: "Running", guest: { booted: true, bytes: 9 }, appReady: false }),
    stop: async () => { throw new Error("stop_failed"); } };
  const m = mk({ backend: stubborn });
  const r = await m.spawn(spawnBody());
  const e = await m.remove(r.id).then(() => null, (x) => x);
  assert.ok(e, "remove must not answer ok when the domain may still be running");
  assert.match(e.message, /may still be RUNNING/);
  assert.equal(m.list().length, 1, "an orphan the manager stopped listing is one nobody can find");
  assert.equal(m.get(r.id).status, "failed");
});
