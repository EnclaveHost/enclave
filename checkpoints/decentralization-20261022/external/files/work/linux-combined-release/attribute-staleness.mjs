// READ-ONLY attribution of each stale generated output in main to the inputs that changed (manifest bundles), or to the
// closure (host admission, no manifest). Writes only ./staleness.json.
import fs from "node:fs"; import path from "node:path"; import { createHash } from "node:crypto";
const M = "/home/steven/Documents/Codex/2026-10-18/wo/work/enclave";
const { build } = await import(path.join(M, "node_modules/esbuild/lib/main.js"));
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const COMPOSITION = ["client/lease-executor-client.mjs", "network/lease-gas-runtime.mjs", "network/lease-gas-conduit.mjs", "windows/installer/lease-gas-config-check.mjs",
  "supervisor.js", "metal/enclave-metal.mjs", "metal/guest/gsup.mjs", "metal/guest/measured-control.mjs", "metal/guest/owner-nomination.mjs", "network/host-owner-nomination.mjs",
  "metal/overlay-control-image.py", "metal/build-image.mjs"];
const out = {};
for (const [name, man] of [["windows-lease-runtime", "windows/node/lease-gas-runtime.bundle.mjs.manifest.json"], ["metal-lease-gas", "metal/guest/lease-gas-conduit.bundle.mjs.manifest.json"],
                           ["platform-api", "metal/guest/platform-api.bundle.mjs.manifest.json"]]) {
  const m = JSON.parse(fs.readFileSync(path.join(M, man), "utf8"));
  const changed = [], missing = [];
  for (const [rel, h] of Object.entries(m.inputs)) {
    const f = path.join(M, rel);
    if (!fs.existsSync(f)) { missing.push(rel); continue; }
    if (sha(f) !== h) changed.push(rel);
  }
  out[name] = { changed, missing, changedOutsideComposition: changed.filter((r) => !COMPOSITION.includes(r)) };
}
for (const entry of ["network/host-admission-runtime.mjs", "network/metal-host-policy.mjs"]) {
  const r = await build({ absWorkingDir: M, entryPoints: [entry], bundle: true, platform: "node", format: "esm", target: "node20", minify: true, write: false, metafile: true, outfile: "x.mjs", logLevel: "silent" });
  const inputs = Object.keys(r.metafile.inputs).filter((k) => !k.includes("node_modules/"));
  out[entry] = { localInputs: inputs.length, compositionInputs: inputs.filter((i) => COMPOSITION.includes(i)), inputs };
}
fs.writeFileSync(new URL("./staleness.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
for (const [k, v] of Object.entries(out)) console.log(k, JSON.stringify({ ...v, inputs: undefined }));
