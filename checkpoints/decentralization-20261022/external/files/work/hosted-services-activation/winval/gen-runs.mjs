// Per-run supervisor.json + scenario.json for the Windows validation (generated here, uploaded; nothing is computed on
// minipc). Every path is under the dedicated new root.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)), OUT = path.join(HERE, 'upload', 'runs');
const V = 'C:\\ProgramData\\Enclave\\host-services-validation-20261021';
fs.rmSync(OUT, { recursive: true, force: true });
const runs = {
  w1: { mode: 'serve' }, 'w1-procs': { mode: 'procs', activeProcesses: 3, children: 4 }, w3: { mode: 'orphans' }, w2: { mode: 'alloc', jobMemoryMiB: 300 }, 'w2-single': { mode: 'alloc', jobMemoryMiB: 300, allocStepMiB: 120 }, 'w1-cpu50': { mode: 'cpu', cpuPercent: 50 },
  'w1-cpu1600': { mode: 'cpu', cpuPercent: 1600 }, w5: { mode: 'fail', restartSec: 1 }, w6: { real: true, jobMemoryMiB: 1024 }, w8: { mode: 'serve' },
};
for (const [name, r] of Object.entries(runs)) {
  const dir = path.join(OUT, name), run = `${V}\\runs\\${name}`;
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', '.keep'), '');
  const sup = { node: `${V}\\node\\node.exe`, nodeArgs: ['--max-old-space-size=128'],
    runner: r.real ? `${V}\\bin\\host-services-runner.mjs` : `${V}\\fixtures\\fake-runner.mjs`,
    config: r.real ? `${run}\\work\\host-services.json` : `${run}\\scenario.json`, workDir: `${run}\\state`,
    jobMemoryMiB: r.jobMemoryMiB ?? 768, cpuPercent: r.cpuPercent ?? 150, activeProcesses: r.activeProcesses ?? 16, restartSec: r.restartSec ?? 10,
    startLimitBurst: 5, startLimitIntervalSec: 600, stopTimeoutSec: 30, stopEvent: `Global\\Enclave-host-services-val20261021-${name}-stop`, log: `${run}\\state\\supervisor.log` };
  fs.writeFileSync(path.join(dir, 'supervisor.json'), JSON.stringify(sup, null, 2));
  if (!r.real) fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify({ mode: r.mode, children: r.children ?? 3, stateDir: `${run}\\state`, allocMiB: 120, ...(r.allocStepMiB ? { allocStepMiB: r.allocStepMiB } : {}), cpuMs: 4000 }, null, 2));
  else fs.mkdirSync(path.join(dir, 'work'), { recursive: true }), fs.writeFileSync(path.join(dir, 'work', '.keep'), '');
}
console.log(Object.keys(runs).join(' '));
