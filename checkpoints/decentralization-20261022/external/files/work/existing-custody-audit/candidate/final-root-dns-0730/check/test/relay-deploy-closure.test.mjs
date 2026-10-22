// relay/deploy.sh ships a FLAT directory for the api relay. Every module api-relay.js reaches through a relative import
// must be in that list (or in the network runtime bundle it builds and ships, or vendor/): a missing file passes scp and
// then crash-loops the service with ERR_MODULE_NOT_FOUND. This walks the real import graph and compares.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../relay");
const SPEC = [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g];
function closure(entry) {
  const seen = new Set(), outside = [];
  const visit = (f) => { if (seen.has(f)) return; seen.add(f);
    for (const re of SPEC) for (const m of fs.readFileSync(f, "utf8").matchAll(re)) {
      if (!m[1].startsWith(".")) continue;
      const t = path.resolve(path.dirname(f), m[1]);
      assert.ok(fs.existsSync(t), `${path.relative(RELAY, f)} imports a missing ${m[1]}`);
      if (path.dirname(t) !== RELAY) { outside.push(path.relative(RELAY, t)); continue; }
      visit(t); } };
  visit(path.join(RELAY, entry));
  return { files: [...seen].map((f) => path.basename(f)), outside };
}
test("the api relay's deploy list covers its whole import graph (the platform host policy arrives inside the shipped bundle)", () => {
  const deploy = fs.readFileSync(path.join(RELAY, "deploy.sh"), "utf8");
  const line = deploy.split("\n").find((l) => l.startsWith("scp api-relay.js "));
  const shipped = new Set(line.replace(/^scp /, "").replace(/ nan:\/opt\/nan-relay\/$/, "").split(/\s+/));
  assert.ok(deploy.includes("scp network-runtime.bundle.mjs network-runtime.bundle.mjs.manifest.json nan:/opt/nan-relay/"));
  shipped.add("network-runtime.bundle.mjs");
  const c = closure("api-relay.js");
  assert.deepEqual(c.files.filter((f) => !shipped.has(f)), [], "every relative import is shipped");
  assert.deepEqual(c.outside, ["vendor/enclave-verifier-node.mjs"], "the only out-of-directory import is the vendored verifier deploy.sh ships");
  const bundle = fs.readFileSync(path.join(RELAY, "network-runtime.bundle.mjs"), "utf8");
  for (const name of ["createHostPolicyRuntime", "resolveHostPolicyConfig", "leaseHostAdmission"]) assert.match(bundle, new RegExp(`\\b${name}\\b`), `the bundle exports ${name}`);
});
