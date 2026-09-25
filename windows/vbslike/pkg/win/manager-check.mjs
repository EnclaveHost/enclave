// manager-check.mjs <manager dir> --record <record.json> --component <component.wasm> --image-sha256 <hex>
//
// Will this manager create its VM so that Hyper-V even CONSIDERS our IGVM? Measured on nucbox-k11 (2026-09-24,
// enclave-d1): a Generation 2 VM created WITHOUT -GuestStateIsolationType takes the FirmwareFile pin, reads it back,
// starts, and boots nothing, and nothing anywhere says why. A stale manager therefore reproduces the whole failure from
// inside a package whose every file hashes to its pin. So this asks the manager's OWN code, not its text: it derives
// the real app's mapping with the manager's derive.mjs, runs the manager's WmiHyperVLauncher.start() against a
// recording fake host (the runner is injected; no PowerShell runs and no Hyper-V is touched), and reads the New-VM
// command the launcher actually issued. Text search would pass a manager whose default leaves the flag off.
//
// It ALSO reports, from the same run, what the launcher does about a UEFI boot medium and the serving path (the
// commands it issues and the handle it returns): attachesMedium, setsBootDevice, readsBackBoot, imageIsMediumHash,
// hasLauncherKey, hasRelay. The package pins those as MEASURED (red today), so the day the manager gains them the pin
// must move rather than the change passing unnoticed.
// Prints one JSON line; exit 0 only when the issued New-VM names OpenHCL or TrustedLaunch as the isolation type.
// Used by pkg.mjs verify (on the pinned bytes) and by check.ps1 on the box (on the package's copy, or -ManagerDir).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const dir = argv[0], ISO = /-GuestStateIsolationType\s+'?(OpenHCL|TrustedLaunch)'?/, IMG = "C:\\manager-check\\image.bin";
// From 2c3a2873 the launcher defines a type-1 VM through petri's New-CustomVM (hyperv.psm1) and reads every setting back.
const ISO_CUSTOM = /New-CustomVM\b[^;]*-GuestStateIsolationEnabled\s+\$true[^;]*-GuestStateIsolationType\s+([1-9][0-9]*)\b/;
const MC = "C:\\manager-check", MEDIUM = `${MC}\\medium.iso`, GS_MASTER = `${MC}\\type1.vmgs`, GS_ARCHIVE = `${MC}\\archive`, HV_MODULE = `${MC}\\hyperv.psm1`;
// a PowerShell single-quoted literal assigned in the script, unquoted ('' is one quote), or null
const psVar = (script, re) => { const m = re.exec(script); return m ? m[1].replace(/''/g, "'") : null; };
let out;
try {
  if (!dir || !val("--record") || !val("--component") || !/^[0-9a-f]{64}$/.test(val("--image-sha256") || ""))
    throw new Error("usage: manager-check.mjs <manager dir> --record R --component C --image-sha256 HEX");
  const { WmiHyperVLauncher } = await import(pathToFileURL(path.join(dir, "wmi-launcher.mjs")).href);
  const { derive } = await import(pathToFileURL(path.join(dir, "derive.mjs")).href);
  const mapping = derive({ record: JSON.parse(fs.readFileSync(val("--record"), "utf8")), component: fs.readFileSync(val("--component")) });
  const sha = val("--image-sha256"), seen = [];
  let hvPin = null;
  const medium = val("--medium-sha256");
  // A host that says yes to everything, keyed on what each script does (the shape of the manager's own tests).
  // The type-1 define script (2c3a2873): answered as a compliant host would, by echoing what the script itself asked
  // for. So what this measures is what the launcher ASKS for (the isolation parameters, the read-back), never whether
  // Hyper-V complies; that is measured on the box.
  const defined = (script) => {
    const uefi = /Add-VMDvdDrive/.test(script), mem = /-Memory \((\d+) \* 1MB\)/.exec(script), vp = /-VpCount (\d+)/.exec(script);
    return { id: "00000000-0000-4000-8000-000000000001", name: psVar(script, /\$name = '((?:[^']|'')*)'/), version: "12.0",
      notes: psVar(script, /-Notes '((?:[^']|'')*)'/), isolationType: Number((ISO_CUSTOM.exec(script) || [])[1] || 0),
      isolationEnabled: /-GuestStateIsolationEnabled \$true/.test(script), featureSet: 0x201, vtl2Mode: 0,
      firmwareFile: psVar(script, /\$fw = '((?:[^']|'')*)'/), firmwareSha256: sha,
      hypervModuleSha256: psVar(script, /\$mod = '(?:[^']|'')*'; \$pin = '([0-9a-f]{64})'/), hypervUtilitiesSha256: null,
      guestStateFile: psVar(script, /\$gsf = '((?:[^']|'')*)'/), guestStateMasterSha256: "00".repeat(32),
      vbsOptOut: /-VirtualizationBasedSecurityOptOut \$true/.test(script), tpmEnabled: true, nics: 0,
      dvds: uefi ? 1 : 0, disks: 0, mediumPath: uefi ? MEDIUM : null, mediumSha256: uefi ? psVar(script, /\$mediumWant = '([0-9a-f]{64})'/) : null,
      bootEntries: uefi ? 1 : 0, secureBoot: "Off", com1: psVar(script, /\$pipe = '((?:[^']|'')*)'/),
      vcpus: vp ? Number(vp[1]) : null, memBytes: mem ? Number(mem[1]) * 1048576 : null, dynamicMemory: false,
      automaticStartAction: "Nothing", automaticStopAction: "TurnOff", grants: [] };
  };
  const answers = [
    [/New-CustomVM/, defined],
    [/Start-VM[\s\S]*NamedPipeClientStream|NamedPipeClientStream[\s\S]*Start-VM/, { state: "Running", console: { connected: true, bytes: 1, head: "x", sawUntil: true, early: true } }],
    [/\$r\.vmms/, (script) => ({ vmms: true, namespace: true, module: true, firmwareField: true, hypervisor: true,
      firmwareOptIn: { present: true, value: 1, kind: "DWord" },
      ...(script.includes(HV_MODULE) ? { hypervModule: { path: HV_MODULE, present: true, sha256: hvPin } } : {}),
      ...(script.includes(GS_MASTER) ? { guestStateMaster: { path: GS_MASTER, present: true, bytes: 1 } } : {}) })],
    [/Get-FileHash/, (script) => ({ present: true, sha256: script.includes(MEDIUM) && medium ? medium : sha, bytes: 1 })],
    [/Get-FileHash/, { present: true, sha256: sha, bytes: 1 }],
    [/New-VM/, { id: "00000000-0000-4000-8000-000000000001", version: "12.0", name: "manager-check" }],
    [/ModifySystemSettings/, { returnValue: 0, jobState: null, firmwareFile: IMG, guestFeatureSet: 0x201 }],
    [/Set-VMComPort/, { ok: true }],
    [/Start-VM/, { state: "Running" }],
    [/NamedPipeClientStream/, { connected: true, bytes: 1, head: "x" }],
  ];
  const run = async (script) => {
    seen.push(String(script));
    const a = answers.find(([re]) => re.test(script));
    const v = a ? (typeof a[1] === "function" ? a[1](String(script)) : a[1]) : { ok: true, found: 0, removed: [], failed: [], vms: [] };
    return { code: 0, stdout: JSON.stringify(v), stderr: "" };
  };
  // The boot form of the path this run measures, STATED: the UEFI serving path when given a medium, else linux-direct. From
  // 2c3a2873 the launcher refuses a medium without a stated form; earlier launchers ignore the key.
  const boot = val("--boot") || (medium ? "uefi-medium" : "linux-direct");
  const l = new WmiHyperVLauncher({ run, imagePath: IMG, imageSha256: sha, prefix: "manager-check-", boot,
                                    // the type-1 inputs the 2c3a2873 launcher requires (earlier launchers ignore them): hyperv.psm1 at
                                    // the launcher's own default pin, a guest-state master and an archive directory on the recording host
                                    hypervModule: HV_MODULE, guestStateMaster: GS_MASTER, guestStateArchiveDir: GS_ARCHIVE,
                                    // d1's launcher took `mediumPath` until 8d82f67f and `medium` from c067b446: both keys, so the same
                                    // check measures either, and the pin says which shape it saw
                                    ...(medium ? { medium: "C:\\manager-check\\medium.iso", mediumPath: "C:\\manager-check\\medium.iso", mediumSha256: medium } : {}) });
  hvPin = l.hypervModuleSha256 || null;
  let startErr = null, handle = null;
  handle = await l.start(mapping, { instanceId: "managercheck-0001", guestReadySec: 1 }).catch((e) => { startErr = e.message; return null; });
  const created = seen.find((s) => /New-VM|New-CustomVM/.test(s));
  const iso = created ? ISO.exec(created) || ISO_CUSTOM.exec(created) : null;
  const m = iso && iso[1] ? iso : null;
  const all = seen.join("\n");
  const serving = {
    attachesMedium: /Add-VMDvdDrive|Add-VMHardDiskDrive/.test(all),
    setsBootDevice: /FirstBootDevice/.test(all),
    readsBackBoot: /Get-VMFirmware/.test(all),
    imageIsMediumHash: !!handle && typeof handle.image === "string" && /^[0-9a-f]{64}$/.test(handle.image) && (!medium || handle.image === medium),
    imageType: handle ? (typeof handle.image === "string" ? "string" : handle.image === undefined ? "absent" : typeof handle.image) : null,
    hasLauncherKey: !!handle && typeof handle.launcherKey === "string" && handle.launcherKey.length > 0,
    hasRelay: !!handle && (handle.relay != null || handle.tcpPort != null),
  };
  out = { ok: !!m, isolation: m ? m[1] : null, secureBootOff: !!created && /EnableSecureBoot\s+Off|-SecureBootEnabled \$false/.test(created),
          serving, boot, appId: mapping.appId, issuedNewVm: !!created, startError: startErr,
          reason: !created ? "the launcher issued no New-VM" : m ? "" : "the launcher's New-VM names no guest-state isolation type: the FirmwareFile pin would be accepted and silently unused" };
} catch (e) {
  out = { ok: false, reason: `manager-check: ${e.message}` };
}
console.log(JSON.stringify(out));
process.exitCode = out.ok ? 0 : 1;
