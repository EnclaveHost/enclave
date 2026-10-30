// apk-code-hash.mjs: the phone computes its own pVM codeHash -- byte-for-byte pins.py's fsverity_root (which was matched to the
// phone's `vm create-idsig`), across the block-boundary and tree-depth edges, and a real release APK's v4 idsig when present.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { apkCodeHash } from "../shielded/anchor/avf/runner/apk-code-hash.mjs";

const AVF = new URL("../shielded/anchor/avf/", import.meta.url).pathname;
const py = (file) => execFileSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import pins; print(pins.fsverity_root(open(sys.argv[2], 'rb').read()).hex())", AVF, file]).toString().trim();

test("the same root as pins.py: empty, partial, exact and multi-level files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codehash-"));
  // 128 leaves fill one 4096-byte level block: 128*4096 bytes is one level, one more block is two
  for (const n of [0, 1, 4095, 4096, 4097, 128 * 4096, 128 * 4096 + 1, 128 * 128 * 4096 + 5]) {
    const f = path.join(dir, `f${n}`);
    fs.writeFileSync(f, crypto.randomBytes(n));
    assert.equal(await apkCodeHash(f), py(f), `size ${n}`);
  }
});

test("a release APK's own v4 idsig root (when the owner's APK archive is on this machine)", async (t) => {
  const dir = path.join(os.homedir(), "enclave-prod/pvm-host/apk");
  const apks = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith(".apk") && fs.existsSync(path.join(dir, `${x}.idsig`))) : [];
  if (!apks.length) return t.skip("no release APK archive here");
  const a = path.join(dir, apks[0]);
  const idsig = execFileSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import pins; print(pins.parse_idsig(sys.argv[2])['rootHash'])", AVF, `${a}.idsig`]).toString().trim();
  assert.equal(await apkCodeHash(a), idsig);
});
