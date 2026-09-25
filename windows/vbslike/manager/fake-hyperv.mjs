/* TEST SUPPORT ONLY: a fake Hyper-V host for the launcher's tests. Nothing here runs PowerShell.
 *
 * It answers the type-1 define script the way the recipe's read-back would on a host that did
 * exactly what it was ASKED - and it takes what was asked FROM THE SCRIPT ITSELF (name, guest-state
 * copy, IGVM, pipe, Notes, pins, memory, vCPUs, medium). So a launcher that asks for the wrong thing
 * gets the wrong thing back and its own read-back refuses it, rather than a canned answer agreeing
 * with whatever was sent. Overrides model a host that did NOT do what it was asked.
 */
import { HYPERV_MODULE_SHA256, GUEST_FEATURE_SET } from "./wmi-launcher.mjs";

/** The launcher configuration the type-1 tests share: linux-direct unless a test states otherwise. */
export const TYPE1 = Object.freeze({
  boot: "linux-direct",
  hypervModule: "C:\\Users\\claude\\hyperv.psm1",
  guestStateMaster: "C:\\Users\\claude\\vbs-like\\type1.vmgs",
  guestStateArchiveDir: "C:\\Users\\claude\\vbs-evidence",
});

/** A host with the role, the pinned module, the master VMGS and the firmware opt-in present. */
export const PREFLIGHT_OK = Object.freeze({
  vmms: true, namespace: true, module: true, firmwareField: true, hypervisor: true,
  firmwareOptIn: { present: true, value: 1, kind: "DWord", error: null },
  hypervModule: { path: TYPE1.hypervModule, present: true, sha256: HYPERV_MODULE_SHA256 },
  guestStateMaster: { path: TYPE1.guestStateMaster, present: true, bytes: 4194816 },
});

export const VM_ID = "5DB6D4EB-1619-4936-9D60-C7E3CA67F3A8";

const lit = (s, re) => { const m = s.match(re); return m ? m[1].replace(/''/g, "'") : null; };

/** What a compliant host reads back after the define script it was given. */
export function defineAnswer(script, over = {}) {
  const uefi = /Add-VMDvdDrive/.test(script);
  const fw = lit(script, /\$fw = '((?:[^']|'')*)'/);
  const mediumPath = uefi ? lit(script, /\$medium = '((?:[^']|'')*)'/) : null;
  const mv = script.match(/-Memory \((\d+) \* 1MB\) -VpCount (\d+)/) || [null, "0", "0"];
  return {
    id: VM_ID, name: lit(script, /\$name = '((?:[^']|'')*)'/), version: "12.0",
    notes: lit(script, /-Notes '((?:[^']|'')*)'/),
    isolationType: 1, isolationEnabled: true, featureSet: GUEST_FEATURE_SET, vtl2Mode: 0,
    firmwareFile: fw, firmwareSha256: lit(script, /\$pin = '([0-9a-f]{64})'; \$fwSha = /),
    hypervModuleSha256: lit(script, /\$mod = '(?:[^']|'')*'; \$pin = '([0-9a-f]{64})'/), hypervUtilitiesSha256: null,
    guestStateFile: lit(script, /\$gsf = '((?:[^']|'')*)'/), guestStateMasterSha256: "4f".repeat(32),
    vbsOptOut: true, tpmEnabled: true, nics: 0, dvds: uefi ? 1 : 0, disks: 0,
    mediumPath, mediumSha256: uefi ? lit(script, /\$mediumWant = '([0-9a-f]{64})'/) : null,
    bootEntries: uefi ? 1 : 0, secureBoot: "Off", com1: lit(script, /\$pipe = '((?:[^']|'')*)'/),
    vcpus: Number(mv[2]), memBytes: Number(mv[1]) * 1048576, dynamicMemory: false,
    automaticStartAction: "Nothing", automaticStopAction: "TurnOff",
    grants: uefi ? [fw, mediumPath] : [fw],
    ...over,
  };
}

/** Which launcher command a script is. Order matters: the define script also hashes files and removes VMs. */
export function keyOf(s) {
  return s.includes("$r.vmms") ? "preflight"
    : s.includes("New-CustomVM") ? "define"
    : s.includes("GetFileNameWithoutExtension") ? "retire"
    : s.includes("Get-FileHash") ? "imageHash"
    : s.includes("Start-VM") ? "start"
    : s.includes("already gone") ? "stop"
    : s.includes("NamedPipeClientStream") ? "readConsole"
    : s.includes("$_.Name -eq") ? "removeExact"
    : s.includes("$removed = @(); $failed = @();") ? "teardown"
    : s.includes("$vms = @(Get-VM") ? "survey"
    : s.includes("Get-VM -Id") ? "removeById"
    : "other";
}
