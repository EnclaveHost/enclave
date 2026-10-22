// import-check.mjs SRC EXTRACT: from the EXTRACTED image (app/ with the image's own app/node_modules, opt/metal), with the
// published closure rules (SRC/metal/supervisor-closure.mjs). Run with `node --import SRC/test/helpers/loopback-only-fetch.mjs`.
//   1. every module of the supervisor's import closure except supervisor.js (which starts the server) loads from the image
//   2. the guest library helpers load: measured-control.mjs, owner-nomination.mjs, lease-gas-conduit.bundle.mjs,
//      host-policy.bundle.mjs (gsup.mjs/agent.mjs/the role bundles are programs: syntax-checked, not imported)
//   3. node --check on every opt/metal/*.mjs
//   4. both role bundles started as gsup starts them, with an absent config: each reaches ITS OWN main (its error, exit 1)
//      behind the argv guard (argv[1] renamed), so no bundled library's "am I main?" check can take the bundle for itself
// Host node, not the image's node binary: this checks the module/file closure, not the runtime version.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const [src, root] = process.argv.slice(2).map((p) => path.resolve(p));
const { supervisorClosure } = await import(pathToFileURL(path.join(src, "metal/supervisor-closure.mjs")).href);
const out = { closure: 0, imported: [], syntax: [], probes: {} };
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
const probe = path.join(process.env.TMPDIR || "/tmp", `argv-probe-${process.pid}.mjs`);
fs.writeFileSync(probe, 'process.on("exit", () => process.stderr.write("ARGV1=" + process.argv[1] + "\\n"));\n');
for (const [name, bundle, prefix] of [["mcp", "mcp-server.bundle.mjs", "mcp/server: "], ["platform-api", "platform-api.bundle.mjs", "[platform-api] "]]) {
  const at = path.join(root, "opt/metal", bundle);
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(probe).href, at, "--config", path.join(root, "absent-role-config.json")], { encoding: "utf8", timeout: 60000, cwd: root });
  const guarded = r.stderr.includes(`ARGV1=${at} (enclave host role)\n`), own = r.stderr.split("\n").some((l) => l.startsWith(prefix));
  out.probes[name] = { exit: r.status, ownMainError: own, argvGuarded: guarded, stderr: r.stderr.replaceAll(root, "<image>").slice(0, 400) };
  if (r.status !== 1 || !own || !guarded) throw new Error(`${name} bundle probe: ${JSON.stringify(out.probes[name])}`);
}
fs.rmSync(probe);
console.log(JSON.stringify({ ok: true, closureFiles: out.closure, imported: out.imported.length, syntaxChecked: out.syntax.length, packages: Object.keys(packages), probes: out.probes }, null, 1));
