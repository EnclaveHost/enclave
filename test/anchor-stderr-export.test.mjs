// The engine's diagnostic stderr export (anchor_stderr_export.h, ENGINE_EXPORT_STDERR=1) must round-trip
// through the host collector byte-exactly: the COMPILED exporter (the same C the VM engine links) writes the
// records, the collector reassembles them. Also: the capped tail is PARTIAL never COMPLETE, an out-of-bounds
// cap yields a FAILED record the collector rejects, and the collector's own ordering fixture passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "stderr-export-"));
const bin = join(dir, "exporter");
execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", `-I${root}wasm/ggml-shielded`, `-I${root}shielded/anchor/avf/payload`,
  `${root}test/fixtures/anchor-stderr-export.c`, "-o", bin]);
const collector = `${root}shielded/anchor/avf/host/stderr-collect.py`;
const collect = (log, out) => spawnSync("python3", [collector, log, out], { encoding: "utf8" });

test("compiled exporter -> collector: complete, byte-exact, every line under the engine's 4096 limit", () => {
  const sample = Buffer.concat([randomBytes(100000), Buffer.from("tail line with text\n")]);
  const src = join(dir, "sample.err"); writeFileSync(src, sample);
  const lines = execFileSync(bin, [src, "4194304"], { encoding: "utf8" }).trimEnd().split("\n");
  assert.ok(lines.every(l => l.length < 4000), "a record exceeds the control-channel line budget");
  const log = join(dir, "full.log"); writeFileSync(log, lines.map(l => "VSOCK " + l).join("\n") + "\n");
  const out = join(dir, "full.bin"); const r = collect(log, out);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(readFileSync(out).equals(sample), "collector output differs from the exported file");
  assert.equal(collect(log, out).status, 2, "an existing output must be refused (exclusive)");
});

test("capped export is PARTIAL with the exact tail; an out-of-bounds cap is a FAILED record the collector rejects", () => {
  const sample = randomBytes(100000); const src = join(dir, "sample2.err"); writeFileSync(src, sample);
  const log = join(dir, "cap.log"); writeFileSync(log, execFileSync(bin, [src, "65536"], { encoding: "utf8" }));
  const out = join(dir, "cap.bin"); const r = collect(log, out);
  assert.equal(r.status, 1, r.stdout); assert.match(r.stdout, /PARTIAL/);
  assert.ok(readFileSync(out).equals(sample.subarray(sample.length - 65536)));
  const badRun = spawnSync(bin, [src, "1000"], { encoding: "utf8" }); assert.equal(badRun.status, 1, "a refused cap exits 1");
  const bad = join(dir, "bad.log"); writeFileSync(bad, badRun.stdout);
  const rb = collect(bad, join(dir, "bad.bin")); assert.equal(rb.status, 2); assert.match(rb.stdout, /export failure/);
  const empty = join(dir, "empty.err"); writeFileSync(empty, ""); const elog = join(dir, "empty.log");
  writeFileSync(elog, execFileSync(bin, [empty, "65536"], { encoding: "utf8" }));
  const eo = join(dir, "empty.bin"); assert.equal(collect(elog, eo).status, 0); assert.equal(statSync(eo).size, 0);
});

test("collector ordering/bounds fixture", () => {
  const r = spawnSync("python3", [`${root}test/stderr-collect.test.py`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /(\d+)\/\1 PASS/);
});
