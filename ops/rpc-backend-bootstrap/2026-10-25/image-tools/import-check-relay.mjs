// import-check-relay.mjs SRC EXTRACT (adapted from native-final-image/tools/import-check.mjs for the RELAY-MODE image):
// from the EXTRACTED image (app/ with the image's own app/node_modules, opt/metal), with the published closure rules
// (SRC/metal/supervisor-closure.mjs). Run with `node --import SRC/test/helpers/loopback-only-fetch.mjs`.
//   1. every module of the supervisor's import closure except supervisor.js (which starts the server) loads from the image
//   2. the guest library helpers gsup imports load (owner-nomination.mjs, lease-gas-conduit.bundle.mjs, host-policy.bundle.mjs,
//      and measured-control.mjs, which gsup imports in every mode); gsup.mjs/agent.mjs are programs: syntax-checked only
//   3. node --check on every opt/metal/*.mjs
//   4. the INSTALLED host-admission bundle, as the installed supervisor imports it: every imported name exported,
//      createHostAdmission(...) has decision(), carriers supported, no platform-policy mirror selected by default
//   5. relay mode: no platform-api / mcp role bundle is installed
// Host node, not the image's node binary: this checks the module/file closure, not the runtime version.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const [src, root] = process.argv.slice(2).map((p) => path.resolve(p));
const { supervisorClosure } = await import(pathToFileURL(path.join(src, "metal/supervisor-closure.mjs")).href);
const out = { closure: 0, imported: [], syntax: [] };
const { files, packages } = supervisorClosure(path.join(root, "app"));
out.closure = files.length;
for (const f of files) {
  if (f === "supervisor.js" || !/\.(m?js)$/.test(f)) continue;
  await import(pathToFileURL(path.join(root, "app", f)).href); out.imported.push("app/" + f);
}
for (const f of ["measured-control.mjs", "owner-nomination.mjs", "lease-gas-conduit.bundle.mjs", "host-policy.bundle.mjs"]) {
  await import(pathToFileURL(path.join(root, "opt/metal", f)).href); out.imported.push("opt/metal/" + f);
}
const lg = await import(pathToFileURL(path.join(root, "app/network/lease-gas-runtime.mjs")).href);
if (typeof lg.loadLeaseGasConfig !== "function" || typeof lg.configuredLeaseSender !== "function") throw new Error("lease-gas runtime exports missing in the image");
for (const f of fs.readdirSync(path.join(root, "opt/metal")).filter((f) => f.endsWith(".mjs")).sort()) {
  const r = spawnSync(process.execPath, ["--check", path.join(root, "opt/metal", f)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`node --check opt/metal/${f}: ${r.stderr}`);
  out.syntax.push("opt/metal/" + f);
}
const api = spawnSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), "bundle-api.mjs"), path.join(root, "app/supervisor.js"),
  "installed=" + path.join(root, "app/windows/node/host-admission.bundle.mjs")], { encoding: "utf8", timeout: 60000 });
if (api.status !== 0) throw new Error(`bundle-api: ${api.stderr}`);
const b = JSON.parse(api.stdout.trim());
const bundleOk = b.missingForSupervisor.length === 0 && b.hasDecision && b.hasCarriers && b.productionDefault?.on === true && Array.isArray(b.productionDefault.mirrors) && b.productionDefault.mirrors.length === 0;
if (!bundleOk) throw new Error(`installed host-admission bundle: ${JSON.stringify(b)}`);
const roles = ["mcp-server.bundle.mjs", "platform-api.bundle.mjs"].filter((f) => fs.existsSync(path.join(root, "opt/metal", f)));
if (roles.length) throw new Error(`relay-mode image carries role bundles: ${roles.join(", ")}`);
console.log(JSON.stringify({ ok: true, closureFiles: out.closure, imported: out.imported.length, syntaxChecked: out.syntax.length, packages: Object.keys(packages),
  installedHostAdmission: { sha256: b.sha256, supervisorImports: b.supervisorImports, hasDecision: b.hasDecision, hasCarriers: b.hasCarriers, productionDefault: b.productionDefault },
  roleBundles: "absent (relay mode)" }, null, 1));
