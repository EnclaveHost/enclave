import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { avfPadBinding, AVF_PAD_DOMAIN } from "../relay/avf-binding.mjs";

test("AVF transcript matches C and refuses substitution of either pVM key", () => {
  const dir = mkdtempSync(join(tmpdir(), "shielded-avf-binding-"));
  const source = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
  try {
    const bin = join(dir, "probe");
    execFileSync("cc", ["-std=c11", "-O1", "-g", "-Wall", "-Wextra", "-Werror",
      "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
      "-I", source("wasm/ggml-shielded"), source("test/fixtures/shielded-avf-binding.c"), "-o", bin],
    { timeout: 30_000, stdio: "pipe" });
    const got = execFileSync(bin, { timeout: 10_000, encoding: "utf8", env: { ...process.env,
      ASAN_OPTIONS: "detect_leaks=1:abort_on_error=1", UBSAN_OPTIONS: "halt_on_error=1" } }).trim();
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 0x11)]);
    const pk = "22".repeat(32), nonce = Buffer.alloc(32, 0x33);
    const expected = avfPadBinding(spki, pk, nonce);
    assert.equal(got, expected.toString("hex"));
    assert.equal(expected.length, Buffer.byteLength(AVF_PAD_DOMAIN) + 44 + 32 + 32);
    for (const bad of [null, Buffer.alloc(43), Buffer.alloc(45), Buffer.alloc(44)])
      assert.throws(() => avfPadBinding(bad, pk, nonce), /SPKI/);
    for (const bad of [null, "", pk + "00", pk.slice(2), "GG".repeat(32), "AA".repeat(32), pk + "\n"])
      assert.throws(() => avfPadBinding(spki, bad, nonce), /padKey/);
    for (const bad of [null, Buffer.alloc(31), Buffer.alloc(33)])
      assert.throws(() => avfPadBinding(spki, pk, bad), /nonce/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
