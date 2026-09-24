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
// Prints one JSON line; exit 0 only when the issued New-VM names OpenHCL or TrustedLaunch as the isolation type.
// Used by pkg.mjs verify (on the pinned bytes) and by check.ps1 on the box (on the package's copy, or -ManagerDir).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const dir = argv[0], ISO = /-GuestStateIsolationType\s+'?(OpenHCL|TrustedLaunch)'?/, IMG = "C:\\manager-check\\image.bin";
let out;
try {
  if (!dir || !val("--record") || !val("--component") || !/^[0-9a-f]{64}$/.test(val("--image-sha256") || ""))
    throw new Error("usage: manager-check.mjs <manager dir> --record R --component C --image-sha256 HEX");
  const { WmiHyperVLauncher } = await import(pathToFileURL(path.join(dir, "wmi-launcher.mjs")).href);
  const { derive } = await import(pathToFileURL(path.join(dir, "derive.mjs")).href);
  const mapping = derive({ record: JSON.parse(fs.readFileSync(val("--record"), "utf8")), component: fs.readFileSync(val("--component")) });
  const sha = val("--image-sha256"), seen = [];
  // A host that says yes to everything, keyed on what each script does (the shape of the manager's own tests).
  const answers = [
    [/\$r\.vmms/, { vmms: true, namespace: true, module: true, firmwareField: true, hypervisor: true }],
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
    return { code: 0, stdout: JSON.stringify(a ? a[1] : { ok: true, found: 0, removed: [], failed: [], vms: [] }), stderr: "" };
  };
  const l = new WmiHyperVLauncher({ run, imagePath: IMG, imageSha256: sha, prefix: "manager-check-" });
  let startErr = null;
  await l.start(mapping, { instanceId: "managercheck-0001", guestReadySec: 1 }).catch((e) => { startErr = e.message; });
  const created = seen.find((s) => /New-VM/.test(s));
  const m = created ? ISO.exec(created) : null;
  out = { ok: !!m, isolation: m ? m[1] : null, secureBootOff: !!created && /EnableSecureBoot\s+Off/.test(created),
          appId: mapping.appId, issuedNewVm: !!created, startError: startErr,
          reason: !created ? "the launcher issued no New-VM" : m ? "" : "the launcher's New-VM names no guest-state isolation type: the FirmwareFile pin would be accepted and silently unused" };
} catch (e) {
  out = { ok: false, reason: `manager-check: ${e.message}` };
}
console.log(JSON.stringify(out));
process.exitCode = out.ok ? 0 : 1;
