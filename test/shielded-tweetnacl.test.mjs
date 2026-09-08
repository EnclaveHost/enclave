import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomBytes, sign, diffieHellman } from "node:crypto";

for (const vendor of ["wasm/ggml-shielded", "shielded/anchor/avf/payload/third_party"]) {
  test(`TweetNaCl ${vendor}: Ed25519/X25519 match Node with no undefined carry arithmetic`, () => {
    const dir = mkdtempSync(join(tmpdir(), "tweetnacl-interop-"));
    const source = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
    try {
      const bin = join(dir, "probe");
      execFileSync("cc", ["-std=c11", "-O1", "-g", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
        "-I", source(vendor), source("test/fixtures/shielded-tweetnacl.c"), source(`${vendor}/tweetnacl.c`), "-o", bin],
      { timeout: 30_000, stdio: "pipe" });
      const run = (...args) => execFileSync(bin, args, { timeout: 10_000, encoding: "utf8", env: { ...process.env,
        ASAN_OPTIONS: "detect_leaks=1:abort_on_error=1", UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1" } }).trim();
      for (const n of [0, 1, 31, 64, 255, 1024, 4096]) {
        const ed = generateKeyPairSync("ed25519"), msg = randomBytes(n);
        const pk = ed.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
        const sk = Buffer.concat([ed.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32), pk]);
        const expected = sign(null, msg, ed.privateKey).toString("hex");
        assert.equal(run("sign", sk.toString("hex"), msg.toString("hex")), expected);
        assert.equal(run("verify", pk.toString("hex"), msg.toString("hex"), expected), "ok");
        const x = generateKeyPairSync("x25519"), y = generateKeyPairSync("x25519");
        const shared = diffieHellman({ privateKey: x.privateKey, publicKey: y.publicKey });
        assert.equal(run("dh", x.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("hex"),
          y.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex")), shared.toString("hex"));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
