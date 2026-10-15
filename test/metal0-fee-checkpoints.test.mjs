// metal0's control supervisor routes proof-of-time checkpoints through planCheckpoints
// (windows/node/verification-checkpoints.mjs, tested by test/verification-checkpoints.test.mjs).
// This pins the three things that file cannot see on the metal0 lineage: supervisor.js submits
// what the planner returns (steady AND final proofs), the checkout shim is the same module, and
// the control image overlay carries the module at the path supervisor.js imports (/app/...).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as shim from "../verification-checkpoints.mjs";
import * as real from "../windows/node/verification-checkpoints.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUP = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8");

test("the checkout shim is the planner itself", () => {
  assert.equal(shim.planCheckpoints, real.planCheckpoints);
  assert.match(SUP, /^import \{ planCheckpoints \} from "\.\/verification-checkpoints\.mjs";$/m);
});

test("steady and final proofs are sent where the planner says, never straight to the prover", () => {
  const one = /async function proveLeases\(recs, why\) \{([\s\S]*?)\n\}/.exec(SUP)[1];
  assert.match(one, /await planCheckpoints\(\{client: chainClient, ledger: DEPLOYMENTS_ADDRESS,\s*proof: PROOF_OF_TIME_ADDRESS, batch,/);
  assert.match(one, /sendOperatorTx\(plan\.address, PROOF_ABI, plan\.functionName, plan\.args\)/);
  // an unconfirmed plan marks its ids refused (no stamp, no in-function retry)
  assert.match(one, /catch \(e\) \{\s*for \(const id of plan\.ids\) refused\.add/);
  const final = /async function proveFinalPeriod\(rec, why\) \{([\s\S]*?)\n\}/.exec(SUP)[1];
  assert.match(final, /const \[plan\] = await planCheckpoints\(\{[\s\S]*?batch: \[cp\]/);
  assert.match(final, /sendOperatorTx\(plan\.address, PROOF_ABI, plan\.functionName, plan\.args\)/);
  assert.ok(!/sendOperatorTx\(PROOF_OF_TIME_ADDRESS/.test(SUP), "no checkpoint bypasses the planner");
});

// newc cpio helpers for a synthetic base image
function entry(name, data, mode, ino) {
  const nm = Buffer.from(name + "\0");
  const f = [ino, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, nm.length, 0];
  let e = Buffer.concat([Buffer.from("070701" + f.map((n) => n.toString(16).padStart(8, "0")).join("")), nm]);
  e = Buffer.concat([e, Buffer.alloc(-e.length & 3), data, Buffer.alloc(-data.length & 3)]);
  return e;
}
function parse(raw) {
  const out = new Map(); let off = 0;
  while (off < raw.length) {
    const h = raw.subarray(off, off + 110).toString(); off += 110;
    const size = parseInt(h.slice(6 + 6 * 8, 14 + 6 * 8), 16), ns = parseInt(h.slice(6 + 11 * 8, 14 + 11 * 8), 16);
    const name = raw.subarray(off, off + ns - 1).toString(); off = (off + ns + 3) & ~3;
    const data = raw.subarray(off, off + size); off = (off + size + 3) & ~3;
    if (name === "TRAILER!!!") break;
    out.set(name, data);                                  // later entries win, as on unpack
  }
  return out;
}

test("the control overlay appends /app/verification-checkpoints.mjs from the committed module", () => {
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m0fee-"));
  try {
    const base = path.join(tmp, "base"); fs.mkdirSync(base);
    const files = ["app/supervisor.js", "opt/metal/gsup.mjs", "opt/metal/agent.mjs", "opt/metal/manifest.json",
      "app/isolation/m4/guestd/supervisor-splice.mjs", "app/isolation/m4/guestd/supervisor-guestcert.mjs"];
    let ino = 1;
    const cpio = Buffer.concat([entry("app", Buffer.alloc(0), 0o40755, ino++),
      ...files.map((f) => entry(f, Buffer.from("old\n"), 0o100644, ino++)), entry("TRAILER!!!", Buffer.alloc(0), 0, 0)]);
    const gz = zlib.gzipSync(cpio), kernel = Buffer.from("kernel");
    fs.writeFileSync(path.join(base, "initramfs.cpio.gz"), gz);
    fs.writeFileSync(path.join(base, "vmlinuz"), kernel);
    fs.writeFileSync(path.join(base, "cmdline"), "console=ttyS0\n");
    fs.writeFileSync(path.join(base, "manifest.json"), JSON.stringify({ initramfs: { sha256: sha(gz) }, kernel: { sha256: sha(kernel) } }));
    const out = path.join(tmp, "out");
    execFileSync("python3", ["-I", path.join(REPO, "metal/overlay-control-image.py"), base, out, "HEAD"], { cwd: REPO, stdio: "pipe" });
    const got = parse(zlib.gunzipSync(fs.readFileSync(path.join(out, "initramfs.cpio.gz"))));
    const want = execFileSync("git", ["show", "HEAD:windows/node/verification-checkpoints.mjs"], { cwd: REPO });
    assert.deepEqual(got.get("app/verification-checkpoints.mjs"), want);
    assert.match(got.get("app/supervisor.js").toString(), /from "\.\/verification-checkpoints\.mjs"/);
    const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.ok(m.controlOverlay.files.some((f) => f.path === "/app/verification-checkpoints.mjs" && f.sha256 === sha(want)));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
