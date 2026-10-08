// compute-measure.mjs -- this node's compute, MEASURED: the GFLOPS it publishes (nodeGflops) come from running work, not
// from the fleet's 62.5-per-vCPU convention. That convention was 2.4x this box's measured figure on 2026-10-08 (1000 vs 420).
//
// flops-probe.wasm (the pVM tier's measurement component, shielded/anchor/avf/runtime/conformance/flops-probe; pinned here
// by sha256) does an exactly counted amount of f32x4 multiply-add work: steps x 128 flops. It runs under the SAME runtime
// the node's apps get (wasmtime, Cranelift JIT): compiled once, then one copy per vCPU, all started together. The work
// grows until a run lasts at least a second. Every copy must print the same line, and the work must equal steps x 128.
// The result is copies x flops / wall time. The caller keeps the convention only when this throws, and says so.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flops-probe.wasm');
export const PROBE_SHA256 = '20deffce2d6f5d747ded48899e58d81bb290775cc59c2e7ad5e7be8341c71c36';
export const FLOPS_PER_STEP = 128;
export const METHOD = 'flops-probe: f32x4 multiply-add, every vCPU at once, under the same wasmtime as the apps';

function proc(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { c.kill(); reject(new Error(`${path.basename(bin)} ${args[0]} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    c.stdout.on('data', (d) => { if (out.length < 4096) out += d; });
    c.stderr.on('data', (d) => { if (err.length < 4096) err += d; });
    c.on('error', (e) => { clearTimeout(t); reject(e); });
    c.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out.trim()) : reject(new Error(`${path.basename(bin)} ${args[0]} exited ${code}: ${err.trim().slice(0, 300)}`)); });
  });
}

// One concurrent run: `instances` copies started together; resolves with each output and the wall time.
export async function runConcurrent({ wasmtime, cwasm, instances, steps, timeoutMs = 120000 }) {
  const t0 = performance.now();
  const outs = await Promise.all(Array.from({ length: instances }, () =>
    proc(wasmtime, ['run', '--allow-precompiled', cwasm, 'simd', String(steps), '7'], timeoutMs)));
  return { wallMs: performance.now() - t0, outs };
}

export async function measureGflops({ wasmtime, instances, probe = PROBE, probeSha256 = PROBE_SHA256, minWallMs = 1000,
                                      startSteps = 2_000_000, maxRuns = 6, run = runConcurrent, compile = null } = {}) {
  if (!Number.isInteger(instances) || instances < 1 || instances > 256) throw new Error('instances must be 1..256');
  const sha = createHash('sha256').update(fs.readFileSync(probe)).digest('hex');
  if (sha !== probeSha256) throw new Error(`flops-probe sha256 ${sha} is not the pinned ${probeSha256}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flops-'));
  try {
    const cwasm = path.join(dir, 'flops-probe.cwasm');
    await (compile ? compile(probe, cwasm) : proc(wasmtime, ['compile', probe, '-o', cwasm], 120000));
    let steps = startSteps, r = null, runs = 0;
    for (; runs < maxRuns; runs++) {
      r = await run({ wasmtime, cwasm, instances, steps });
      if (r.wallMs >= minWallMs) break;
      steps = Math.max(steps * 2, Math.ceil(steps * 1500 / Math.max(1, r.wallMs)));
    }
    if (!r || r.wallMs < minWallMs) throw new Error(`no run lasted ${minWallMs} ms in ${maxRuns} tries`);
    if (r.outs.length !== instances) throw new Error(`${r.outs.length} of ${instances} copies answered`);
    if (r.outs.some((o) => o !== r.outs[0])) throw new Error('the copies answered differently');
    const m = /^flops=(\d+) kernel=simd steps=(\d+) /.exec(r.outs[0]);
    if (!m || Number(m[2]) !== steps || Number(m[1]) !== steps * FLOPS_PER_STEP) throw new Error(`the work is not steps x ${FLOPS_PER_STEP}: ${r.outs[0].slice(0, 120)}`);
    const flops = Number(m[1]);
    return { gflops: Math.round(instances * flops / (r.wallMs * 1e6) * 10) / 10, perInstance: Math.round(flops / (r.wallMs * 1e6) * 10) / 10,
             instances, steps, wallMs: Math.round(r.wallMs), runs: runs + 1, method: METHOD };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
