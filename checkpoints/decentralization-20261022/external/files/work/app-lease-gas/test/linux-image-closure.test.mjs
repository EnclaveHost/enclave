// The measured Linux image (shadow-b/Dockerfile = main's Dockerfile + patches/current-dockerfile.hunk.patch) ships every
// file the supervisor candidate statically imports, transitively - in particular the shared lease-gas runtime - and the
// runtime loads from ONLY the shipped files plus the locked npm tree (npm ci), with no repository alongside.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHADOW = fileURLToPath(new URL("../shadow-b/", import.meta.url));
const shipped = () => {
  const files = new Set();
  for (const line of fs.readFileSync(path.join(SHADOW, "Dockerfile"), "utf8").split("\n")) {
    const m = /^COPY\s+(.+)\s+(\S+)\s*$/.exec(line.trim());
    if (!m) continue;
    for (const src of m[1].split(/\s+/)) files.add(path.normalize(src));
  }
  return files;
};
/** Relative static imports, transitively, from `entry` (paths relative to the image root). */
function staticGraph(entry) {
  const seen = new Set(), todo = [entry];
  while (todo.length) {
    const rel = todo.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = fs.readFileSync(path.join(SHADOW, rel), "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/gm))
      todo.push(path.normalize(path.join(path.dirname(rel), m[1])));
    for (const m of src.matchAll(/^\s*import\s+["'](\.{1,2}\/[^"']+)["']/gm))
      todo.push(path.normalize(path.join(path.dirname(rel), m[1])));
  }
  return seen;
}

const LEASE = ["network/lease-gas-runtime.mjs", "network/lease-gas-owner.mjs", "network/lease-executor-client.mjs",
  "network/lease-executor-authority.mjs", "network/lease-release-journal.mjs", "network/rpc-identity.mjs"];
test("the image ships the shared lease-gas runtime and its whole static import graph", () => {
  const files = shipped(), graph = staticGraph("supervisor.js"), lease = staticGraph("network/lease-gas-runtime.mjs");
  for (const f of [...LEASE, "network/registry-reconcile.mjs"]) assert.ok(graph.has(f), `${f} is in the supervisor's static graph`);
  assert.deepEqual([...lease].filter((f) => !files.has(f)), [], "every file the lease-gas runtime reaches is COPY'd into the image");
});

// main's supervisor.js statically imports ./sdk/bootstrap/storage.mjs; main's Dockerfile (f7d99951, 2026-10-20) now ships
// that graph (it did not at e8a72225). The candidate image must ship the WHOLE graph.
test("the candidate image ships the supervisor's whole static import graph", () => {
  const files = shipped(), graph = staticGraph("supervisor.js");
  const missing = [...graph].filter((f) => !files.has(f));
  assert.ok(missing.every((f) => !LEASE.includes(f)), "no lease-gas file is among them");
  assert.deepEqual(missing, []);
});

test("the shipped files alone (+ the locked npm tree) load the runtime and refuse a partial configuration", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linux-image-cold-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of shipped()) {
    if (!f.startsWith("network/lease") && f !== "network/rpc-identity.mjs") continue;
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(SHADOW, f), path.join(dir, f));
  }
  fs.symlinkSync(fs.realpathSync(path.join(SHADOW, "node_modules")), path.join(dir, "node_modules"));   // what `npm ci` installs
  fs.writeFileSync(path.join(dir, "probe.mjs"), `
    import assert from "node:assert/strict";
    import { loadLeaseGasConfig, leaseGasConfigured } from "./network/lease-gas-runtime.mjs";
    assert.equal(loadLeaseGasConfig({ env: {} }), null);
    assert.equal(leaseGasConfigured({ ENCLAVE_LEASE_GAS_RELAYS: "https://relay.example" }), true);
    assert.throws(() => loadLeaseGasConfig({ env: { ENCLAVE_LEASE_GAS_RELAYS: "https://relay.example" } }), /require.*FILE/);
    console.log("image runtime loaded");
  `);
  const outp = execFileSync(process.execPath, [path.join(dir, "probe.mjs")], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 20000 });
  assert.match(outp, /image runtime loaded/);
});

test("the candidate supervisor and its shipped network modules are byte-identical to the shared sources", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const f of ["lease-gas-runtime.mjs", "lease-gas-owner.mjs", "lease-executor-authority.mjs", "lease-release-journal.mjs", "rpc-identity.mjs"])
    assert.ok(fs.readFileSync(path.join(SHADOW, "network", f)).equals(fs.readFileSync(path.join(root, "network", f))), f);
  assert.ok(fs.readFileSync(path.join(SHADOW, "network/lease-executor-client.mjs")).equals(fs.readFileSync(path.join(root, "client/lease-executor-client.mjs"))));
});
