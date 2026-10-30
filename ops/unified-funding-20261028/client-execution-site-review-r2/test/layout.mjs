// UNREVIEWED, NOT RUN. Isolated temporary layouts for the generator tests (client-execution-site-r2): every pinned REAL
// input is COPIED into <tmp>/uf/... (and <tmp>/source/... for "../source/..." paths), the generator script is copied into
// <tmp>/uf/client-execution-site-r2/..., pins are computed from the copies, and python3 runs the copy. Nothing outside the
// temporary directory is written. A missing python3 or input FAILS (it is never a skip).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

export const HERE = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
export const UF = path.dirname(HERE);
export const STAGE = path.basename(HERE);
export const sha = (b) => createHash("sha256").update(b).digest("hex");

export function requirePython() {
  try { execFileSync("python3", ["--version"]); } catch { assert.fail("python3 is required for this test (it is not skipped)"); }
}
/** pinsFile: generated/<name>.json of this stage; scripts: stage-relative paths to copy (the generator and its fragments). */
export function layout(pinsFile, scripts, tweak = () => {}) {
  const template = JSON.parse(fs.readFileSync(path.join(HERE, "generated", pinsFile), "utf8"));
  const inputs = Object.keys(template.inputs);
  const missing = inputs.filter((rel) => !rel.startsWith(`${STAGE}/`) && !fs.existsSync(path.join(UF, rel)));
  assert.deepEqual(missing, [], "every pinned input outside this stage must exist");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "execution-site-r2-gen-"));
  const uf = path.join(tmp, "uf");
  const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
  for (const rel of inputs) copy(path.join(UF, rel), path.join(uf, rel));
  for (const s of scripts) copy(path.join(HERE, s), path.join(uf, STAGE, s));
  const c = { tmp, uf, stage: path.join(uf, STAGE), pins: { ...template, inputs: {} } };
  c.repin = () => { for (const rel of inputs) c.pins.inputs[rel] = sha(fs.readFileSync(path.join(uf, rel))); };
  c.repin();
  tweak(c);
  fs.mkdirSync(path.join(c.stage, "generated"), { recursive: true });
  fs.writeFileSync(path.join(c.stage, "generated", pinsFile), JSON.stringify(c.pins, null, 2));
  return c;
}
export const run = (c, script) => spawnSync("python3", [path.join(c.stage, script)], { encoding: "utf8" });
export const cleanup = (c) => fs.rmSync(c.tmp, { recursive: true, force: true });
export const read = (c, rel) => fs.readFileSync(path.join(c.uf, rel), "utf8");
export const out = (c, rel) => fs.readFileSync(path.join(c.stage, rel), "utf8");
/** true when every line of `small` (except `except`) appears in `big` in the same order. */
export function linesKept(small, big, except = []) {
  const want = small.split("\n").filter((l) => !except.includes(l));
  const have = big.split("\n");
  let i = 0;
  for (const l of have) if (i < want.length && l === want[i]) i += 1;
  return i === want.length;
}
/** Code only: block/line comments and string/template literals removed (as client-site-repair-r2's page test does). */
export const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1")
  .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""');
