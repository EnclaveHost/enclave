// deploy.yml's detect step: benchmark sources and the CPU-kernel test harness
// under wasm/ must not cut a release, and everything that IS an image or build
// input must still do so.
//
// Every path under wasm/ used to map to wasm=true (image rebuild -> measured
// release -> update-fleet). On 2026-09-23 seven pushes of benchmark sources,
// harness scripts and patch records each cut and published a release with no
// runtime change. The exclusion is only safe while nothing builds from those
// paths, so this test also guards the build inputs: if a Dockerfile, the metal
// guest build or a workflow starts reading an excluded path, it fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

// the paths the exclusion covers (keep in lockstep with deploy.yml)
const EXCLUDED = [/^wasm\/llamacpp-conv-inplace\//, /^wasm\/ggml-shielded\/bench-(spec|batch)\.cpp$/];

// deploy.yml's own `case "$f" in ... esac` block, run by bash over one path
const caseBlock = (() => {
  const src = read(".github/workflows/deploy.yml");
  const m = src.match(/^([ \t]*)case "\$f" in\n([\s\S]*?)^\1esac$/m);
  assert.ok(m, "deploy.yml detect case block not found");
  return `case "$f" in\n${m[2]}esac`;
})();
function detect(file) {
  const script = `site=false relay=false registry=false deployments=false catalog=false enclavepay=false paymentrouter=false
sup=false worker=false mps=false wasm=false metal=false config_touched=false
f="$1"
${caseBlock}
echo "wasm=$wasm metal=$metal sup=$sup"`;
  return execFileSync("bash", ["-c", script, "detect", file], { encoding: "utf8" }).trim();
}

test("benchmark sources and the CPU-kernel harness no longer set wasm=true", () => {
  for (const f of [
    "wasm/ggml-shielded/bench-spec.cpp",
    "wasm/ggml-shielded/bench-batch.cpp",
    "wasm/llamacpp-conv-inplace/README.md",
    "wasm/llamacpp-conv-inplace/harness-check.sh",
    "wasm/llamacpp-conv-inplace/conv-graph-test.cpp",
    "wasm/llamacpp-conv-inplace/deeper/dir/any.file",
  ]) assert.equal(detect(f), "wasm=false metal=false sup=false", f);
});

test("image and build inputs under wasm/ still set wasm=true", () => {
  for (const f of [
    "wasm/Dockerfile.wasm",
    "wasm/wasm_manager.py",
    "wasm/ipfs_fetch.py",
    "wasm/apps/nn-demo.wasm",
    "wasm/llamacpp-parallel-copy.patch",       // copied into the image's CPU module stage
    "wasm/llamacpp-graph-slot.patch",          // llamacpp-toolchain input
    "wasm/llamacpp-rs-inplace.patch",
    "wasm/ggml-shielded/ggml-shielded.cpp",    // compiled by metal/build-image.mjs
    "wasm/ggml-shielded/shielded-tee.c",
    "wasm/ggml-shielded/Makefile",
    "wasm/ggml-shielded/bench-other.cpp",      // only the two named bench sources are exempt
    "wasm/llama-shim/enclave_llama.c",
    "wasm/llamacpp-conv-inplace.patch",        // the patch FILE is not the harness directory
  ]) assert.match(detect(f), /^wasm=true /, f);
});

test("the pre-existing exemptions are unchanged", () => {
  assert.equal(detect("wasm/__pycache__/x.pyc"), "wasm=false metal=false sup=false");
  assert.equal(detect("wasm/.gitignore"), "wasm=false metal=false sup=false");
  assert.equal(detect("wasm/Dockerfile.wasmtime"), "wasm=false metal=false sup=false");
});

// ---- guards: nothing may BUILD from an excluded path -----------------------

function* walk(dir) {
  for (const e of readdirSync(path.join(ROOT, dir))) {
    if (e === ".git" || e === "node_modules") continue;
    const rel = dir ? `${dir}/${e}` : e;
    const st = statSync(path.join(ROOT, rel));
    if (st.isDirectory()) yield* walk(rel); else yield rel;
  }
}

test("no Dockerfile copies an excluded path, directly or through a directory or glob", () => {
  const dockerfiles = [...walk("")].filter((f) => /(^|\/)Dockerfile[^/]*$/.test(f));
  assert.ok(dockerfiles.includes("wasm/Dockerfile.wasm"), "wasm/Dockerfile.wasm not found");
  for (const df of dockerfiles) {
    const ctx = path.dirname(df) === "." ? "" : path.dirname(df);
    for (const line of read(df).split("\n")) {
      const m = line.match(/^\s*(COPY|ADD)\s+(.*)$/);
      if (!m || /--from=/.test(m[2])) continue;
      const args = m[2].replace(/--[a-z-]+=\S+/g, "").trim().split(/\s+/);
      for (const src of args.slice(0, -1)) {
        const full = path.posix.normalize(ctx ? `${ctx}/${src}` : src).replace(/\/$/, "");
        assert.ok(!/[*?[]/.test(src), `${df}: glob COPY source ${src} -- review it against the exclusion`);
        for (const re of EXCLUDED) {
          assert.ok(!re.test(full) && !re.test(full + "/"), `${df} copies excluded path ${full}`);
        }
        // a directory copy that CONTAINS an excluded path
        for (const probe of ["wasm/llamacpp-conv-inplace/x", "wasm/ggml-shielded/bench-spec.cpp", "wasm/ggml-shielded/bench-batch.cpp"]) {
          assert.ok(full === "." || !probe.startsWith(full + "/"), `${df}: directory COPY ${full} contains ${probe}`);
          assert.ok(!(full === "." && (ctx === "" || probe.startsWith(ctx + "/"))), `${df}: COPY . pulls in ${probe}`);
        }
      }
    }
  }
});

test("the metal guest build compiles no bench source", () => {
  const src = read("metal/build-image.mjs");
  assert.ok(/SHIELDED_CODE/.test(src), "metal/build-image.mjs no longer builds wasm/ggml-shielded: re-review");
  assert.ok(!/bench-(spec|batch)/.test(src), "metal/build-image.mjs references a bench source");
});

test("no workflow or script builds from an excluded path", () => {
  // deploy.yml itself names the paths: that is the exclusion, not a build input
  const files = [...walk(".github/workflows"), ...walk("scripts"), ...walk("metal")]
    .filter((f) => /\.(ya?ml|sh|mjs|js)$/.test(f) && f !== ".github/workflows/deploy.yml");
  for (const f of files) {
    const s = read(f);
    assert.ok(!/llamacpp-conv-inplace\//.test(s), `${f} references wasm/llamacpp-conv-inplace/`);
    assert.ok(!/bench-(spec|batch)\.cpp/.test(s), `${f} references a bench source`);
  }
});
