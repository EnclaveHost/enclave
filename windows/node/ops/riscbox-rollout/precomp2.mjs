// Compile an override artifact exactly as the node will, to the cache path it will look for, so a
// relaunch does not wait on Cranelift. Usage: node precomp2.mjs <wasm>
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const W = process.argv[2];
const sha = crypto.createHash("sha256").update(fs.readFileSync(W)).digest("hex");
const exe = "C:\\Users\\claude\\vbs\\enclave-rt\\ee-precompile.exe";
const out = `C:\\Users\\claude\\vbs\\node\\apps\\local-${sha.slice(0, 16)}.rt5f3.cwasm`;
console.log(`sha256 ${sha}`);
if (fs.existsSync(out) && fs.statSync(out).size > 64) { console.log(`already compiled: ${out} (${fs.statSync(out).size} bytes)`); process.exit(0); }
const t = Date.now();
try {
  const o = execFileSync(exe, [W, out, "3"], { encoding: "utf8", maxBuffer: 4 << 20 });
  console.log(`precompiled in ${((Date.now() - t) / 1000).toFixed(0)} s -> ${out} (${fs.statSync(out).size} bytes)`);
  console.log(o.trim().split("\n").slice(-2).join("\n"));
} catch (e) { console.log(`PRECOMPILE FAILED: ${String(e.stderr || e.message).slice(0, 600)}`); process.exit(1); }
