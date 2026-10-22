// The hosted MCP adapter bundle as the measured control image carries it (/opt/metal/mcp-server.bundle.mjs and its manifest
// runtimeFiles at their image paths; scripts/build-mcp-guest-bundle.mjs, metal/build-image.mjs, metal/overlay-control-image.py):
// the argv-guarded entry and the declared runtime files. (The adapter's behaviour end to end is test/mcp-hosted-control.test.mjs.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(REPO, "metal/guest/mcp-server.bundle.mjs");
const m = JSON.parse(fs.readFileSync(BUNDLE + ".manifest.json", "utf8"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const read = (rel) => fs.readFileSync(path.join(REPO, rel));
const RELATIVE_READS = /new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;
const rels = [...fs.readFileSync(BUNDLE, "utf8").matchAll(RELATIVE_READS)].map((x) => x[1]);

test("the manifest names the guarded entry, and every file the bundled code reads beside itself is a declared runtime file", () => {
  assert.equal(m.sha256, sha(fs.readFileSync(BUNDLE)));
  assert.equal(m.entry, "mcp/server.mjs");
  assert.equal(m.bundleEntry, "metal/guest/mcp-server-entry.mjs");
  for (const f of [m.entry, m.bundleEntry, "network/host-services/argv-guard.mjs"]) assert.equal(m.inputs[f], sha(read(f)), f);
  // the lazily loaded libraries whose own "am I main?" checks the guard has to make false
  for (const f of ["windows/node/host-identity.mjs", "cli/independent-capacity.mjs"]) assert.ok(m.inputs[f], `${f} is bundled`);
  assert.ok(rels.length >= 2, "the bundle reads files beside itself");
  for (const rel of rels) assert.ok(m.runtimeFiles[path.posix.normalize(`opt/metal/${rel}`)], `${rel} is a declared runtime file`);
  for (const [at, s] of Object.entries(m.runtimeFiles)) {
    assert.match(at, /^opt\/[^]+$/); assert.equal(path.posix.normalize(at), at);
    assert.equal(s.sha256, sha(read(s.source)), `${at} <- ${s.source}`);
  }
});

test("laid out as the image lays it out, the bundle runs the adapter's main behind the argv guard and finds its runtime files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-guest-bundle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const at = path.join(root, "opt/metal/mcp-server.bundle.mjs");
  fs.mkdirSync(path.dirname(at), { recursive: true }); fs.copyFileSync(BUNDLE, at);
  for (const [img, s] of Object.entries(m.runtimeFiles)) {
    fs.mkdirSync(path.dirname(path.join(root, img)), { recursive: true }); fs.copyFileSync(path.join(REPO, s.source), path.join(root, img));
  }
  for (const rel of rels) assert.ok(fs.existsSync(fileURLToPath(new URL(rel, pathToFileURL(at)))), `${rel} resolves to an installed file`);
  // gsup's argv shape (measured-control.mjs directMcpLaunch), with a config that does not exist: main must be reached (its
  // error, exit 1) and, by then, the guard must have renamed argv[1] so no bundled library can take the bundle for itself
  const probe = path.join(root, "probe.mjs");
  fs.writeFileSync(probe, 'process.on("exit", () => process.stderr.write("ARGV1=" + process.argv[1] + "\\n"));\n');
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(probe).href, at, "--config", path.join(root, "absent.json"), "--remote", "--listen", "127.0.0.1:0"],
    { cwd: root, encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^mcp\/server: /m);
  assert.ok(r.stderr.includes(`ARGV1=${at} (enclave host role)\n`), r.stderr);
});
