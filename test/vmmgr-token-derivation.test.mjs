// The wasm-manager control token is DERIVED from the fleet SECRET, in two
// languages that must agree exactly.
//
// supervisor.js sends this token as a bearer header on every launch/kill/control
// call; wasm_manager.py checks it. It used to be the raw fleet SECRET on both
// sides - the same master that HMAC(SECRET,"enclave dns-txt v1") and
// HMAC(SECRET,"enclave secrets v1") are derived from. Those two are only ever
// HMAC keys and never leave the process; this one is on the wire constantly, so
// a single observed header was the whole keyring rather than one control plane.
//
// Deriving it fixes that, but only if both sides derive the SAME bytes - a
// mismatch is a dead control plane, not a loud error, so pin it against the real
// Python constant rather than a re-implementation of it.
//
//   run: node --test test/vmmgr-token-derivation.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MGR = path.join(REPO, "wasm", "wasm_manager.py");

// import wasm_manager with a given env and read back what IT computed. The
// module guards its server behind __main__, so importing is side-effect free.
function pythonToken(env) {
  const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec)
sys.modules["wm"] = m
spec.loader.exec_module(m)
print(json.dumps({"token": m.VMMGR_TOKEN, "legacy": getattr(m, "VMMGR_TOKEN_LEGACY", None)}))
`;
  const out = execFileSync("python3", ["-c", code], {
    env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

const nodeToken = (secret) =>
  createHmac("sha256", new TextEncoder().encode(secret)).update("enclave vmmgr v1").digest("hex");

test("supervisor.js and wasm_manager.py derive the same token from one SECRET", () => {
  for (const secret of ["s3cr3t", "0123456789abcdef".repeat(4), "with spaces and ünïcødé", "-"]) {
    const py = pythonToken({ SECRET: secret, VMMGR_TOKEN: "" });
    assert.equal(py.token, nodeToken(secret), `derivation drifted for ${JSON.stringify(secret)}`);
    assert.match(py.token, /^[0-9a-f]{64}$/);
  }
});

test("the derived token is NOT the raw secret", () => {
  const secret = "0123456789abcdef".repeat(4);
  const py = pythonToken({ SECRET: secret, VMMGR_TOKEN: "" });
  assert.notEqual(py.token, secret, "the master must not be what goes on the wire");
});

test("an explicit VMMGR_TOKEN still wins on both sides", () => {
  const py = pythonToken({ SECRET: "s3cr3t", VMMGR_TOKEN: "explicit-token" });
  assert.equal(py.token, "explicit-token");
  // supervisor.js reads the same override first
  const src = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8");
  assert.match(src, /const VMMGR_TOKEN = process\.env\.VMMGR_TOKEN\s*\n?\s*\|\|/);
});

test("the raw SECRET is no longer accepted anywhere on this plane", () => {
  // The staggered-rollout window is CLOSED (2026-07-27): both live enclaves run
  // post-derivation supervisors. Re-adding a legacy branch would make one
  // observed loopback header worth the whole fleet keyring again.
  const secret = "s3cr3t";
  const py = pythonToken({ SECRET: secret, VMMGR_TOKEN: "" });
  assert.equal(py.legacy, null, "no legacy raw-SECRET token may exist");
  const src = fs.readFileSync(MGR, "utf8");
  const code = src.split("\n").map((l) => l.split("#")[0]).join("\n");
  assert.doesNotMatch(code, /VMMGR_TOKEN_LEGACY/, "the manager must not carry a second accepted token");
  assert.doesNotMatch(code, /compare_digest\(_b\(tok\), _b\(_SECRET_RAW\)\)/);
  // with no SECRET at all there is nothing to accept
  const none = pythonToken({ SECRET: "", VMMGR_TOKEN: "" });
  assert.equal(none.token, "");
});

test("supervisor.js derives with the same label, and never sends the raw SECRET", () => {
  const src = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8");
  assert.match(src, /createHmac\("sha256", SECRET\)\.update\("enclave vmmgr v1"\)\.digest\("hex"\)/);
  // the old shape sent process.env.SECRET straight through
  assert.doesNotMatch(src, /const VMMGR_TOKEN = process\.env\.VMMGR_TOKEN \|\| process\.env\.SECRET/);
  // and the labels stay distinct: reusing one across purposes rebuilds the
  // single-key problem this fixes. Code only - the file also documents the
  // dns-txt derivation in a comment, and a commented example is not a second key.
  const labels = src.split("\n")
    .map((l) => l.slice(0, l.includes("//") ? l.indexOf("//") : undefined))
    .flatMap((l) => [...l.matchAll(/\.update\("(enclave [a-z0-9 -]+ v\d)"\)/g)].map((m) => m[1]));
  assert.equal(new Set(labels).size, labels.length, `derivation labels must be unique: ${labels.join(", ")}`);
  // Each label is a separate leaf of the fleet SECRET, and adding one is a
  // deliberate act - hence this pin. What each reaches:
  //   vmmgr    - the wasm-manager control plane (sent as a bearer header)
  //   secrets  - authenticates a lease-holder's per-deployment secrets fetch
  //   dns-txt  - authorizes an ACME challenge push at the DNS daemon
  //   opsign   - lets the in-guest metal agent ask for ONE scoped signature:
  //              the tunnel attach challenge, over a message this process
  //              builds (see /v1/internal/tunnel-attach-sig and
  //              test/opsign.test.mjs). It is not a signing oracle.
  assert.deepEqual(new Set(labels),
    new Set(["enclave vmmgr v1", "enclave secrets v1", "enclave dns-txt v1", "enclave opsign v1"]),
    "a new derivation label needs a look at what else that key can reach");
});
