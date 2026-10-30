// wasm/Dockerfile.wasm rebuilds the dlopened CPU module (libggml-cpu.so) itself
// and overwrites the toolchain image's copy, "from the SAME llama revision and
// ABI flags as the pinned toolchain". Every other engine library (libllama,
// libggml-base) comes from the pinned toolchain tarball. So the CPU module and
// the pinned base must agree:
//   - a patch the CPU stage applies must also be one the llamacpp-toolchain
//     workflow applies, in the same relative order (same sources);
//   - it may touch ONLY ggml/src/ggml-cpu/ (CPU-internal). A patch that also
//     changes ggml.h / ggml.c (e.g. llamacpp-rs-inplace.patch: a new op
//     constructor in libggml-base and its kernel in ops.cpp) must ship together
//     with a toolchain dispatch AND a WASMTIME_IMAGE repin, because the CPU
//     module's kernel and the pinned base's constructor have to match. Adding
//     such a patch here without that repin pairs a patched kernel with an
//     unpatched base; this test makes that a deliberate, reviewed edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

function cpuStagePatches() {
  const df = read("wasm/Dockerfile.wasm");
  const start = df.search(/^FROM [^\n]* AS ggml-cpu-build$/m);
  assert.ok(start >= 0, "ggml-cpu-build stage not found in wasm/Dockerfile.wasm");
  const rest = df.slice(start + 1);
  const end = rest.search(/^FROM /m);
  const stage = end >= 0 ? rest.slice(0, end) : rest;
  return [...stage.matchAll(/^COPY (llamacpp-[\w.-]+\.patch) /gm)].map((m) => m[1]);
}
function toolchainPatches() {
  const wf = read(".github/workflows/llamacpp-toolchain.yml");
  return [...wf.matchAll(/git apply "\$GITHUB_WORKSPACE\/wasm\/(llamacpp-[\w.-]+\.patch)"/g)].map((m) => m[1]);
}
function touchedFiles(patch) {
  const src = read(`wasm/${patch}`);
  const files = new Set();
  for (const m of src.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)) if (m[1] !== "/dev/null") files.add(m[1]);
  return [...files];
}

test("the CPU module stage applies only toolchain patches, in toolchain order", () => {
  const cpu = cpuStagePatches(), tc = toolchainPatches();
  assert.ok(cpu.length > 0, "no patch found in the ggml-cpu-build stage (parser out of date?)");
  let last = -1;
  for (const p of cpu) {
    const i = tc.indexOf(p);
    assert.ok(i >= 0, `${p} is applied to the CPU module but not by llamacpp-toolchain.yml`);
    assert.ok(i > last, `${p} is out of toolchain order in the CPU module stage`);
    last = i;
  }
});

test("every CPU module patch is CPU-internal (touches only ggml/src/ggml-cpu/)", () => {
  for (const p of cpuStagePatches()) {
    const files = touchedFiles(p);
    assert.ok(files.length > 0, `${p}: no touched files parsed`);
    for (const f of files) {
      assert.ok(f.startsWith("ggml/src/ggml-cpu/"),
        `${p} touches ${f}: it changes more than the CPU module, so it must ship with a llamacpp-toolchain dispatch and a WASMTIME_IMAGE repin, not in the CPU stage alone`);
    }
  }
});
