import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { closure } from "../windows/node/deploy-files.mjs";

test("Windows deploy closure ships the shared lease bundle without undeclared outside npm dependencies", () => {
  const result = closure({ root: fileURLToPath(new URL("..", import.meta.url)) });   // this repository's own tree
  assert.deepEqual(result.problems, []);
  assert.ok(result.files.includes("windows/node/lease-gas-runtime.bundle.mjs"));
  assert.ok(result.files.includes("network/registry-reconcile.mjs"), "the existing shared heartbeat policy still ships");
  assert.ok(!result.files.includes("network/lease-gas-runtime.mjs"), "unbundled viem imports cannot resolve on the installed node");
});

test("the Windows runtime bundle loads without repository or npm files alongside it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-bundle-cold-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(new URL("../windows/node/lease-gas-runtime.bundle.mjs", import.meta.url), path.join(dir, "runtime.mjs"));
  fs.writeFileSync(path.join(dir, "probe.mjs"), `
    import assert from "node:assert/strict";
    import { loadLeaseGasConfig, leaseGasConfigured } from "./runtime.mjs";
    assert.equal(loadLeaseGasConfig({env:{}}), null);
    assert.equal(leaseGasConfigured({LEASE_GAS_RELAYS:"https://relay.example"}), true);
    assert.throws(() => loadLeaseGasConfig({env:{LEASE_GAS_RELAYS:"https://relay.example"}}), /require.*FILE/);
    console.log("standalone bundle loaded");
  `);
  const output = execFileSync(process.execPath, [path.join(dir, "probe.mjs")],
    { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 15000 });
  assert.match(output, /standalone bundle loaded/);
});
