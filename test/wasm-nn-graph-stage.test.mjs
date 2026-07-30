// What the ggml preload actually sees.
//
// `-S nn-graph=ggml::<dir>` takes a DIRECTORY, and the manager does not hand it
// the volume mount: Modelwrap mounts are named mpk-<root_hash> and multi-quant
// repos carry many *.gguf, so _stage_nn_graph builds a symlink dir named after
// the volume and hands wasmtime that. Everything the host must SEE has to be
// linked into it - which is the whole point of this file.
//
// The regression it exists for (2026-07-30): a vision volume's projector was
// not staged, so the host scanned the staging dir, found no *mmproj*.gguf, and
// reported vision=0 - while the guest, which reads the REAL mount at
// /models/<name>, could see the 1.1 GB projector perfectly well. The deployment
// said "the volume carries no *mmproj*.gguf, or this node's llama.cpp toolchain
// is too old" when the file was right there and the toolchain was fine.
//
//   run: node --test test/wasm-nn-graph-stage.test.mjs   (needs python3)

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MGR = path.join(REPO, "wasm", "wasm_manager.py");

// Lay out a volume, stage it, and report what landed in the staging dir.
function stage(files, pick) {
  const root = mkdtempSync(path.join(tmpdir(), "vol-"));
  const vol = path.join(root, "mpk-deadbeef");
  mkdirSync(vol);
  for (const [name, size] of Object.entries(files)) writeFileSync(path.join(vol, name), "x".repeat(size));
  const code = `
import importlib.util, sys, os, pathlib, json
os.environ["WASM_FS_DIR"] = ${JSON.stringify(path.join(root, "fs"))}
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
m.FS_DIR = pathlib.Path(${JSON.stringify(path.join(root, "fs"))})
d = m._stage_nn_graph("vol-under-test", pathlib.Path(${JSON.stringify(vol)}) / ${JSON.stringify(pick)})
print(json.dumps({"staged": sorted(p.name for p in d.glob("*")), "bytes": m._staged_bytes(d)}))
`;
  const out = execFileSync("python3", ["-c", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").pop());
}

test("a vision volume stages its projector beside the model", () => {
  const r = stage({
    "Qwen3VL-8B-Instruct-Q8_0.gguf": 4096,
    "mmproj-Qwen3VL-8B-Instruct-F16.gguf": 1024,
    "tokenizer.json": 2,
  }, "Qwen3VL-8B-Instruct-Q8_0.gguf");
  assert.ok(r.staged.includes("model.gguf"), "the model stages under the contract name");
  assert.ok(r.staged.some((n) => n.toLowerCase().includes("mmproj")),
    "the projector MUST be staged or the host reports vision=0 with the file in plain sight");
  // the host's model pick is "exactly one gguf that is not a projector"
  const models = r.staged.filter((n) => n.endsWith(".gguf") && !n.toLowerCase().includes("mmproj"));
  assert.deepEqual(models, ["model.gguf"], "two ggufs must not make the model ambiguous");
  // the projector is resident VRAM once an image arrives, so it belongs in the
  // preload-order sort key rather than being invisible to it
  assert.equal(r.bytes, 5120, "staged bytes count the projector too");
});

test("a text-only volume is untouched by that", () => {
  const r = stage({ "model-q4_k_m.gguf": 512, "tokenizer.json": 2 }, "model-q4_k_m.gguf");
  assert.deepEqual(r.staged.filter((n) => n.endsWith(".gguf")), ["model.gguf"]);
});

test("a split model keeps its real part names, and still gets the projector", () => {
  // llama.cpp derives sibling paths from part 00001's NAME, so those must
  // survive staging; the projector rides along under its own name.
  const r = stage({
    "big-00001-of-00002.gguf": 64,
    "big-00002-of-00002.gguf": 64,
    "mmproj-big-f16.gguf": 32,
  }, "big-00001-of-00002.gguf");
  assert.ok(r.staged.includes("big-00001-of-00002.gguf") && r.staged.includes("big-00002-of-00002.gguf"),
    "split part names must survive");
  assert.ok(r.staged.includes("mmproj-big-f16.gguf"), "projector staged for a split model too");
  assert.ok(!r.staged.includes("model.gguf"), "a split family does not also stage model.gguf");
});

test("an sd checkpoint volume gains nothing from the gguf rule", () => {
  const r = stage({ "diffusion.safetensors": 128 }, "diffusion.safetensors");
  assert.deepEqual(r.staged, ["model.safetensors"], "sd volumes have no projector pairing");
});
