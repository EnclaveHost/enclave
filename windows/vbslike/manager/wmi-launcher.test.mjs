// The supported launcher, driven entirely by INJECTED PowerShell answers.
//
// Every test here is mocked. None of it has run against a Hyper-V host: the type-1 recipe this
// launcher ports ran on nucbox-k11 (uefi-dev-boot.ps1, e0de58cf), but THIS code has only ever run
// against the fakes below. What is tested is what can be: the commands it generates, the order it
// does things in, what it refuses, and what it cleans up when a step fails halfway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WmiHyperVLauncher, CMD, OWNER_MARKER, HYPERV_MODULE_SHA256, FIRMWARE_OPT_IN, BOOT_UEFI, BOOT_LINUX_DIRECT,
         notesFor, q } from "./wmi-launcher.mjs";
import { TYPE1, PREFLIGHT_OK, VM_ID, defineAnswer, keyOf, startAndReadAnswer } from "./fake-hyperv.mjs";

const IMG = "C:\\Users\\claude\\vbs-like\\openhcl-ownguest.bin";
const SHA = "2d7353760b89b81b6f47759382bb2e83c325d73ed0825734f30fc4051183dfb3";
const mapping = { appId: "708e640945d196df5829aa4ea490774c18ef6876a0d9239f574986ad18ae3782",
                  record: { policy: { cpuPercent: 100, memMiB: 512, vcpus: 1 } } };

/**
 * A host that answers whatever the script asks for, and records every script it was given. The
 * define answer is DERIVED from the define script (fake-hyperv.mjs); an override object models a host
 * that read back something other than what was asked; an Error models a script that failed; a
 * function answers per script.
 */
function host(over = {}) {
  const seen = [];
  const answers = {
    preflight: PREFLIGHT_OK,
    imageHash: { present: true, sha256: SHA, bytes: 124962164 },
    start: { state: "Running" },
    readConsole: { connected: true, bytes: 64, head: "guest said something" },
    teardown: { found: 1, removed: ["x"], failed: [] },
    removeExact: { found: true, removed: true },
    removeById: { found: true, removed: true },
    retire: { present: true, retired: true },
    stop: { ok: true },
    ...over,
  };
  const run = async (script) => {
    seen.push(script);
    const key = keyOf(script);
    let a = typeof answers[key] === "function" ? answers[key](script) : answers[key];
    if (key === "startAndRead") a = startAndReadAnswer((k) => typeof answers[k] === "function" ? answers[k](script) : answers[k]);
    if (key === "define" && !(a instanceof Error)) a = defineAnswer(script, a || {});
    if (a instanceof Error) return { code: 1, stdout: "", stderr: a.message };
    return { code: 0, stdout: JSON.stringify(a ?? { ok: true }), stderr: "" };
  };
  return { run, seen, keys: () => seen.map(keyOf) };
}
const ID = { instanceId: "dep0001-708e6409" };
const NAME = "enclave-app-t-dep0001-708e6409";
const RUN_COPY = "C:\\Users\\claude\\vbs-like\\" + NAME + ".vmgs";
const mk = (h, over = {}) => new WmiHyperVLauncher({ run: h.run, imagePath: IMG, imageSha256: SHA, prefix: "enclave-app-t-", ...TYPE1, ...over });

/** The define script with the shared configuration, for tests that read the PowerShell itself. */
const DEF = (over = {}) => CMD.defineType1({
  name: "enclave-app-t-x", memMiB: 512, vcpus: 1, notes: OWNER_MARKER, firmware: IMG, firmwareSha256: SHA,
  hypervModule: TYPE1.hypervModule, hypervModuleSha256: HYPERV_MODULE_SHA256, guestStateMaster: TYPE1.guestStateMaster,
  guestStateRun: "C:\\Users\\claude\\vbs-like\\enclave-app-t-x.vmgs", archiveDir: TYPE1.guestStateArchiveDir,
  pipe: "\\\\.\\pipe\\enclave-app-t-x-com1", boot: BOOT_LINUX_DIRECT, ...over });
const MEDIUM = "C:\\Users\\claude\\vbs-like\\guest-production-uki7af57aab.iso";
const MED = "ca245eae" + "7b".repeat(28);

/* ---- the definition IS the recipe, and nothing of the old pin path is left --------------------- */

test("the VM is defined by petri's pinned New-CustomVM as type 1, in ONE call, with none of the old pin path", () => {
  const s = DEF();
  assert.ok(s.includes(`$mod = ${q(TYPE1.hypervModule)}; $pin = '${HYPERV_MODULE_SHA256}'; $modSha = (ShaOf $mod); if ($modSha -ne $pin) { throw`),
            "the module that DEFINES the VM is checked against its pin");
  assert.equal(HYPERV_MODULE_SHA256, "17ca4352c500d3498f71be420ddfa418c7ed1d1b5f455856c24e633a4635e49c", "the recipe's pin");
  assert.ok(s.indexOf("ShaOf $mod") < s.indexOf("Import-Module $mod"), "hashed BEFORE it is imported");
  assert.match(s, /New-CustomVM -VMName \$name -GuestStateIsolationEnabled \$true -GuestStateIsolationType 1 -GuestStateIsolationMode 0 -FirmwareFile \$fw -GuestStateFilePath \$gsf -TpmEnabled \$true -SecureBootEnabled \$false -Com1 \$true -Memory \(512 \* 1MB\) -VpCount 1/,
    "the recipe's type-1 call, parameter for parameter");
  assert.equal((s.match(/New-CustomVM -VMName/g) || []).length, 1, "one definition, as petri does it");
  // THE REMOVED PATH. New-VM patched afterwards through ModifySystemSettings never started as type 1.
  assert.doesNotMatch(s, /ModifySystemSettings/, "no firmware pin written on afterwards");
  assert.doesNotMatch(s, /\$vssd\.(GuestFeatureSet|FirmwareFile)\s*=/, "GuestFeatureSet and FirmwareFile are READ here, never written");
  assert.doesNotMatch(s, /New-VM\b/, "no New-VM");
  assert.doesNotMatch(s, /IncreaseVtl2Memory|Vtl2AddressRangeSize|Vtl2MmioAddressRangeSize|Vtl2AddressSpaceConfigurationMode\s*=/,
    "NO VTL2 auto-placement trio on type 1: the image is fixed-GPA, and asking it to auto-place was the bare 12030");
  assert.equal("pinFirmware" in CMD, false, "the old pin builder is gone, not merely unused");
  assert.equal("create" in CMD, false, "and so is the New-VM builder");
});

test("the definition reads back every field it relies on, and throws on a mismatch", () => {
  const s = DEF();
  for (const [re, why] of [
    [/\[int\]\$vssd\.GuestStateIsolationType -ne 1\) \{ throw/, "GuestStateIsolationType"],
    [/-not \[bool\]\$vssd\.GuestStateIsolationEnabled\) \{ throw/, "GuestStateIsolationEnabled"],
    [/\[int64\]\$vssd\.GuestFeatureSet -ne 513\) \{ throw/, "GuestFeatureSet 0x201"],
    [/\[int\]\$vssd\.Vtl2AddressSpaceConfigurationMode -ne 0\) \{ throw/, "the VTL2 mode: no auto placement"],
    [/\[string\]\$vssd\.FirmwareFile -ne \$fw\) \{ throw/, "the firmware"],
    [/\$gsfBack -ne \[System\.IO\.Path\]::GetFullPath\(\$gsf\)\) \{ throw/, "the guest-state file is this run's copy"],
    [/\$nicsAfter -ne 0\) \{ throw/, "no NIC"],
    [/-not \[bool\]\$sec\.VirtualizationBasedSecurityOptOut\) \{ throw/, "the guest VBS opt-out"],
    [/\$com1 -ne \$pipe\) \{ throw/, "COM1"],
    [/\[string\]\$fwc\.SecureBoot -ne 'Off'\) \{ throw/, "Secure Boot off"],
    [/LoadOptions/, "no LoadOptions on a boot entry"],
    [/if \(-not \$sec\) \{ throw/, "a type-1 VM without security settings is not what it should be"],
  ]) assert.match(s, re, why);
  assert.match(s, /Get-VMNetworkAdapter -VM \$vm[^;]*\);\s*if \(\$nics\.Count\) \{ \$nics \| Remove-VMNetworkAdapter -Confirm:\$false \}/, "NICs removed");
  assert.match(s, /Set-VMSecurity -VM \$vm -VirtualizationBasedSecurityOptOut \$true -EA Stop/, "the opt-out this host requires");
  assert.match(s, /'NT VIRTUAL MACHINE\\' \+ \$vm\.Id\.Guid \+ ':R'/, "a read grant for the VM's own SID");
  assert.match(s, /& icacls \$gp \/grant \$grant \| Out-Null; if \(\$LASTEXITCODE -ne 0\) \{ throw/, "and its exit code checked");
  assert.match(s, /Set-VMComPort -VM \$vm -Number 1 -Path \$pipe/, "COM1 to our pipe");
  assert.ok(s.includes(`$pin = '${SHA}'; $fwSha = (ShaOf $fw); if ($fwSha -ne $pin) { throw`),
            "the IGVM hashed again, at define time");
});

test("guest state: a fresh copy of the master per run, compared to it, never the master itself, never overwritten", () => {
  const s = DEF();
  assert.match(s, /Copy-Item -LiteralPath \$master -Destination \$gsf; \$copied = \$true/);
  assert.match(s, /\$copySha -ne \$masterSha\) \{ throw/, "the copy must be byte-identical to the master");
  assert.match(s, /-GuestStateFilePath \$gsf /, "the VM is handed the COPY");
  assert.doesNotMatch(s, /-GuestStateFilePath \$master/, "never the master");
  assert.match(s, /if \(Test-Path -LiteralPath \$gsf\) \{ throw \('a guest-state run copy already exists/, "a previous run's store is never overwritten");
  assert.ok(s.indexOf("already exists at") < s.indexOf("try {"), "refused before anything is created");
  assert.match(DEF({ guestStateMasterSha256: "4f".repeat(32) }), /\$pin = '4f4f[0-9a-f]*'; if \(\$masterSha -ne \$pin\)/, "and a master pin, when configured, is enforced");
});

test("the Notes carry the identity, and go on FIRST, before anything else that can fail", async () => {
  const identity = { id: "hv" + "1".repeat(32), name: "0x" + "e6".repeat(32), appId: mapping.appId };
  const notes = notesFor({ ...identity, instanceId: ID.instanceId });
  const s = DEF({ notes });
  const at = (x) => s.indexOf(x);
  assert.ok(s.includes(`Set-VM -VM $vm -Notes ${q(notes)}`), "notesFor(identity), not the bare marker");
  assert.ok(at("Set-VM -VM $vm -Notes") > at("New-CustomVM -VMName"), "after the VM exists");
  for (const later of ["-AutomaticStartAction", "Remove-VMNetworkAdapter", "Set-VMSecurity", "& icacls", "Set-VMComPort"])
    assert.ok(at("Set-VM -VM $vm -Notes") < at(later), `before ${later}: a VM without its marker is invisible to a marker-scoped teardown`);
  assert.match(s, /Set-VM -VM \$vm -AutomaticStartAction Nothing -AutomaticStopAction TurnOff/, "it must not come back by itself after a reboot");
  // and through start(): what the launcher sends, and what it accepts back
  const h = host();
  const r = await mk(h).start(mapping, { ...ID, identity });
  const def = h.seen.find((x) => keyOf(x) === "define");
  assert.ok(def.includes(q(notes)), "start() writes this deployment's identity into the Notes");
  assert.equal(r.vmId, VM_ID);
  await assert.rejects(() => mk(host({ define: { notes: OWNER_MARKER } })).start(mapping, { ...ID, identity }),
                       /Notes do not carry this domain's identity/, "a VM whose Notes lost the identity is refused, and removed");
});

/* ---- the two boot forms: stated, never inferred ------------------------------------------------ */

test("linux-direct attaches NOTHING, and says so by reading back no DVD and no disk", () => {
  const s = DEF();
  assert.doesNotMatch(s, /Add-VMDvdDrive|Add-VMScsiController|Set-VMFirmware -VM \$vm -FirstBootDevice/);
  assert.match(s, /linux-direct: a DVD drive is defined, and no medium may be attached/);
  assert.match(s, /\$diskCount -ne 0\) \{ throw/);
  assert.match(s, /foreach \(\$gp in @\(\$fw\)\)/, "the only grant is on the IGVM: there is no medium");
  assert.throws(() => DEF({ medium: MEDIUM, mediumSha256: MED }), /linux-direct boot attaches no medium/);
});

test("uefi-medium attaches ONE DVD, hashes it AT ATTACH TIME, and boots only from it", () => {
  const s = DEF({ boot: BOOT_UEFI, medium: MEDIUM, mediumSha256: MED });
  assert.match(s, /if \(-not \(Get-VMScsiController -VM \$vm -EA SilentlyContinue\)\) \{ Add-VMScsiController -VM \$vm \}/,
    "New-CustomVM makes no storage controller");
  assert.ok(s.includes(`$medium = ${q(MEDIUM)};`));
  assert.match(s, /Add-VMDvdDrive -VM \$vm -Path \$medium;/);
  assert.match(s, /\$mediumPath = \[string\]\$dvds\[0\]\.Path; \$mediumSha = \(ShaOf \$mediumPath\)/,
    "hashed from the path the VM is ACTUALLY pointed at, not from the pin argument");
  assert.match(s, /\$mediumSha -ne \$mediumWant\) \{ throw/);
  assert.match(s, /Set-VMFirmware -VM \$vm -FirstBootDevice \$dvds\[0\]/);
  assert.match(s, /\$boot\.Count -ne 1\) \{ throw/, "exactly one boot entry");
  assert.match(s, /foreach \(\$gp in @\(\$fw, \$medium\)\)/, "grants on the IGVM and the medium");
  assert.throws(() => DEF({ boot: BOOT_UEFI }), /needs the medium and its sha256/);
  assert.throws(() => DEF({ boot: "guess" }), /stated rather than inferred/);
});

test("the boot form is an explicit constructor option, never inferred", async () => {
  const run = async () => ({ code: 0, stdout: "{}", stderr: "" });
  assert.throws(() => new WmiHyperVLauncher({ run, imagePath: IMG, imageSha256: SHA, medium: MEDIUM, mediumSha256: MED }),
                /never inferred/, "a medium with no boot form is refused, not read as uefi-medium");
  assert.throws(() => new WmiHyperVLauncher({ run, imagePath: IMG, imageSha256: SHA, boot: BOOT_LINUX_DIRECT, medium: MEDIUM, mediumSha256: MED }),
                /no medium may be attached/);
  assert.throws(() => new WmiHyperVLauncher({ run, imagePath: IMG, imageSha256: SHA, boot: BOOT_UEFI }), /needs the medium's path and its sha256/);
  assert.throws(() => new WmiHyperVLauncher({ run, imagePath: IMG, imageSha256: SHA, boot: "uefi" }), /boot must be one of/);
  // No boot form: it can still survey, stop and tear down - but it will not start anything.
  const h = host();
  const l = new WmiHyperVLauncher({ run: h.run, imagePath: IMG, imageSha256: SHA, prefix: "enclave-app-t-", ...TYPE1, boot: null });
  await assert.rejects(() => l.start(mapping, ID), (e) => e.code === "launcher_unconfigured" && /no boot form/.test(e.message));
  assert.deepEqual(h.keys(), [], "refused before it asked the host anything");
  const pre = await l.preflight();
  assert.equal(pre.ok, false, "and /health cannot say canStart");
  assert.equal(pre.checks.find((c) => c.name === "boot form").ok, false);
});

/* ---- AllowFirmwareLoadFromFile: reported, never touched ---------------------------------------- */

test("preflight REPORTS AllowFirmwareLoadFromFile as its own named check", async () => {
  const s = CMD.preflight({ hypervModule: TYPE1.hypervModule, guestStateMaster: TYPE1.guestStateMaster });
  assert.match(s, /Get-Item -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Virtualization'/);
  assert.match(s, /\$k\.GetValue\('AllowFirmwareLoadFromFile'\)/);
  assert.match(s, /\$k\.GetValueKind\('AllowFirmwareLoadFromFile'\)/);
  const answer = async (fo) => (await mk(host({ preflight: { ...PREFLIGHT_OK, firmwareOptIn: fo } })).preflight())
    .checks.find((c) => c.name === "AllowFirmwareLoadFromFile");
  const set = await answer({ present: true, value: 1, kind: "DWord" });
  assert.equal(set.ok, true);
  const absent = await answer({ present: false, value: null, kind: null });
  assert.equal(absent.ok, false);
  assert.match(absent.detail, /HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Virtualization\\AllowFirmwareLoadFromFile is ABSENT/);
  assert.match(absent.detail, /5142/, "the measured reason");
  assert.match(absent.detail, /never sets, changes or removes it/);
  assert.match(absent.detail, /open owner decision/);
  assert.equal((await answer({ present: true, value: 0, kind: "DWord" })).ok, false, "present but 0 is not set");
  assert.equal((await answer({ present: true, value: "1", kind: "String" })).ok, false, "only the DWORD form the recipe proved counts");
});

test("start() REFUSES without the opt-in, names it, and creates nothing", async () => {
  const h = host({ preflight: { ...PREFLIGHT_OK, firmwareOptIn: { present: false, value: null, kind: null } } });
  const e = await mk(h).start(mapping, ID).then(() => null, (x) => x);
  assert.ok(e, "it must refuse");
  assert.equal(e.code, "firmware_opt_in_absent");
  assert.match(e.message, /AllowFirmwareLoadFromFile is ABSENT/);
  assert.match(e.message, /Worker-Admin event 5142/);
  assert.deepEqual(h.keys(), ["preflight"], "refused on the preflight answer alone: nothing hashed, defined or started");
  // with the role ALSO missing, the role is the headline and the opt-in is still named
  const h2 = host({ preflight: { ...PREFLIGHT_OK, vmms: false, firmwareOptIn: { present: false } } });
  await assert.rejects(() => mk(h2).start(mapping, ID), (x) => x.code === "prerequisites_absent" && /AllowFirmwareLoadFromFile/.test(x.message));
});

test("no script this launcher generates writes the registry; only preflight names the setting, and only reads it", async () => {
  const REGISTRY_WRITE = /Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Clear-ItemProperty|Rename-ItemProperty|\breg(\.exe)?\s+(add|delete|import)|\.SetValue\(|\.DeleteValue\(|\.DeleteSubKey|\.CreateSubKey|OpenSubKey\([^)]*,\s*\$?true|HKLM:[^']*'\s*-(Name|Value)/i;
  const h = host();
  const l = mk(h);
  const r = await l.start(mapping, ID);
  await l.stop(r);
  l.created.add("enclave-app-t-orphan");
  await l.teardown();
  const u = mk(host(), { boot: BOOT_UEFI, medium: MEDIUM, mediumSha256: MED });
  await u.preflight();
  const scripts = [...h.seen, DEF(), DEF({ boot: BOOT_UEFI, medium: MEDIUM, mediumSha256: MED }),
    CMD.preflight(), CMD.preflight({ hypervModule: "x", guestStateMaster: "y" }), CMD.start({ vmId: VM_ID }),
    CMD.readConsole({ pipe: "\\\\.\\pipe\\x" }), CMD.removeById({ vmId: VM_ID }), CMD.removeExact({ name: "n" }),
    CMD.teardown({ prefix: "p-" }), CMD.survey({ prefix: "p-" }), CMD.stop({ name: "n" }), CMD.state({ name: "n" }),
    CMD.retireGuestState({ path: "C:\\r\\n.vmgs", runDir: "C:\\r", master: "C:\\r\\m.vmgs", archiveDir: "C:\\a", vmId: VM_ID, name: "n" }),
    CMD.imageHash(IMG)];
  assert.ok(h.keys().includes("define") && h.keys().includes("removeById") && h.keys().includes("retire"), "the full lifecycle was exercised");
  for (const s of scripts) {
    assert.doesNotMatch(s, REGISTRY_WRITE, `a registry write in: ${s.slice(0, 120)}`);
    if (/AllowFirmwareLoadFromFile/.test(s)) assert.match(s, /^\$r = \[ordered\]@\{\}/, "only the preflight script mentions the setting");
  }
});

/* ---- order, handle, and what the handle says about identity ------------------------------------ */

test("a good start does the steps in order and hands back a stoppable handle", async () => {
  const h = host();
  const r = await mk(h).start(mapping, ID);
  assert.deepEqual(h.keys(), ["preflight", "imageHash", "define", "startAndRead"],
                   "preflight, the IGVM's hash, ONE definition (read back inside it), start by Id, and the guest heard last");
  const startScript = h.seen[3];
  assert.match(startScript, new RegExp(`Get-VM -Id '${VM_ID}'`), "started BY THE ID it was defined with");
  assert.doesNotMatch(startScript, /-Name /);
  assert.equal(r.state, "Running");
  assert.equal(r.name, NAME, "named for the deployment instance, not the app");
  assert.ok(r.pipe.startsWith("\\\\.\\pipe\\"), "a named pipe, so the guest can be heard at all");
  assert.equal(r.isolationType, 1);
  assert.equal(r.boot, BOOT_LINUX_DIRECT);
  assert.equal(r.firmware.sha256, SHA, "the firmware hash, under its own name");
  assert.equal(r.vtpm.enabled, true);
  assert.equal(r.vtpm.pcrsRead, false, "a vTPM nobody reads is not attestation");
  assert.equal(r.definition.guestState.path, RUN_COPY, "this run's copy, beside the master");
  assert.equal(r.appReady, false);
  // THE RELAY GAP, left as it is: nothing loads the app or starts a relay, so the handle has none.
  assert.equal("relay" in r, false);
  assert.equal("tcpPort" in r, false);
  assert.equal(r.boundary.hostExcluded, false);
  assert.equal(r.boundary.attested, false);
});

test("the per-run guest-state copy is beside the master by default, or in a stated run directory", async () => {
  const h = host();
  await mk(h, { guestStateRunDir: "D:\\vmgs-runs" }).start(mapping, ID);
  assert.ok(h.seen.find((x) => keyOf(x) === "define").includes(`$gsf = 'D:\\vmgs-runs\\${NAME}.vmgs'`));
  const h2 = host();
  await mk(h2).start(mapping, ID);
  assert.ok(h2.seen.find((x) => keyOf(x) === "define").includes(`$gsf = ${q(RUN_COPY)}`));
});

/* ---- the read-back, refused on THIS side too, and a refusal removes BY ID ----------------------- */

test("a definition that does not read back as asked is refused, and the VM is removed by the Id it was defined with", async () => {
  for (const [bad, why] of [
    [{ isolationType: 16 }, /GuestStateIsolationType is 16, not 1/],
    [{ isolationEnabled: false }, /GuestStateIsolationEnabled/],
    [{ featureSet: 0x400 }, /GuestFeatureSet is 1024/],
    [{ vtl2Mode: 1 }, /VTL2 auto placement must not be set/],
    [{ firmwareFile: "C:\\somebody-elses.bin" }, /FirmwareFile is/],
    [{ firmwareSha256: "00".repeat(32) }, /the IGVM hashed/],
    [{ hypervModuleSha256: "00".repeat(32) }, /hyperv\.psm1 did not hash to its pin/],
    [{ guestStateFile: TYPE1.guestStateMaster }, /not this run's copy/],
    [{ vbsOptOut: false }, /VirtualizationBasedSecurityOptOut/],
    [{ nics: 1 }, /network adapter/],
    [{ com1: "\\\\.\\pipe\\somebody-else" }, /COM1 is/],
    [{ secureBoot: "On" }, /Secure Boot is "On"/],
    [{ disks: 1 }, /hard disk/],
    [{ dvds: 1 }, /linux-direct, and 1 DVD/],
    [{ vcpus: 2 }, /2 vCPUs, not 1/],
    [{ memBytes: 1 }, /bytes of memory/],
    [{ dynamicMemory: true }, /dynamic memory/],
    [{ automaticStartAction: "StartIfRunning" }, /come back by itself/],
  ]) {
    const h = host({ define: bad });
    await assert.rejects(() => mk(h).start(mapping, ID), why, JSON.stringify(bad));
    assert.equal(h.keys().some((k) => k === "start" || k === "startAndRead"), false, `${JSON.stringify(bad)}: never started`);
    const rm = h.seen.filter((x) => keyOf(x) === "removeById");
    assert.equal(rm.length, 1, `${JSON.stringify(bad)}: removed exactly once`);
    assert.match(rm[0], new RegExp(`Get-VM -Id '${VM_ID}'`), `${JSON.stringify(bad)}: BY THE CREATED ID`);
    assert.equal(h.keys().includes("removeExact"), false, "not by name");
  }
});

test("a failure after creation removes BY THE CREATED VM'S ID, then retires its guest-state copy", async () => {
  for (const broken of [
    { start: new Error("Start-VM refused: failed | Worker-Admin: [5142] failed to load custom IGVM file because AllowFirmwareLoadFromFile registry key is not set") },
    { start: { state: "Off" } },
    { readConsole: { connected: false, bytes: 0, head: "", note: "pipe not found" } },
    { readConsole: { connected: true, bytes: 0, head: "" } },
    { readConsole: new Error("the reader died") },
  ]) {
    const h = host(broken);
    const e = await mk(h).start(mapping, ID).then(() => null, (x) => x);
    const what = JSON.stringify(broken).slice(0, 60);
    assert.ok(e, `${what}: must refuse`);
    const keys = h.keys();
    const rm = h.seen.filter((x) => keyOf(x) === "removeById");
    assert.equal(rm.length, 1, `${what}: one removal`);
    assert.match(rm[0], new RegExp(`Get-VM -Id '${VM_ID}'`), `${what}: by the Id the define returned`);
    assert.match(rm[0], /not ours: the ownership marker is absent/, "removeById's ownership check, unchanged");
    assert.equal(keys.includes("removeExact"), false, `${what}: never by name once the Id is known`);
    assert.equal(h.seen.some((x) => x.includes(`StartsWith('${NAME}')`)), false, "and never by prefix");
    assert.ok(keys.indexOf("retire") > keys.indexOf("removeById"), `${what}: the guest state is retired only AFTER the VM is gone`);
    const ret = h.seen.find((x) => keyOf(x) === "retire");
    assert.match(ret, new RegExp(`Get-VM -Id '${VM_ID}'`), "and only once THAT VM is confirmed gone");
    assert.ok(ret.includes(q(RUN_COPY)), "this run's copy");
  }
  // the Worker-Admin reason reaches the caller verbatim
  await assert.rejects(() => mk(host({ start: new Error("Start-VM refused: x | Worker-Admin: [5142] failed to load custom IGVM file") })).start(mapping, ID), /\[5142\]/);
});

test("a VM that could not be removed is SAID to be still there, and its guest state is left alone", async () => {
  const h = host({ start: new Error("would not start"), removeById: { found: true, removed: false, error: "InvalidState" } });
  await assert.rejects(() => mk(h).start(mapping, ID), /cleanup could NOT remove enclave-app-t-dep0001-708e6409 \(5DB6D4EB-1619-4936-9D60-C7E3CA67F3A8\): InvalidState - it is still on this host/);
  assert.equal(h.keys().includes("retire"), false, "a store the worker may hold is never touched");
  // and a removal that could not even run is unknown, not absent
  const h2 = host({ start: new Error("would not start"), removeById: new Error("WMI is unavailable") });
  await assert.rejects(() => mk(h2).start(mapping, ID), /cleanup of enclave-app-t-dep0001-708e6409 \(5DB6D4EB-1619-4936-9D60-C7E3CA67F3A8\) did not run: WMI is unavailable - it may still be on this host/);
  assert.equal(h2.keys().includes("retire"), false);
});

test("a define that FAILS removes what it made itself, and the launcher then sweeps by EXACT name with the marker required", async () => {
  const h = host({ define: new Error("New-CustomVM: DefineSystem failed") });
  await assert.rejects(() => mk(h).start(mapping, ID), /DefineSystem failed/);
  assert.equal(h.keys().includes("removeById"), false, "no Id came back, so there is none to act on");
  const sweep = h.seen.filter((x) => keyOf(x) === "removeExact");
  assert.equal(sweep.length, 1);
  assert.match(sweep[0], new RegExp(`\\$_\\.Name -eq '${NAME}'`), "EXACT name, never a prefix");
  assert.match(sweep[0], /Notes -eq/, "and it must prove it is ours: this attempt never got a VM back");
  // the script's own catch: the VM it holds, or an unmarked/owned VM of exactly this name (it refused
  // a pre-existing one up front), and the copy retired only once no VM of the name remains
  const s = DEF();
  const c = s.slice(s.indexOf("} catch { $err = $_;"));
  assert.ok(c.length < s.length, "the define script's own catch");
  assert.match(c, /if \(\$vm\) \{ \$victims = @\(\$vm\) \} else \{ \$victims = @\(Get-VM -Name \$name/);
  assert.match(c, /IsNullOrWhiteSpace\(\[string\]\$_\.Notes\) -or \(\$_\.Notes -eq 'enclave-vbslike-app-domain'/);
  assert.match(c, /Remove-VM -VM \$v -Force -EA Stop/);
  assert.match(c, /if \(\$copied -and \(@\(Get-VM -Name \$name -EA SilentlyContinue\)\.Count -eq 0\)/);
  assert.match(c, /throw \$err/, "and the ORIGINAL error is rethrown");
  assert.ok(s.indexOf("already exists: refusing to define a second one") < s.indexOf("try {"),
            "a VM of this name that already existed is refused BEFORE the try, so the catch can never take it");
});

/* ---- retiring the per-run guest state --------------------------------------------------------- */

test("stop() removes by Id and then archives and removes that VM's guest-state copy", async () => {
  const h = host();
  const l = mk(h);
  const r = await l.stop({ name: NAME, vmId: VM_ID });
  assert.deepEqual(h.keys(), ["removeById", "retire"], "the VM first, its store only after");
  assert.equal(r.removed, true);
  assert.equal(r.guestState.retired, true);
  const s = h.seen[1];
  assert.ok(s.includes(q(RUN_COPY)));
  assert.match(s, /StartsWith\(\$dir, \[System\.StringComparison\]::OrdinalIgnoreCase\)/, "only under the run directory");
  assert.match(s, /EndsWith\('\.vmgs'/, "only a .vmgs");
  assert.match(s, /it is the MASTER, an input that is never handed to a VM/, "never the master");
  assert.match(s, /is still present: its guest state is not retired while the worker may hold it/);
  assert.match(s, /Copy-Item -LiteralPath \$gsf -Destination \$dest/, "ARCHIVED");
  assert.ok(s.indexOf("-ne $rsha") < s.indexOf("Remove-Item -LiteralPath $gsf"), "and the archive verified before the copy is deleted");
  assert.ok(s.includes(q(TYPE1.guestStateArchiveDir)));
  // a retirement that fails is REPORTED, never turned into "the VM is still running"
  const bad = await mk(host({ retire: new Error("access denied") })).stop({ name: NAME, vmId: VM_ID });
  assert.equal(bad.stopped, true);
  assert.match(bad.guestState.error, /access denied/);
  // and a VM that did not go away keeps its store
  const stuck = host({ removeById: { found: true, removed: false, error: "InvalidState" } });
  await assert.rejects(() => mk(stuck).stop({ name: NAME, vmId: VM_ID }), (e) => e.code === "stop_failed");
  assert.deepEqual(stuck.keys(), ["removeById"]);
  assert.throws(() => CMD.retireGuestState({ path: "C:\\r\\n.vmgs", runDir: "C:\\r", archiveDir: "C:\\a" }), /VM Id or name is required/);
});

test("start is by Id, only for a VM carrying our marker, and a refusal carries the Worker-Admin reason", () => {
  const s = CMD.start({ vmId: VM_ID });
  assert.match(s, new RegExp(`\\$v = Get-VM -Id '${VM_ID}'`));
  assert.match(s, /not ours: the ownership marker is absent, so this VM is not started/);
  assert.match(s, /Get-WinEvent -LogName 'Microsoft-Windows-Hyper-V-Worker-Admin'/);
  assert.doesNotMatch(s, /-Name /);
  assert.throws(() => CMD.start({ vmId: "x'; Remove-VM *" }), /not a VM Id/);
});

test("the console reader keeps at most ONE read pending, on an Asynchronous pipe", () => {
  const s = CMD.readConsole({ pipe: "\\\\.\\pipe\\x-com1", seconds: 12 });
  assert.match(s, /\[System\.IO\.Pipes\.PipeOptions\]::Asynchronous/,
    "without it .NET Framework's ReadAsync is a blocking read that ignores cancellation");
  assert.match(s, /if \(\$null -eq \$pending\) \{ \$pending = \$cli\.ReadAsync/, "a new read only when none is pending");
  assert.match(s, /\$n = \$pending\.Result; \$pending = \$null/);
  assert.equal((s.match(/ReadAsync/g) || []).length, 1);
});

test("the longest script, the uefi definition, stays well under Windows' 32,767-char command line", async () => {
  // -EncodedCommand is base64 of UTF-16: ~2.7 command-line characters per script character. A script
  // that outgrows the limit fails at CreateProcess, before PowerShell ever sees it. Worst realistic
  // case: long paths everywhere, a full identity in the Notes, every optional pin set.
  const { powershellArgs } = await import("./psrun.mjs");
  const P = (leaf) => "C:\\Users\\claude\\vbs-like\\a-rather-long-directory-name-for-this-host\\" + leaf;
  const notes = notesFor({ id: "hv" + "f".repeat(32), name: "0x" + "e6".repeat(32), instanceId: "hvffffffffffffff-708e6409", appId: "ab".repeat(32) });
  const name = "enclave-app-hvffffffffffffff-708e6409";
  const s = CMD.defineType1({ name, memMiB: 65536, vcpus: 16, notes, firmware: P("openhcl-cvm-a7b0bd4-CONTROL-32d464cc.bin"), firmwareSha256: SHA,
    hypervModule: P("hyperv.psm1"), hypervModuleSha256: HYPERV_MODULE_SHA256, hypervUtilitiesSha256: "1".repeat(64),
    guestStateMaster: P("type1.vmgs"), guestStateMasterSha256: "2".repeat(64), guestStateRun: P(name + ".vmgs"),
    archiveDir: P("vbs-evidence"), pipe: `\\\\.\\pipe\\${name}-com1`, boot: BOOT_UEFI,
    medium: P("guest-production-uki7af57aab.iso"), mediumSha256: MED });
  const line = ["powershell.exe", ...powershellArgs(s)].join(" ").length;
  assert.ok(line < 28000, `the uefi definition encodes to a ${line}-char command line; keep it under 28000 to leave headroom below 32767`);
});

/* ---- unchanged ---------------------------------------------------------------------------------- */

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
  const h = host({ preflight: { ...PREFLIGHT_OK, vmms: false, namespace: false, module: false, firmwareField: false, hypervisor: true } });
  const l = mk(h);
  const pre = await l.preflight();
  assert.equal(pre.ok, false);
  assert.deepEqual(pre.checks.filter((c) => !c.ok).map((c) => c.name).sort(),
    ["Hyper-V PowerShell module", "Msvm_VirtualSystemSettingData.FirmwareFile", "root\\virtualization\\v2", "vmms service"].sort());
  await assert.rejects(() => l.start(mapping, ID), /the Hyper-V role is not usable/);
  assert.equal(h.seen.some((s) => s.includes("New-CustomVM")), false, "nothing was created");
});

test("preflight reports the pinned module and the guest-state master as facts, not configuration", async () => {
  const bad = await mk(host({ preflight: { ...PREFLIGHT_OK, hypervModule: { present: true, sha256: "00".repeat(32) },
                                                            guestStateMaster: { present: false } } })).preflight();
  const by = (n) => bad.checks.find((c) => c.name === n);
  assert.equal(by("hyperv.psm1 (New-CustomVM), pinned").ok, false);
  assert.match(by("hyperv.psm1 (New-CustomVM), pinned").detail, /not the pinned 17ca4352/);
  assert.equal(by("type-1 guest-state master (VMGS)").ok, false);
  assert.equal((await mk(host()).preflight()).ok, true, "and everything present is ok");
});

test("the image is pinned by hash, and a path alone is refused", async () => {
  await assert.rejects(() => mk(host(), { imageSha256: "" }).verifyImage(), /a path is not an identity/);
  await assert.rejects(() => mk(host({ imageHash: { present: true, sha256: "00".repeat(32), bytes: 1 } })).verifyImage(),
                       /sha256 is 0000/, "the wrong bytes are refused even though the path exists");
  await assert.rejects(() => mk(host({ imageHash: { present: false } })).verifyImage(), /not present/);
  assert.deepEqual(await mk(host()).verifyImage(), { sha256: SHA, bytes: 124962164 });
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

test("every script that looks VMs up to act on them carries the ENUMERABLE guard", () => {
  for (const s of [DEF(), CMD.removeById({ vmId: VM_ID }), CMD.teardown({ prefix: "p-" }), CMD.survey({ prefix: "p-" }),
                   CMD.retireGuestState({ path: "C:\\r\\n.vmgs", runDir: "C:\\r", archiveDir: "C:\\a", name: "n" })])
    assert.match(s, /^if \(-not \(Get-Command Get-VM -ErrorAction SilentlyContinue\)\) \{ throw 'Get-VM is absent/);
});

/* ---- the VM must be created with a guest-state isolation type ---------------------------------- *
 *
 * Measured on nucbox-k11 2026-09-24. A Generation 2 VM created WITHOUT a guest-state isolation type
 * takes a firmware file, reads it back, starts, and boots nothing: there is no paravisor to consume
 * the field. Created WITH one, the worker tries and says what it wants (Worker-Admin 5142):
 *   "failed to load custom IGVM file because AllowFirmwareLoadFromFile registry key is not set".
 *
 * The fake models THAT host: it looks at how the VM was defined and answers the way Hyper-V did,
 * including reporting the host's opt-in to preflight. A launcher that goes back to defining plain gen2
 * VMs gets a silent guest here, exactly as on the real box. */
function paravisorHost({ registryOptIn = false } = {}) {
  let createdWithIsolation = null;
  const ok = (a) => ({ code: 0, stdout: JSON.stringify(a), stderr: "" });
  const run = async (script) => {
    const k = keyOf(script);
    if (k === "preflight") return ok({ ...PREFLIGHT_OK, firmwareOptIn: registryOptIn ? { present: true, value: 1, kind: "DWord" } : { present: false } });
    if (k === "imageHash") return ok({ present: true, sha256: SHA, bytes: 124962164 });
    if (k === "define") {
      createdWithIsolation = /-GuestStateIsolationEnabled \$true -GuestStateIsolationType 1 /.test(script);
      return ok(defineAnswer(script, createdWithIsolation ? {} : { isolationType: 0, isolationEnabled: false }));
    }
    if (k === "start" || k === "startAndRead") {
      if (createdWithIsolation && !registryOptIn) {
        return { code: 1, stdout: "", stderr: "Start-VM refused: failed | Worker-Admin: [5142] failed to load custom IGVM file because AllowFirmwareLoadFromFile registry key is not set" };
      }
      return ok(k === "startAndRead" ? { state: "Running", console: { connected: !!createdWithIsolation, bytes: 0, head: "" } } : { state: "Running" });
    }
    // no isolation type => no paravisor => a Running VM that says nothing
    if (k === "readConsole") return ok({ connected: !!createdWithIsolation, bytes: 0, head: "" });
    if (k === "removeById" || k === "removeExact") return ok({ found: true, removed: true });
    if (k === "retire") return ok({ present: true, retired: true });
    return ok({ found: 0, removed: [], failed: [], vms: [] });
  };
  return { run, createdWith: () => createdWithIsolation };
}
const paravisorLauncher = (h, over = {}) => new WmiHyperVLauncher({ run: h.run, imagePath: IMG, imageSha256: SHA, prefix: "enclave-", ...TYPE1, ...over });

test("the definition asks for a guest-state isolation type, or the firmware file is inert", async () => {
  const h = paravisorHost({ registryOptIn: true });
  await paravisorLauncher(h).start(mapping, { instanceId: "iso-1", guestReadySec: 1 }).catch(() => {});
  assert.equal(h.createdWith(), true,
    "New-CustomVM must be asked for GuestStateIsolationType 1: without one the worker never loads the IGVM and the guest is silent");
});

test("a host without the registry opt-in surfaces the setting by name, and nothing is defined", async () => {
  const h = paravisorHost({ registryOptIn: false });
  await assert.rejects(() => paravisorLauncher(h).start(mapping, { instanceId: "iso-2", guestReadySec: 1 }),
    (e) => /AllowFirmwareLoadFromFile/.test(e.message) && e.code === "firmware_opt_in_absent",
    "the operator must see the key named, rather than having to reconstruct it from a silent guest");
  assert.equal(h.createdWith(), null, "preflight refused it, so no VM was ever defined");
});

test("with the opt-in set, start proceeds (and readiness is still decided elsewhere)", async () => {
  const h = paravisorHost({ registryOptIn: true });
  // it may still refuse for want of guest output; what must NOT happen is a registry-key failure
  const e = await paravisorLauncher(h).start(mapping, { instanceId: "iso-3", guestReadySec: 1 }).then(() => null, (x) => x);
  if (e) assert.doesNotMatch(e.message, /AllowFirmwareLoadFromFile/);
});

/* ---- the partition kind and the UEFI image identity ------------------------------------------- *
 *
 * Both from enclave-99's UEFI review. The kind must be the LAUNCHER's word, because the guest
 * cannot know it and the monitor stopped printing a fixed one; and the image identity must be the
 * MEDIUM's hash, not the UKI's, because with Secure Boot off the stub reads addons, credentials
 * and extensions from the ESP - so two media carrying the same UKI can boot different command
 * lines, and only the medium hash tells them apart. */
import { BOUNDARY as WMI_BOUNDARY, uefiImageIdentity, linuxDirectIdentity } from "./wmi-launcher.mjs";

test("the WMI launcher states its OWN partition kind, not the HCS one", async () => {
  const { BOUNDARY: HCS } = await import("./backend-hcs.mjs");
  assert.equal(WMI_BOUNDARY.partition, "wmi-openhcl-gen2");
  assert.notEqual(WMI_BOUNDARY.partition, HCS.partition,
    "a report copied from the HCS path would be a false statement about the boundary");
  assert.equal(WMI_BOUNDARY.hostExcluded, false, "a type-1 partition is CONFIGURED for host-private RAM; that is not a measurement");
  assert.equal(WMI_BOUNDARY.attested, false);
  assert.equal(WMI_BOUNDARY.tier, "T0-hv", "the contract's spelling, which routeFor and judge-hv use");
  assert.equal(WMI_BOUNDARY.guestStateIsolationType, 1);
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

const uefiHost = (over = {}) => host({ imageHash: (s) => ({ present: true, sha256: s.includes("guest-production") ? MED : SHA, bytes: 1 }), ...over });

test("with a medium (uefi-medium), handle.image is the MEDIUM's hash as a string, hashed at attach", async () => {
  const h = uefiHost();
  const handle = await mk(h, { boot: BOOT_UEFI, medium: MEDIUM, mediumSha256: MED }).start(mapping, ID);
  assert.deepEqual(h.keys(), ["preflight", "imageHash", "imageHash", "define", "startAndRead"],
    "the IGVM AND the medium are hashed before anything is defined");
  assert.equal(typeof handle.image, "string", "the datapath compares 64-hex strings; an object never matches");
  assert.match(handle.image, /^[0-9a-f]{64}$/);
  assert.equal(handle.image, MED, "the MEDIUM's hash, not the firmware's");
  assert.notEqual(handle.image, SHA, "the firmware hash is a different thing and must not be reported as the image");
  assert.equal(handle.guestIdentity.guestImageKind, "uefi-medium");
  assert.equal(handle.guestIdentity.guestImagePath, MEDIUM, "the path the DVD reads back, not the argument");
  assert.equal("imageAbsentReason" in handle, false);
  assert.equal(handle.guestIdentity.partition, "wmi-openhcl-gen2");
  assert.equal(handle.boundary.partition, handle.guestIdentity.partition, "one name per handle, the signed report's");
  // the medium must be the pinned bytes before AND at attach time
  await assert.rejects(() => mk(uefiHost({ imageHash: { present: true, sha256: SHA, bytes: 1 } }), { boot: BOOT_UEFI, medium: MEDIUM, mediumSha256: MED })
    .start(mapping, ID), /boot medium sha256 is 2d73/);
  const h2 = uefiHost({ define: { mediumSha256: "cd".repeat(32) } });
  await assert.rejects(() => mk(h2, { boot: BOOT_UEFI, medium: MEDIUM, mediumSha256: MED }).start(mapping, ID), /attached medium hashed "cdcd/);
  assert.ok(h2.keys().includes("removeById"), "and a medium that changed under us is removed with its VM");
});

test("with NO medium (linux-direct), image is the IGVM's sha256, stated with the linux-direct (partition, kind) pair", async () => {
  const handle = await mk(host()).start(mapping, ID);
  assert.equal(handle.image, SHA, "the IGVM is what booted; its hash is compared only with the pair below");
  assert.equal(handle.image, handle.guestIdentity.igvmSha256);
  assert.equal("imageAbsentReason" in handle, false);
  assert.equal(handle.guestIdentity.guestImageKind, "igvm-linux-direct");
  assert.equal(handle.guestIdentity.partition, "wmi-openhcl-gen2-igvm-linux", "the name wmiserve SIGNS for --igvm-sha256");
  assert.equal(handle.boundary.partition, handle.guestIdentity.partition, "one name per handle, the signed report's");
  assert.equal(handle.boundary.hostExcluded, false);
  assert.equal(handle.guestIdentity.igvmSha256, SHA, "the IGVM's pinned sha256");
  assert.equal("guestImageSha256" in handle.guestIdentity, false, "the IGVM hash keeps its own name in the identity; `image` carries it with the pair");
  assert.ok(handle.firmware, "the firmware hash is still reported, under its own name");
  assert.throws(() => linuxDirectIdentity({ igvmSha256: "nope" }), /IGVM's sha256 is required/);
});

/* ---- the boot form has ONE name, the signed report's (enclave-99's contract, main ae6e9147) ----- */
import { BOOT_STATEMENTS, bootFormOfStatement, boundaryFor, BOOT_FORMS } from "./wmi-launcher.mjs";

test("the fixed pairing is exactly the contract's table, one row per boot form", () => {
  assert.deepEqual(Object.keys(BOOT_STATEMENTS).sort(), [...BOOT_FORMS].sort(), "every boot form has a row, and nothing else does");
  assert.deepEqual(BOOT_STATEMENTS["linux-direct"], { partition: "wmi-openhcl-gen2-igvm-linux", guestImageKind: "igvm-linux-direct" });
  assert.deepEqual(BOOT_STATEMENTS["uefi-medium"], { partition: "wmi-openhcl-gen2", guestImageKind: "uefi-medium" });
  assert.ok(Object.isFrozen(BOOT_STATEMENTS) && Object.isFrozen(BOOT_STATEMENTS["linux-direct"]));
  const ld = linuxDirectIdentity({ igvmSha256: "ab".repeat(32) });
  const ue = uefiImageIdentity({ mediumSha256: "cd".repeat(32) });
  assert.equal(bootFormOfStatement(ld.partition, ld.guestImageKind), "linux-direct", "each identity states its own form");
  assert.equal(bootFormOfStatement(ue.partition, ue.guestImageKind), "uefi-medium");
});

test("any other pairing, and any unknown value on either side, states NO boot form", () => {
  const L = BOOT_STATEMENTS["linux-direct"], U = BOOT_STATEMENTS["uefi-medium"];
  for (const [p, k, why] of [
    [L.partition, U.guestImageKind, "crossed"], [U.partition, L.guestImageKind, "crossed the other way"],
    ["wmi-openhcl-gen2-igvm-linux-x", L.guestImageKind, "a longer name (no prefix match)"],
    ["wmi-openhcl-gen2-igvm", L.guestImageKind, "a shorter name (no prefix match)"],
    ["WMI-OPENHCL-GEN2-IGVM-LINUX", L.guestImageKind, "another case"],
    [" wmi-openhcl-gen2", U.guestImageKind, "whitespace"],
    ["hcs-child", L.guestImageKind, "another launcher's kind"],
    [L.partition, "igvm-linux", "a truncated kind"], [L.partition, undefined, "no kind"], [undefined, U.guestImageKind, "no partition"],
    [null, null, "nothing"],
  ]) assert.equal(bootFormOfStatement(p, k), null, why);
});

test("the handle's boundary and the launcher's own carry the stated form's name; no form, no boundary", () => {
  assert.equal(boundaryFor("linux-direct").partition, "wmi-openhcl-gen2-igvm-linux");
  assert.equal(boundaryFor("uefi-medium").partition, "wmi-openhcl-gen2");
  for (const f of BOOT_FORMS) {
    const b = boundaryFor(f);
    assert.equal(b.hostExcluded, false); assert.equal(b.attested, false); assert.equal(b.tier, "T0-hv");
    assert.ok(Object.isFrozen(b));
  }
  assert.throws(() => boundaryFor("uefi"), /unknown boot form/);
  assert.equal(mk(host()).boundary.partition, "wmi-openhcl-gen2-igvm-linux", "TYPE1 states linux-direct");
  assert.equal(mk(host(), { boot: null }).boundary, null, "a launcher with no stated form states no boundary");
});

/* ---- the console read stops at the monitor's ready line (46 s starts on nucbox-k11 at 40 s) ---------- */
import { GUEST_READY_LINE } from "./wmi-launcher.mjs";

test("the console reader stops at `until` when it is given, and never without it", () => {
  const s = CMD.readConsole({ pipe: "\\\\.\\pipe\\x-com1", seconds: 40, until: GUEST_READY_LINE });
  assert.match(s, /\$until = 'MON ready';/);
  assert.match(s, /if \(\$tail\.Contains\(\$until\)\) \{ \$sawUntil = \$true; break \}/);
  assert.match(s, /\$tail = \$tail\.Substring\(\$tail\.Length - 4096\)/, "bounded: a chatty guest cannot grow it");
  assert.match(s, /sawUntil=\$sawUntil/);
  assert.equal((s.match(/ReadAsync/g) || []).length, 1, "still ONE pending read");
  const none = CMD.readConsole({ pipe: "\\\\.\\pipe\\x-com1", seconds: 40 });
  assert.match(none, /\$until = \$null;/, "no marker: the whole window, as before");
});

test("start asks the reader to stop at the monitor's ready line, and reports it without changing what booted means", async () => {
  const seen = [];
  const h = host({ readConsole: (sc) => { seen.push(sc); return { connected: true, bytes: 613, head: "MON ...", sawUntil: true }; } });
  const handle = await mk(h).start(mapping, ID);
  assert.match(seen[0], /\$until = 'MON ready';/);
  assert.equal(handle.guest.readyLine, true);
  assert.equal(handle.guest.booted, true);
  assert.equal(handle.appReady, false, "a ready LINE is not an app that is ready");
  const quiet = await mk(host({ readConsole: { connected: true, bytes: 64, head: "firmware banner" } })).start(mapping, ID);
  assert.equal(quiet.guest.readyLine, false, "bytes without the line: booted, and said so, and nothing more");
  assert.equal(quiet.guest.booted, true);
});

/* ---- the VM's RAM is sized from the app's share, never equal to it ----------------------------- */
import { type1VmMemMiB, TYPE1_VM_MEM_FLOOR_MIB } from "./wmi-launcher.mjs";

test("the type-1 VM gets max(2048, policy + 640) MiB: a 128 MiB app never defines a 128 MiB partition", async () => {
  assert.equal(type1VmMemMiB(128), 2048, "hello-world's catalog policy: the floor, the only size run on hardware");
  assert.equal(type1VmMemMiB(1408), 2048);
  assert.equal(type1VmMemMiB(1409), 2049);
  assert.equal(type1VmMemMiB(4096), 4736);
  for (const bad of [0, -1, 1.5, "128", null, undefined, NaN]) assert.throws(() => type1VmMemMiB(bad), /positive integer/, String(bad));
  const seen = [];
  const h = host({ define: (sc) => { seen.push(sc); return undefined; } });
  const handle = await mk(h).start({ ...mapping, record: { policy: { cpuPercent: 100, memMiB: 128, vcpus: 1 } } }, ID);
  assert.match(seen[0], /-Memory \(2048 \* 1MB\)/, "the define script asks for the VM's RAM, not the app's share");
  assert.deepEqual(handle.memory, { policyMiB: 128, vmMiB: TYPE1_VM_MEM_FLOOR_MIB, rule: "max(2048, policy + 640)" });
});

/* ---- start and console in ONE process, the reader attaching first (manager spawns failed on the race) --- */
test("startAndRead begins attaching BEFORE Start-VM, falls back in-process, and keeps one pending read", () => {
  const s = CMD.startAndRead({ vmId: VM_ID, pipe: "\\\\.\\pipe\\x-com1", seconds: 25, until: GUEST_READY_LINE });
  const iAsync = s.indexOf("$cli.ConnectAsync("), iStart = s.indexOf("Start-VM -VM $v"), iFallback = s.indexOf("$cli.Connect(100)");
  assert.ok(iAsync > 0 && iStart > 0 && iAsync < iStart, "the reader starts connecting before the VM exists to print anything");
  assert.ok(iFallback > iStart, "and if that cannot attach, it retries in THIS process straight after Start-VM");
  assert.match(s, /\$v = Get-VM -Id '5DB6D4EB-1619-4936-9D60-C7E3CA67F3A8'/);
  assert.match(s, /not ours: the ownership marker is absent, so this VM is not started/);
  assert.match(s, /Get-WinEvent -LogName 'Microsoft-Windows-Hyper-V-Worker-Admin'/, "a refused start still names the worker's reason");
  assert.match(s, /if \(\$cli\) \{ try \{ \$cli\.Dispose\(\) \} catch \{\} \};\s*\$msg = 'Start-VM refused: '/, "and releases the pending reader first");
  assert.match(s, /\$until = 'MON ready';/);
  assert.equal((s.match(/ReadAsync/g) || []).length, 1, "ONE pending read, as readConsole");
  assert.match(s, /\[System\.IO\.Pipes\.PipeOptions\]::Asynchronous/);
  assert.match(s, /console=@\{connected=\$connected; early=\$early; earlyNote=\$earlyNote; attachMs=\$attachMs; bytes=\$total/);
  assert.throws(() => CMD.startAndRead({ vmId: "x'; Remove-VM *", pipe: "p" }), /not a VM Id/);
});

test("start uses ONE startAndRead call (no separate console process), and reports how the console was attached", async () => {
  const h = host({ readConsole: { connected: true, bytes: 613, head: "MON ready", sawUntil: true, early: true, attachMs: 900 } });
  const handle = await mk(h).start(mapping, ID);
  assert.equal(h.keys().filter((k) => k === "start" || k === "readConsole").length, 0, "no separate Start-VM or reader process");
  assert.equal(h.keys().filter((k) => k === "startAndRead").length, 1);
  assert.deepEqual(handle.guest.attach, { early: true, ms: 900 });
  assert.equal(handle.guest.readyLine, true);
});

// ---- serve: the app and its relay through wmiserve (enclave-5d, wmiserve-run.mjs), opt-in ----
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const FAKE_WMISERVE = path.join(path.dirname(fileURLToPath(import.meta.url)), "testdata/fake-wmiserve.mjs");
const BUNDLE = Buffer.from("enclave-catalog-bundle/1 bytes for the launcher's serve tests");
const served = { appId: crypto.createHash("sha256").update(BUNDLE).digest("hex"), bundle: BUNDLE,
                 record: { policy: { cpuPercent: 100, memMiB: 512, vcpus: 1 } } };
// a launcher that serves through the fake wmiserve in `mode`; `events` records the PowerShell steps and the relay's close
function serving(mode = "ok", { over = {}, hostOver = {}, argsFile = null } = {}) {
  const events = [];
  const h = host(hostOver);
  const run = async (script) => { events.push("ps:" + keyOf(script)); return h.run(script); };
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "wmi-serve-"));
  const spawn = (exe, args, opts) => nodeSpawn(process.execPath, [FAKE_WMISERVE, ...args],
    { ...opts, env: { ...process.env, FAKE_WMISERVE: mode, ...(argsFile ? { FAKE_WMISERVE_ARGS: argsFile } : {}) } });
  const L = mk({ run, seen: h.seen }, { serve: { exe: "vbslike-host.exe", bundleDir, portFor: () => 19311, readyTimeoutMs: 5_000, spawn }, ...over });
  const origStop = L.stop.bind(L);
  L.stop = async (handle) => {
    if (handle && handle.wmiserve) { const s = handle.wmiserve.stop; handle.wmiserve.stop = async () => { events.push("relay:close"); return s(); }; }
    return origStop(handle);
  };
  return { L, events, bundleDir, h };
}

// a relay child a failing assertion left behind is killed, so a broken check FAILS instead of hanging the run
const reap = (h) => { try { if (h && h.wmiserve && h.wmiserve.pid) process.kill(h.wmiserve.pid, "SIGKILL"); } catch { /* gone */ } };

test("serve: the app is loaded and relayed; the handle carries the relay, the key, the boot and the IGVM image", async () => {
  const { L, events, bundleDir } = serving("ok");
  const handle = await L.start(served, ID);
  try {
  assert.equal(handle.tcpPort, 19311); assert.equal(handle.domainId, 1); assert.equal(handle.guestPort, 40001);
  assert.equal(Buffer.from(handle.launcherKey, "base64").length, 32);
  assert.equal(handle.boot, "39725c19e15c91afe488ce62251055f5", "the per-boot nonce, kept for the manager's own destroys");
  assert.equal(handle.image, SHA); assert.equal(handle.guestIdentity.partition, "wmi-openhcl-gen2-igvm-linux");
  assert.ok(fs.existsSync(path.join(bundleDir, `${ID.instanceId}.bundle`)), "the bundle is in the manager-owned directory, by instance id");
  const out = await handle.stop();
  assert.equal(out.relay.how, "closed", "wmiserve closed on the stdin line");
  assert.ok(events.indexOf("relay:close") < events.lastIndexOf("ps:removeById"), `the relay closes BEFORE the VM goes: ${events.join(", ")}`);
  assert.equal(fs.existsSync(path.join(bundleDir, `${ID.instanceId}.bundle`)), false, "and its bundle file goes with it");
  } finally { reap(handle); }
});

test("serve: a wmiserve refusal fails the start, removes the VM and the bundle file, and serves nothing", async () => {
  const { L, events, bundleDir } = serving("wrong-app");
  const e = await L.start(served, ID).then(async (h) => { await h.stop(); return null; }, (x) => x);
  assert.ok(e instanceof Error, "a start that must fail was accepted"); assert.match(e.message, /the guest loaded eeee.*not the AppID/);
  assert.ok(events.includes("ps:removeById"), "the VM this attempt defined is removed");
  assert.deepEqual(fs.readdirSync(bundleDir), [], "no bundle file is left behind");
});

test("serve: a mapping with no bundle bytes fails the start before anything is spawned, and the VM is removed", async () => {
  const { L, events } = serving("ok");
  await assert.rejects(() => L.start(mapping, ID), /no bundle bytes/);
  assert.ok(events.includes("ps:removeById"));
});

test("serve: set without an executable or a bundle directory, nothing is defined", async () => {
  for (const serve of [{ bundleDir: "/tmp/x" }, { exe: "vbslike-host.exe" }]) {
    const h = host();
    await assert.rejects(() => mk(h, { serve }).start(served, ID), (e) => e.code === "launcher_unconfigured");
    assert.equal(h.keys().includes("define"), false);
  }
});

test("serve: a UEFI-medium launcher hands wmiserve the MEDIUM's hash, never the IGVM's", async () => {
  const argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wmi-args-")), "args.json");
  const { L } = serving("ok", { over: { boot: BOOT_UEFI, medium: MEDIUM, mediumSha256: MED },
                               hostOver: { imageHash: (s) => ({ present: true, sha256: s.includes("guest-production") ? MED : SHA, bytes: 1 }) }, argsFile });
  const handle = await L.start(served, ID);
  try {
    const argv = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    assert.equal(argv[argv.indexOf("--medium-sha256") + 1], MED); assert.equal(argv.includes("--igvm-sha256"), false);
    await handle.stop();
  } finally { reap(handle); }
});
