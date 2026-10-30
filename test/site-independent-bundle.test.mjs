// The independent dashboard modules must survive the production bundler, not only the unbundled dev tree: esbuild
// bundles the site entry exactly as scripts/build-site.mjs does (code splitting, /vendor externals) and the result
// carries the independent-mode code paths with no Node built-ins. The vendored sessions SDK must be the built
// browser SDK that exports the relay-free session preparation the dashboard calls.
//   run: node --test test/site-independent-bundle.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the site bundles with independent mode included and no Node built-ins", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "site-bundle-"));
  try {
    const result = await build({ entryPoints: [path.join(REPO, "site/js/boot.js")], bundle: true, splitting: true, format: "esm",
      target: ["es2022"], outdir: out, outbase: path.join(REPO, "site"), chunkNames: "js/chunks/[name]-[hash]",
      external: ["https://*", "/vendor/*"], platform: "browser", logLevel: "silent", metafile: true });
    assert.deepEqual(result.errors, []);
    const inputs = Object.keys(result.metafile.inputs);
    for (const m of ["independent.js", "quorum.js", "independent-chain.js", "storage-plan.js", "unixfs.js", "startup-package.js", "independent-ui.js", "host-liveness.js", "host-policy.js"])
      assert.ok(inputs.some((i) => i.endsWith("site/js/core/" + m)), m + " is part of the bundle graph");
    // the shared liveness rule itself (not a copy) is bundled; the record verifier stays the same-origin /vendor bundle
    assert.ok(inputs.some((i) => i.endsWith("network/host-liveness.mjs")), "network/host-liveness.mjs is part of the bundle graph");
    assert.ok(!inputs.some((i) => /network\/host-capacity(-record)?\.mjs$/.test(i)), "the record reader is loaded from /vendor/host-capacity.js, not bundled into the pages");
    // the platform host policy rule and its loader are the same-origin /vendor/host-policy.js bundle, never page code
    assert.ok(!inputs.some((i) => /network\/(platform-host-policy|host-policy-adapters)\.mjs$/.test(i)), "the policy gate is loaded from /vendor/host-policy.js");
    assert.ok(!inputs.some((i) => /^node:|sdk\/(storage|bootstrap)\//.test(i)), "no Node-only SDK module reaches the browser bundle");
    const text = fs.readdirSync(out, { recursive: true }).filter((f) => f.endsWith(".js"))
      .map((f) => fs.readFileSync(path.join(out, f), "utf8")).join("\n");
    for (const marker of ["enclave-browser-profile", "independent-mode:", "storage requirement not met", "snp-guest-per-app"])
      assert.ok(text.includes(marker), "bundle carries " + marker);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test("the vendored sessions SDK is the current browser build with relay-free preparation", async () => {
  const vendored = fs.readFileSync(path.join(REPO, "site/vendor/sessions.js"));
  assert.deepEqual(vendored, fs.readFileSync(path.join(REPO, "sdk/sessions/dist/browser.mjs")), "site/vendor/sessions.js == sdk/sessions/dist/browser.mjs");
  const sdk = await import(pathToFileURL(path.join(REPO, "site/vendor/sessions.js")).href);
  for (const name of ["prepareSessionOpen", "Session", "buildGrant", "newSessionKey", "completeSession", "IndexedDbStore"])
    assert.ok(sdk[name], "exports " + name);
  assert.equal(typeof sdk.Session.prototype.prepareCall, "function");
  assert.equal(typeof sdk.Session.prototype.prepareTermination, "function");
});
