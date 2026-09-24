// Read-only probe of the Windows manager's REAL host answers: preflight, image hash, health, one spawn that must fail
// closed (no VM created: the role is absent, and the WMI launcher refuses before New-VM), and the HCS dev backend's
// preflight against the real launcher files. Binds no port, writes nothing outside its own directory.
import fs from "node:fs";
import { WmiHyperVLauncher } from "./wmi-launcher.mjs";
import { powershellRunner } from "./psrun.mjs";
import { Manager } from "./server.mjs";
import { HyperVPartitionBackend } from "./backend.mjs";
import { HcsPartitionBackend } from "./backend-hcs.mjs";
const out = { at: new Date().toISOString() };
const run = powershellRunner();
const launcher = new WmiHyperVLauncher({ run, imagePath: "C:\\Users\\claude\\vbs-like\\openhcl-ownguest.bin", imageSha256: "2d7353760b89b81b6f47759382bb2e83c325d73ed0825734f30fc4051183dfb3", prefix: "enclave-app-review99-" });
out.preflight = await launcher.preflight();
try { out.image = await launcher.verifyImage(); } catch (e) { out.image = { error: e.message }; }
try { out.survey = await launcher.survey(); } catch (e) { out.survey = { error: e.message.slice(0, 200) }; }
const vec = JSON.parse(fs.readFileSync(new URL("./derive_vectors.json", import.meta.url), "utf8"));
const component = Buffer.from(vec.component_hex, "hex"), rec = vec.ok.find((v) => v.name === "v1").record;
const m = new Manager({ backend: new HyperVPartitionBackend({ launcher }), fetchComponent: async () => component, runtimeId: rec.runtimeId });
await m.probe();
out.health = m.health();
out.spawn = await m.spawn({ derive: rec, isPublic: true, hasSecrets: false, id: "review99-probe" });
try { out.surveyAfter = await launcher.survey(); } catch (e) { out.surveyAfter = { error: e.message.slice(0, 200) }; }
const hcs = new HcsPartitionBackend({ exe: "C:\\Users\\claude\\vbs-like\\target\\release\\vbslike-host.exe", kernel: "C:\\Users\\claude\\vbs-like\\wsl-kernel", initrd: "C:\\Users\\claude\\vbs-like\\mon.cpio.gz", out: "C:\\Users\\claude\\vbs-like\\out" });
out.hcsPreflight = await hcs.preflight();
for (const p of ["C:\\Users\\claude\\vbs-like\\mon.cpio.gz", "C:\\Users\\claude\\vbs-like\\wsl-kernel", "C:\\Users\\claude\\vbs-like\\target\\release\\vbslike-host.exe"]) {
  try { const r = await run(`@{sha256=(Get-FileHash '${p}' -Algorithm SHA256).Hash.ToLower(); bytes=(Get-Item '${p}').Length; mtime=(Get-Item '${p}').LastWriteTimeUtc.ToString('o')} | ConvertTo-Json -Compress`); (out.files ||= {})[p] = JSON.parse(r.stdout); } catch (e) { (out.files ||= {})[p] = { error: e.message }; }
}
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
