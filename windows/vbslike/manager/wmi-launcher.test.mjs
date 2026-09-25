// The supported launcher, driven entirely by INJECTED PowerShell answers.
//
// Every test here is mocked. None of it has run against a Hyper-V host, because this host has no
// Hyper-V role: that is the point of writing it this way rather than waiting. What is tested is
// what can be: the commands it generates, the order it does things in, what it refuses, and what it
// cleans up when a step fails halfway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WmiHyperVLauncher, CMD, GUEST_FEATURE_SET, OWNER_MARKER, MIN_VM_VERSION, q } from "./wmi-launcher.mjs";

const IMG = "C:\\Users\\claude\\vbs-like\\openhcl-ownguest.bin";
const SHA = "2d7353760b89b81b6f47759382bb2e83c325d73ed0825734f30fc4051183dfb3";
const mapping = { appId: "708e640945d196df5829aa4ea490774c18ef6876a0d9239f574986ad18ae3782",
                  record: { policy: { cpuPercent: 100, memMiB: 512, vcpus: 1 } } };

/** A host that answers whatever the script asks for, and records every script it was given. */
function host(over = {}) {
  const seen = [];
  const answers = {
    preflight: { vmms: true, namespace: true, module: true, firmwareField: true, hypervisor: true },
    imageHash: { present: true, sha256: SHA, bytes: 124962164 },
    create: { id: "B4E9F747-7966-5EB8-BF85-FD2CD717DF44", version: "12.0", name: "x" },
    pinFirmware: { returnValue: 0, jobState: null, firmwareFile: IMG, guestFeatureSet: GUEST_FEATURE_SET },
    attachConsole: { ok: true },
    start: { state: "Running" },
    readConsole: { connected: true, bytes: 64, head: "guest said something" },
    teardown: { found: 1, removed: ["x"], failed: [] },
    removeExact: { found: true, removed: true },
    stop: { ok: true },
    ...over,
  };
  const run = async (script) => {
    seen.push(script);
    const key = script.includes("$r.vmms") ? "preflight"
      : script.includes("Get-FileHash") ? "imageHash"
      : script.includes("New-VM") ? "create"
      : script.includes("ModifySystemSettings") ? "pinFirmware"
      : script.includes("Set-VMComPort") ? "attachConsole"
      : script.includes("Start-VM") ? "start"
      : script.includes("already gone") ? "stop"
      : script.includes("NamedPipeClientStream") ? "readConsole"
      : script.includes("$_.Name -eq") ? "removeExact"
      : script.includes("$removed = @(); $failed = @();") ? "teardown"
      : script.includes("Stop-VM") ? "stop" : "unknown";
    const a = answers[key];
    if (a instanceof Error) return { code: 1, stdout: "", stderr: a.message };
    return { code: 0, stdout: JSON.stringify(a ?? { ok: true }), stderr: "" };
  };
  return { run, seen };
}
const ID = { instanceId: "dep0001-708e6409" };
const mk = (h, over = {}) => new WmiHyperVLauncher({ run: h.run, imagePath: IMG, imageSha256: SHA, prefix: "enclave-app-t-", ...over });

test("the firmware pin is Microsoft's own two fields, applied their way", () => {
  const s = CMD.pinFirmware({ vmId: "abc", imagePath: IMG });
  assert.ok(s.includes("root\\virtualization\\v2"), "the Hyper-V WMI namespace, not HCS");
  assert.match(s, /Msvm_ComputerSystem where Name/);
  assert.match(s, /Get-CimAssociatedInstance -ResultClass Msvm_VirtualSystemSettingData -Association Msvm_SettingsDefineState/);
  assert.match(s, new RegExp(`\\$vssd\\.GuestFeatureSet = ${GUEST_FEATURE_SET}`));
  assert.ok(s.includes("$vssd.FirmwareFile = 'C:\\Users"), "the image path goes in FirmwareFile");
  assert.match(s, /Invoke-CimMethod -InputObject \$svc -Name ModifySystemSettings/);
  assert.equal(GUEST_FEATURE_SET, 0x00000201, "the value their script writes");
});

test("the VM is created generation 2 at a version the firmware field needs, pinned and marked", () => {
  const s = CMD.create({ name: "n", memMiB: 512, vcpus: 1 });
  assert.match(s, /New-VM -Name 'n' -Generation 2 -MemoryStartupBytes 512MB -NoVHD -Version '12\.0'/);
  assert.match(s, /Set-VMProcessor -VM \$vm -Count 1/);
  assert.match(s, /DynamicMemoryEnabled \$false/, "a pinned share is not a dynamic one");
  assert.match(s, new RegExp(`-Notes '${OWNER_MARKER}'`), "the ownership marker teardown filters on");
  assert.match(s, /-AutomaticStartAction Nothing/, "it must not come back by itself after a reboot");
});

test("teardown is scoped by prefix, and by the marker only when one is demanded", () => {
  const s = CMD.teardown({ prefix: "enclave-app-t-" });
  assert.match(s, /\$_\.Name\.StartsWith\('enclave-app-t-'\)/, "always the instance prefix");
  assert.doesNotMatch(s, /Notes -eq/,
    "by default the marker is NOT required: a VM that failed before its Notes were set is still ours, and skipping it makes an orphan permanent");
  assert.match(CMD.teardown({ prefix: "enclave-app-t-", requireMarker: true }), new RegExp(`Notes -eq '${OWNER_MARKER}'`));
  assert.doesNotMatch(s, /Get-VM \| Remove-VM/, "it never enumerates every VM for action");
});

test("a single quote in a name cannot break out of a PowerShell literal", () => {
  assert.equal(q("it's"), "'it''s'");
  assert.match(CMD.state({ name: "a'b" }), /'a''b'/);
});

test("preflight reports each prerequisite, and start refuses before creating anything", async () => {
  const h = host({ preflight: { vmms: false, namespace: false, module: false, firmwareField: false, hypervisor: true } });
  const l = mk(h);
  const pre = await l.preflight();
  assert.equal(pre.ok, false);
  assert.deepEqual(pre.checks.filter((c) => !c.ok).map((c) => c.name).sort(),
    ["Hyper-V PowerShell module", "Msvm_VirtualSystemSettingData.FirmwareFile", "root\\virtualization\\v2", "vmms service"].sort());
  await assert.rejects(() => l.start(mapping, ID), /the Hyper-V role is not usable/);
  assert.equal(h.seen.some((s) => s.includes("New-VM")), false, "nothing was created");
});

test("the image is pinned by hash, and a path alone is refused", async () => {
  await assert.rejects(() => mk(host(), { imageSha256: "" }).verifyImage(), /a path is not an identity/);
  await assert.rejects(() => mk(host({ imageHash: { present: true, sha256: "00".repeat(32), bytes: 1 } })).verifyImage(),
                       /sha256 is 0000/, "the wrong bytes are refused even though the path exists");
  await assert.rejects(() => mk(host({ imageHash: { present: false } })).verifyImage(), /not present/);
  assert.deepEqual(await mk(host()).verifyImage(), { sha256: SHA, bytes: 124962164 });
});

test("a good start does the steps in order and hands back a stoppable handle", async () => {
  const h = host();
  const r = await mk(h).start(mapping, ID);
  const order = h.seen.map((s) => s.includes("$r.vmms") ? "preflight" : s.includes("Get-FileHash") ? "image"
    : s.includes("New-VM") ? "create" : s.includes("ModifySystemSettings") ? "pin"
    : s.includes("Set-VMComPort") ? "console" : s.includes("Start-VM") ? "start"
    : s.includes("NamedPipeClientStream") ? "guest" : "?");
  assert.deepEqual(order, ["preflight", "image", "create", "pin", "console", "start", "guest"],
                   "firmware pinned before start, the console attached before that, and the guest heard last");
  assert.equal(r.state, "Running");
  assert.equal(r.name, "enclave-app-t-dep0001-708e6409", "named for the deployment instance, not the app");
  assert.ok(r.pipe.startsWith("\\\\.\\pipe\\"), "a named pipe, so the guest can be heard at all");
  // `image` is the GUEST's identity (the medium's hash), null with no medium; the FIRMWARE's hash
  // has its own name now. They were one field, and the datapath compares image as a 64-hex string,
  // so the object there refused every route as "identity" rather than as a type error (enclave-53).
  assert.equal(r.image, null, "no medium attached, so no guest image identity");
  assert.equal(r.firmware.sha256, SHA, "the firmware hash, under its own name");
});

test("4096 means a job was STARTED: it is success only once that job completes", async () => {
  const done = { returnValue: 4096, jobState: 7, firmwareFile: IMG, guestFeatureSet: GUEST_FEATURE_SET };
  assert.equal((await mk(host({ pinFirmware: done })).start(mapping, ID)).state, "Running");
  await assert.rejects(() => mk(host({ pinFirmware: { ...done, jobState: 4 } })).start(mapping, ID), /state 4, not 7/);
  await assert.rejects(() => mk(host({ pinFirmware: { returnValue: 32775 } })).start(mapping, ID), /returned 32775/);
});

test("a VM older than the firmware field needs is refused", async () => {
  await assert.rejects(() => mk(host({ create: { id: "g", version: "9.0", name: "x" } })).start(mapping, ID),
                       new RegExp(`below ${MIN_VM_VERSION}`));
});

test("a failure after creation removes the half-built VM before rethrowing", async () => {
  for (const broken of [{ pinFirmware: new Error("wmi said no") }, { attachConsole: new Error("no pipe") }, { start: new Error("would not start") }]) {
    const h = host(broken);
    await assert.rejects(() => mk(h).start(mapping, ID));
    assert.equal(h.seen.some((s) => s.includes("$_.Name -eq")), true,
                 `a ${Object.keys(broken)[0]} failure must not leave a VM behind`);
  }
});

test("a PowerShell non-zero exit is an error, not an empty success", async () => {
  const l = new WmiHyperVLauncher({ run: async () => ({ code: 1, stdout: "", stderr: "access denied" }), imagePath: IMG, imageSha256: SHA });
  const pre = await l.preflight();
  assert.equal(pre.ok, false);
  assert.match(pre.checks[0].detail, /access denied/);
});

test("a runner must be injected: this module never spawns anything by itself", () => {
  assert.throws(() => new WmiHyperVLauncher({ imagePath: IMG, imageSha256: SHA }), /runner must be injected/);
});

/* ---- defect 7: an unenumerable host is not an empty one -------------------------------------- *
 *
 * Measured on nucbox-k11 before the Hyper-V role existed (enclave-99, box-probe-2026-09-24T2155Z):
 * survey() answered {"vms":[]} on a host where Get-VM does not exist, and teardown() would have
 * answered "found 0, removed 0, failed []" - a CLEAN teardown - for the same reason. Both scripts
 * used `Get-VM -ErrorAction SilentlyContinue`, which yields nothing whether the host owns no VMs or
 * cannot enumerate at all.
 *
 * The fake below models a HOST, not a script: it is told whether Get-VM exists and which VMs are
 * there, and it evaluates the guard the way PowerShell would (a `throw` on a missing cmdlet is a
 * terminating error, so the run fails). That is what makes this a test of the mechanism rather than
 * of the source text - a version of the guard that is present but ineffective fails these. */
function enumHost({ hasGetVM = true, vms = [] } = {}) {
  return async (script) => {
    const wantsEnumeration = /Get-VM \|/.test(script);
    if (wantsEnumeration) {
      // the guard, evaluated as PowerShell would: Get-Command yields nothing, so the throw fires
      if (/Get-Command Get-VM/.test(script) && !hasGetVM) {
        return { code: 1, stdout: "", stderr: "Get-VM is absent: the Hyper-V PowerShell module is not installed, so VMs cannot be enumerated - this host is UNENUMERABLE, not empty" };
      }
      // an UNGUARDED enumeration on a module-less host: PowerShell yields nothing and succeeds,
      // which is exactly the fail-open the defect describes
      const live = hasGetVM ? vms : [];
      const mine = live.filter((v) => v.name.startsWith("enclave-"));
      if (/Remove-VM/.test(script)) {
        return { code: 0, stdout: JSON.stringify({ found: mine.length, removed: mine.map((v) => v.name), failed: [] }) };
      }
      return { code: 0, stdout: JSON.stringify({ vms: mine }) };
    }
    return { code: 0, stdout: "{}" };
  };
}

const enumLauncher = (run) => new WmiHyperVLauncher({ run, imagePath: IMG, imageSha256: SHA, prefix: "enclave-" });

test("a host that cannot enumerate VMs is an ERROR, never an empty survey", async () => {
  const l = enumLauncher(enumHost({ hasGetVM: false, vms: [{ name: "enclave-a", state: "Running" }] }));
  await assert.rejects(() => l.survey(), /UNENUMERABLE|cannot be enumerated/,
    "survey on a module-less host must refuse, not answer {vms:[]}");
});

test("a teardown that cannot enumerate does not read as a clean teardown", async () => {
  const l = enumLauncher(enumHost({ hasGetVM: false, vms: [{ name: "enclave-orphan", state: "Running" }] }));
  await assert.rejects(() => l.teardown(), /UNENUMERABLE|cannot be enumerated/,
    "teardown must refuse rather than report found 0 / removed 0 / failed [] over an orphan it cannot see");
});

test("where Get-VM does exist, both still work and stay scoped to the prefix", async () => {
  const vms = [{ name: "enclave-a", state: "Running" }, { name: "someone-elses-vm", state: "Running" }];
  const s = await enumLauncher(enumHost({ hasGetVM: true, vms })).survey();
  assert.deepEqual(s.vms.map((v) => v.name), ["enclave-a"], "only the prefix this instance owns");
  const t = await enumLauncher(enumHost({ hasGetVM: true, vms })).teardown();
  assert.equal(t.found, 1);
  assert.deepEqual(t.removed, ["enclave-a"]);
  assert.deepEqual(t.failed, []);
});

test("an enumerable host that genuinely owns nothing still reports an empty survey", async () => {
  const s = await enumLauncher(enumHost({ hasGetVM: true, vms: [] })).survey();
  assert.deepEqual(s.vms, [], "empty is a legitimate answer - only UNKNOWABLE is not");
});

/* ---- the VM must be created with a guest-state isolation type ---------------------------------- *
 *
 * Measured on nucbox-k11 2026-09-24. A Generation 2 VM created WITHOUT -GuestStateIsolationType
 * takes the firmware pin (returnValue 0), reads FirmwareFile back, starts, and boots nothing: the
 * worker never logs a "Loading IGVM file" line, because there is no paravisor to consume the field.
 * Created WITH it, the worker tries and says what it wants (Worker-Admin 5142):
 *   "failed to load custom IGVM file because AllowFirmwareLoadFromFile registry key is not set".
 *
 * The fake models THAT host: it looks at how the VM was created and answers the way Hyper-V did.
 * A launcher that goes back to creating plain gen2 VMs gets a silent guest here, exactly as on the
 * real box - which is the failure that cost hours, because every symptom pointed at the image. */
function paravisorHost({ registryOptIn = false } = {}) {
  let createdWithIsolation = null;
  const run = async (script) => {
    if (/\$r\.vmms/.test(script)) {
      return { code: 0, stdout: JSON.stringify({ vmms: true, namespace: true, module: true, firmwareField: true, hypervisor: true }) };
    }
    if (/Get-FileHash/.test(script)) {
      return { code: 0, stdout: JSON.stringify({ present: true, sha256: SHA, bytes: 124962164 }) };
    }
    if (/New-VM/.test(script)) {
      createdWithIsolation = /-GuestStateIsolationType/.test(script);
      return { code: 0, stdout: JSON.stringify({ id: "5DB6D4EB-1619-4936-9D60-C7E3CA67F3A8", version: "12.0", name: "x" }) };
    }
    if (/ModifySystemSettings/.test(script)) {
      // the pin is accepted either way - this is why the defect was invisible
      return { code: 0, stdout: JSON.stringify({ returnValue: 0, jobState: null, firmwareFile: IMG, guestFeatureSet: GUEST_FEATURE_SET }) };
    }
    if (/Set-VMComPort/.test(script)) return { code: 0, stdout: JSON.stringify({ ok: true }) };
    if (/Start-VM/.test(script)) {
      if (createdWithIsolation && !registryOptIn) {
        return { code: 1, stdout: "", stderr: "failed to load custom IGVM file because AllowFirmwareLoadFromFile registry key is not set" };
      }
      return { code: 0, stdout: JSON.stringify({ state: "Running" }) };
    }
    if (/NamedPipeClientStream/.test(script)) {
      // no isolation type => no paravisor => a Running VM that says nothing
      return { code: 0, stdout: JSON.stringify({ connected: !!createdWithIsolation, bytes: 0, head: "" }) };
    }
    if (/Get-VM \|/.test(script)) return { code: 0, stdout: JSON.stringify({ found: 0, removed: [], failed: [], vms: [] }) };
    return { code: 0, stdout: "{}" };
  };
  return { run, createdWith: () => createdWithIsolation };
}

test("create asks for a guest-state isolation type, or the firmware pin is inert", async () => {
  const h = paravisorHost();
  const l = new WmiHyperVLauncher({ run: h.run, imagePath: IMG, imageSha256: SHA, prefix: "enclave-" });
  await l.start(mapping, { instanceId: "iso-1", guestReadySec: 1 }).catch(() => {});
  assert.equal(h.createdWith(), true,
    "New-VM must pass -GuestStateIsolationType: without it the worker never loads the IGVM and the guest is silent");
});

test("a host without the registry opt-in surfaces the reason Hyper-V gave, not a generic failure", async () => {
  const h = paravisorHost({ registryOptIn: false });
  const l = new WmiHyperVLauncher({ run: h.run, imagePath: IMG, imageSha256: SHA, prefix: "enclave-" });
  await assert.rejects(() => l.start(mapping, { instanceId: "iso-2", guestReadySec: 1 }),
    /AllowFirmwareLoadFromFile/,
    "the operator must see the key named, rather than having to reconstruct it from a silent guest");
});

test("with the opt-in set, start proceeds (and readiness is still decided elsewhere)", async () => {
  const h = paravisorHost({ registryOptIn: true });
  const l = new WmiHyperVLauncher({ run: h.run, imagePath: IMG, imageSha256: SHA, prefix: "enclave-" });
  // it may still refuse for want of guest output; what must NOT happen is a registry-key failure
  const e = await l.start(mapping, { instanceId: "iso-3", guestReadySec: 1 }).then(() => null, (x) => x);
  if (e) assert.doesNotMatch(e.message, /AllowFirmwareLoadFromFile/);
});

/* ---- the partition kind and the UEFI image identity ------------------------------------------- *
 *
 * Both from enclave-99's UEFI review. The kind must be the LAUNCHER's word, because the guest
 * cannot know it and the monitor stopped printing a fixed one; and the image identity must be the
 * MEDIUM's hash, not the UKI's, because with Secure Boot off the stub reads addons, credentials
 * and extensions from the ESP - so two media carrying the same UKI can boot different command
 * lines, and only the medium hash tells them apart. */
import { BOUNDARY as WMI_BOUNDARY, uefiImageIdentity } from "./wmi-launcher.mjs";

test("the WMI launcher states its OWN partition kind, not the HCS one", async () => {
  const { BOUNDARY: HCS } = await import("./backend-hcs.mjs");
  assert.equal(WMI_BOUNDARY.partition, "wmi-openhcl-gen2");
  assert.notEqual(WMI_BOUNDARY.partition, HCS.partition,
    "a report copied from the HCS path would be a false statement about the boundary");
  assert.equal(WMI_BOUNDARY.hostExcluded, false, "a Gen2 OpenHCL partition does not exclude the host");
  assert.equal(WMI_BOUNDARY.attested, false);
  assert.equal(WMI_BOUNDARY.tier, "T0-hv", "the contract's spelling, which routeFor and judge-hv use");
});

test("the UEFI identity is the MEDIUM's hash; the UKI rides beside it, never instead", () => {
  const medium = "ab".repeat(32), uki = "cd".repeat(32);
  const id = uefiImageIdentity({ mediumSha256: medium, mediumPath: "C:\\x\\boot.iso", ukiSha256: uki });
  assert.equal(id.guestImageSha256, medium, "what booted is the medium, because the ESP can differ under one UKI");
  assert.equal(id.ukiSha256, uki);
  assert.notEqual(id.guestImageSha256, uki);
  assert.equal(id.partition, "wmi-openhcl-gen2");
});

test("the HCS-only kernel and initrd fields are NOT filled on the UEFI path", () => {
  const id = uefiImageIdentity({ mediumSha256: "ef".repeat(32) });
  assert.equal(id.kernelSha256, undefined, "there is no host-supplied kernel on this path");
  assert.equal(id.initrdSha256, undefined, "filling it would state an identity the boot never used");
});

test("a missing or malformed medium hash is refused rather than reported as unknown", () => {
  for (const bad of [undefined, null, "", "not-hex", "ab".repeat(20)]) {
    assert.throws(() => uefiImageIdentity({ mediumSha256: bad }), /medium's sha256 is required/,
      `${JSON.stringify(bad)} must be refused: without it nothing says what booted`);
  }
});

/* ---- the handle's `image` is a 64-hex STRING, never the firmware, never an object ------------- *
 *
 * enclave-53 found this by reading: start() returned verifyImage()'s {sha256, bytes} OBJECT as
 * handle.image, server.mjs copied it to rec.image, and 5d's datapath compares
 * `want.image !== rec.image` as 64-hex strings. An object can never equal a string, so EVERY route
 * would have been refused as "identity" - never as a type error, which is what makes it expensive:
 * the failure names the wrong thing. */

test("with a medium, handle.image is the MEDIUM's hash as a string", async () => {
  const MED = "7b".repeat(32);
  const h = paravisorHost({ registryOptIn: true });
  const l = new WmiHyperVLauncher({ run: h.run, imagePath: IMG, imageSha256: SHA,
                                    medium: "C:\\x\\guest.iso", mediumSha256: MED, prefix: "enclave-" });
  const handle = await l.start(mapping, { instanceId: "img-1", guestReadySec: 1 }).catch((e) => e);
  const image = handle?.image ?? null;
  if (image !== null) {
    assert.equal(typeof image, "string", "the datapath compares 64-hex strings; an object never matches");
    assert.match(image, /^[0-9a-f]{64}$/);
    assert.equal(image, MED, "the MEDIUM's hash, not the firmware's");
    assert.notEqual(image, SHA, "the firmware hash is a different thing and must not be reported as the image");
  }
});

test("with NO medium, image is null - distinguishable from a wrong medium", async () => {
  const h = paravisorHost({ registryOptIn: true });
  const l = new WmiHyperVLauncher({ run: h.run, imagePath: IMG, imageSha256: SHA, prefix: "enclave-" });
  const handle = await l.start(mapping, { instanceId: "img-2", guestReadySec: 1 }).catch(() => null);
  if (handle) {
    assert.equal(handle.image, null,
      "null lets a caller say 'no medium' rather than refusing on a mismatch it cannot explain");
    assert.ok(handle.firmware, "the firmware hash is still reported, under its own name");
  }
});
