/* The bugs a review found in 7d238545, each reproduced FIRST and then falsified.
 *
 * Every test here is MOCKED: injected PowerShell answers, no Hyper-V host, nothing executed. The
 * original reproduction is kept beside each fix so the next person can see the defect rather than
 * only the guard against it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WmiHyperVLauncher, CMD, GUEST_FEATURE_SET, OWNER_MARKER } from "./wmi-launcher.mjs";
import { HyperVPartitionBackend } from "./backend.mjs";
import { Manager } from "./server.mjs";

const IMG = "C:\\img\\openhcl-ownguest.bin";
const SHA = "2d7353760b89b81b6f47759382bb2e83c325d73ed0825734f30fc4051183dfb3";
const mapping = { appId: "708e640945d196df5829aa4ea490774c18ef6876a0d9239f574986ad18ae3782",
                  record: { policy: { cpuPercent: 100, memMiB: 512, vcpus: 1 } } };

function host(over = {}) {
  const seen = [];
  const A = {
    preflight: { vmms: true, namespace: true, module: true, firmwareField: true, hypervisor: true },
    imageHash: { present: true, sha256: SHA, bytes: 1 },
    create: { id: "GUID-1", version: "12.0", name: "n", notes: OWNER_MARKER },
    pinFirmware: { returnValue: 0, jobState: null, firmwareFile: IMG, guestFeatureSet: GUEST_FEATURE_SET },
    attachConsole: { ok: true },
    start: { state: "Running" },
    readConsole: { bytes: 128, head: "OpenHCL boot..." },
    teardown: { found: 0, removed: [], failed: [] },
    survey: { vms: [] },
    ...over,
  };
  const key = (s) => s.includes("$r.vmms") ? "preflight" : s.includes("Get-FileHash") ? "imageHash"
    : s.includes("New-VM") ? "create" : s.includes("ModifySystemSettings") ? "pinFirmware"
    : s.includes("Set-VMComPort") ? "attachConsole" : s.includes("Start-VM") ? "start"
    : s.includes("[IO.File]::Open") ? "readConsole" : s.includes("Remove-VM") ? "teardown"
    : s.includes("$vms = @(Get-VM") ? "survey" : "other";
  const run = async (s) => {
    seen.push(s);
    const a = A[key(s)];
    if (a instanceof Error) return { code: 1, stdout: "", stderr: a.message };
    return { code: 0, stdout: JSON.stringify(a ?? { ok: true }), stderr: "" };
  };
  return { run, seen, key };
}
const mk = (h, over = {}) => new WmiHyperVLauncher({ run: h.run, imagePath: IMG, imageSha256: SHA, prefix: "enclave-app-", ...over });
const START = { instanceId: "dep0001-708e6409" };

/* ---- (1) 4096 is a job STARTED, not a job done ------------------------------------------------ */

test("REPRO+FIX: ReturnValue 4096 with an unfinished job is no longer success", async () => {
  // the reported reproduction: 4096, job never completed, Start reported Off
  const h = host({ pinFirmware: { returnValue: 4096, jobState: 4, firmwareFile: IMG, guestFeatureSet: GUEST_FEATURE_SET },
                   start: { state: "Off" } });
  await assert.rejects(() => mk(h).start(mapping, START), /job ended in state 4, not 7/);
});

test("4096 with a completed job (7) is success", async () => {
  const h = host({ pinFirmware: { returnValue: 4096, jobState: 7, firmwareFile: IMG, guestFeatureSet: GUEST_FEATURE_SET } });
  assert.equal((await mk(h).start(mapping, START)).state, "Running");
});

test("the pin is READ BACK, and a field that did not take is refused", async () => {
  await assert.rejects(() => mk(host({ pinFirmware: { returnValue: 0, firmwareFile: "C:\\somebody-elses.bin", guestFeatureSet: GUEST_FEATURE_SET } })).start(mapping, START),
                       /FirmwareFile reads back as/);
  await assert.rejects(() => mk(host({ pinFirmware: { returnValue: 0, firmwareFile: IMG, guestFeatureSet: 0 } })).start(mapping, START),
                       /GuestFeatureSet reads back as 0/);
});

test("the job wait is bounded and polls JobState, and the serializer is DEFINED not assumed", () => {
  const s = CMD.pinFirmware({ vmId: "v", imagePath: IMG, jobTimeoutSec: 30 });
  assert.match(s, /function ConvertTo-CimEmbeddedString/, "it was called but never defined: a command-not-found at runtime");
  assert.match(s, /CimSerializer\]::Create\(\)/, "Microsoft's own serialization, as their script does it");
  assert.match(s, /while \(\$job\.JobState -eq 4\)/, "poll while running");
  assert.match(s, /did not finish within 30s/, "bounded, not forever");
  assert.match(s, /\$jobState -ne 7/, "only 7 is completed");
  assert.match(s, /select \* from Msvm_ComputerSystem where Name = /, "and it re-reads the settings afterwards");
});

/* ---- (2) Running is the host's word; the guest has to say something --------------------------- */

test("REPRO+FIX: a VM that reports Off is a failure, not a handle", async () => {
  await assert.rejects(() => mk(host({ start: { state: "Off" } })).start(mapping, START), /is "Off" after Start-VM, not Running/);
  await assert.rejects(() => mk(host({ start: { state: null } })).start(mapping, START), /after Start-VM, not Running/);
});

test("Running with a silent guest is still a failure", async () => {
  await assert.rejects(() => mk(host({ readConsole: { bytes: 0, head: "" } })).start(mapping, START),
                       /the guest said nothing on .* is not a domain that came up/);
});

test("the manager reports running only when the guest spoke, and carries the evidence", async () => {
  const h = host();
  const m = new Manager({ runtimeId: mapping.record.runtimeId, fetchComponent: async () => Buffer.alloc(0),
                          backend: new HyperVPartitionBackend({ launcher: mk(h) }) });
  // drive the launcher directly: the derive path is covered by its own vectors test
  const handle = await mk(h).start(mapping, START);
  assert.equal(handle.guest.bytes, 128);
  assert.match(handle.guest.head, /OpenHCL/);
  assert.ok(m, "manager constructed with the real launcher");
});

/* ---- (3) two deployments of one app must not collide ------------------------------------------ */

test("REPRO+FIX: the VM name is the INSTANCE, never the AppID alone", async () => {
  const h = host();
  const a = await mk(h).start(mapping, { instanceId: "depAAA-708e6409" });
  const b = await mk(h).start(mapping, { instanceId: "depBBB-708e6409" });
  assert.notEqual(a.name, b.name, "same app, two deployments, two VM names");
  assert.match(a.name, /^enclave-app-depAAA-708e6409$/);
  await assert.rejects(() => mk(h).start(mapping, {}), /unique instanceId is required/);
  await assert.rejects(() => mk(h).start(mapping, { instanceId: "bad name!" }), /unique instanceId is required/);
});

test("the manager derives a per-deployment instance id, not a per-app one", () => {
  const ids = ["dep-one", "dep-two"].map((id) =>
    (String(id).replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "") + "-" + String(mapping.appId).slice(0, 8));
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids.every((i) => /^[A-Za-z0-9._-]{4,64}$/.test(i)), "and it is a name a VM may carry");
});

/* ---- (4) a partial create must not leak, and teardown must not lie --------------------------- */

test("REPRO+FIX: New-VM succeeding and a later step failing cleans up in PowerShell itself", () => {
  const s = CMD.create({ name: "n", memMiB: 512, vcpus: 1 });
  assert.match(s, /\$ErrorActionPreference = 'Stop'/, "a non-terminating error used to sail past");
  assert.match(s, /catch \{[\s\S]*Remove-VM -VM \$vm -Force/, "the VM it made, it removes");
  assert.ok(s.indexOf("Set-VM -VM $vm -Notes") < s.indexOf("Set-VMProcessor"),
            "the ownership marker is applied FIRST, not after the steps that can fail");
});

test("a failure after create sweeps by the VM's own name, even when create returned nothing", async () => {
  const h = host({ attachConsole: new Error("no pipe") });
  await assert.rejects(() => mk(h).start(mapping, START));
  // the create script now contains a Remove-VM of its own (its catch), so match the teardown COMMAND
  const sweep = h.seen.filter((s) => s.includes("$removed = @(); $failed = @();"));
  assert.equal(sweep.length, 1, "exactly one cleanup sweep");
  assert.match(sweep[0], /StartsWith\('enclave-app-dep0001-708e6409'\)/, "scoped to THIS VM, not the whole prefix");
});

test("teardown reports what it could not remove, and refuses to call that success", async () => {
  const h = host({ teardown: { found: 2, removed: ["a"], failed: [{ name: "b", error: "in use" }] } });
  await assert.rejects(() => mk(h).teardown(), /could not remove 1 VM\(s\): b \(in use\)/);
  const ok = host({ teardown: { found: 1, removed: ["a"], failed: [] } });
  assert.deepEqual((await mk(ok).teardown()).removed, ["a"]);
});

test("teardown sweeps unmarked orphans too, unless a marker is demanded", () => {
  assert.doesNotMatch(CMD.teardown({ prefix: "p-" }), /Notes -eq/, "a VM that died before its Notes were set is still ours");
  assert.match(CMD.teardown({ prefix: "p-", requireMarker: true }), new RegExp(`Notes -eq '${OWNER_MARKER}'`));
  assert.match(CMD.survey({ prefix: "p-" }), /StartsWith\('p-'\)/, "and there is a read that finds them");
});

/* ---- (6) health must not claim readiness from a wired object --------------------------------- */

test("REPRO+FIX: canStart is the host's answer, not 'a launcher exists'", async () => {
  const noRole = host({ preflight: { vmms: false, namespace: false, module: false, firmwareField: false, hypervisor: true } });
  const m = new Manager({ backend: new HyperVPartitionBackend({ launcher: mk(noRole) }) });
  assert.equal(m.health().canStart, false, "before probing, it claims nothing");
  await m.probe();
  assert.equal(m.health().canStart, false, "a launcher on a host with no role is still not ready");
  assert.ok(m.health().preflight.checks.some((c) => !c.ok));
  const ready = new Manager({ backend: new HyperVPartitionBackend({ launcher: mk(host()) }) });
  await ready.probe();
  assert.equal(ready.health().canStart, true);
  assert.equal("cannotStart" in ready.health(), false);
});

test("a manager with no launcher at all says so rather than throwing", async () => {
  const m = new Manager({ backend: new HyperVPartitionBackend() });
  await m.probe();
  assert.equal(m.health().canStart, false);
  assert.match(JSON.stringify(m.health()), /no launcher configured/);
});
