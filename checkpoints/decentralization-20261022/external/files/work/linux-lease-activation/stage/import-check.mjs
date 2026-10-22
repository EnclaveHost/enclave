// import-check.mjs EXTRACTED: every module of the overlaid supervisor closure EXCEPT supervisor.js itself (which starts
// the server), loaded from the extracted IMAGE, its npm packages resolved from the image's own app/node_modules; and the
// guest's conduit bundle and measured-control helper from /opt/metal. A missing file or package is the failure this finds.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { supervisorClosure } from "../tree/metal/supervisor-closure.mjs";
const root = path.resolve(process.argv[2]);
const { files, packages } = supervisorClosure(path.join(root, "app"));
let n = 0;
for (const f of files) {
  if (f === "supervisor.js" || !/\.(m?js)$/.test(f)) continue;
  await import(pathToFileURL(path.join(root, "app", f)).href); n++;
}
for (const f of ["lease-gas-conduit.bundle.mjs", "measured-control.mjs", "host-policy.bundle.mjs"]) { await import(pathToFileURL(path.join(root, "opt/metal", f)).href); n++; }
const lg = await import(pathToFileURL(path.join(root, "app/network/lease-gas-runtime.mjs")).href);
if (typeof lg.loadLeaseGasConfig !== "function" || typeof lg.configuredLeaseSender !== "function") throw new Error("lease-gas runtime exports missing in the image");
console.log(`IMAGE-IMPORTS-OK ${n} modules from the image (closure ${files.length} files; packages ${Object.keys(packages).join(", ")})`);
