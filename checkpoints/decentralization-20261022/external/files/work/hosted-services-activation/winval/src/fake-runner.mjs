// SYNTHETIC runner for the bounded Windows validation of hostsvc-supervisor (work/hosted-services-activation/winval).
// Started by the supervisor exactly like the real runner: node [--max-old-space-size=N] fake-runner.mjs run <scenario.json>.
// It owns only its own children; it never touches any other process. Every child listens on a LOOPBACK EPHEMERAL port.
//   scenario.json { mode, children, stateDir, allocMiB?, cpuMs? }
//   serve        children listen + report; SIGBREAK/SIGINT/SIGTERM -> stop children, exit 0           (W1, W4, W7, W8)
//   orphans      children ready -> runner exits 0 WITHOUT stopping them (the job must reap them)     (W3)
//   fail         exit 1 at once                                                                       (W5 restart/start-limit)
//   alloc        children commit allocMiB each, one after another; results reported; exit 0           (W2 job-wide memory)
//   cpu          one child spins cpuMs wall time; reports its CPU time; exit 0                         (W1 CPU-rate cap)
//   procs        children started one by one; each spawn's outcome recorded (the job's ActiveProcessLimit must
//                refuse the ones beyond it: proof that the runner's children are in THIS job); exit 0        (W1 membership)
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const [, , role, a1, a2, a3] = process.argv;
const write = (dir, name, obj) => { const f = path.join(dir, name); fs.writeFileSync(f + '.tmp', JSON.stringify(obj)); fs.renameSync(f + '.tmp', f); };
const log = (dir, m) => fs.appendFileSync(path.join(dir, 'fake-runner.log'), `${new Date().toISOString()} ${m}\n`);

if (role === 'child') {
  const [idx, dir, kind] = [Number(a1), a2, a3];
  const report = { idx, pid: process.pid, envKeys: Object.keys(process.env).sort(), randomOk: crypto.randomBytes(16).length === 16 };
  if (kind === 'alloc') {
    const mib = Number(process.env.ALLOC_MIB || 0);
    // keep a GLOBAL reference: the commit must stay held while the siblings allocate (otherwise V8 may free it at once)
    // commit in ALLOC_STEP_MIB (10) steps (each written) so the report says exactly where a job limit refused
    const step = Number(process.env.ALLOC_STEP_MIB || 10), held = globalThis.__held = []; let gotMiB = 0, error = null;
    try { while (gotMiB < mib) { held.push(Buffer.alloc(step * 1024 * 1024, 1)); gotMiB += step; } }
    catch (e) { error = String(e && (e.code || e.message)); }
    report.alloc = { ok: gotMiB >= mib, mib, gotMiB, ...(error ? { error } : {}), rssMiB: Math.round(process.memoryUsage().rss / 1048576) };
    write(dir, `child-${idx}.json`, report);
    setTimeout(() => { void globalThis.__held; process.exit(0); }, 8000);   // hold the allocation while the next children try
  } else if (kind === 'cpu') {
    const ms = Number(process.env.CPU_MS || 5000), t0 = Date.now(), c0 = process.cpuUsage();
    while (Date.now() - t0 < ms) { crypto.createHash('sha256').update(String(Math.random())).digest(); }
    const c = process.cpuUsage(c0);
    write(dir, `child-${idx}.json`, { ...report, cpu: { wallMs: Date.now() - t0, userMs: Math.round(c.user / 1000), systemMs: Math.round(c.system / 1000) } });
    process.exit(0);
  } else {
    const srv = net.createServer((s) => s.end('ok\n'));
    srv.listen(0, '127.0.0.1', () => { write(dir, `child-${idx}.json`, { ...report, port: srv.address().port }); });
    setInterval(() => {}, 1 << 30);
  }
} else if (role === 'run') {
  const sc = JSON.parse(fs.readFileSync(a1, 'utf8')), dir = sc.stateDir;
  fs.mkdirSync(dir, { recursive: true });
  log(dir, `runner pid ${process.pid} mode ${sc.mode} envKeys ${Object.keys(process.env).sort().join(',')}`);
  write(dir, 'runner.json', { pid: process.pid, mode: sc.mode, envKeys: Object.keys(process.env).sort() });
  if (sc.mode === 'fail') { log(dir, 'failing on purpose (exit 1)'); process.exit(1); }
  // the role environment the real runner gives a child (runner.mjs baseEnv on win32): the OS directory names and PATH only
  const root = process.env.SystemRoot || 'C:\\Windows';
  const childEnv = (extra = {}) => ({ SystemRoot: root, WINDIR: process.env.WINDIR || root, PATH: `${root}\\System32`, ...extra });
  const kind = sc.mode === 'alloc' ? 'alloc' : sc.mode === 'cpu' ? 'cpu' : 'serve';
  const n = sc.mode === 'cpu' ? 1 : (sc.children || 3);
  const kids = [];
  // orphans: detached, so on Windows libuv does NOT put them in its own kill-on-close job; only the supervisor's job can end them
  const startChild = (i) => { const c = spawn(process.execPath, [SELF, 'child', String(i), dir, kind], { stdio: 'ignore', detached: sc.mode === 'orphans',
    env: childEnv({ ALLOC_MIB: String(sc.allocMiB || 0), ALLOC_STEP_MIB: String(sc.allocStepMiB || 10), CPU_MS: String(sc.cpuMs || 5000) }) }); kids.push(c); return c; };
  const ready = (i) => fs.existsSync(path.join(dir, `child-${i}.json`));
  const waitReady = async (i) => { for (let t = 0; t < 300 && !ready(i); t++) await new Promise((r) => setTimeout(r, 100)); return ready(i); };
  (async () => {
    if (kind === 'alloc' || kind === 'cpu') {
      for (let i = 0; i < n; i++) { const c = startChild(i); await waitReady(i); log(dir, `child ${i}: ${fs.readFileSync(path.join(dir, `child-${i}.json`), 'utf8')}`); void c; }
      await new Promise((r) => setTimeout(r, 3500));
      log(dir, `${sc.mode} done: exit 0`); process.exit(0);
    }
    if (sc.mode === 'procs') {
      const spawned = [], refused = [];
      for (let i = 0; i < n; i++) {
        let c; try { c = startChild(i); } catch (e) { refused.push({ i, error: String(e.code || e.message), sync: true }); continue; }   // Windows: a job refusal throws
        const r = await new Promise((ok) => { c.once('spawn', () => ok(null)); c.once('error', (e) => ok(String(e.code || e.message))); });
        if (r === null && await waitReady(i)) spawned.push(c.pid); else refused.push({ i, error: r ?? 'not ready' });
      }
      write(dir, 'runner.json', { pid: process.pid, mode: sc.mode, envKeys: Object.keys(process.env).sort(), children: spawned, refused });
      log(dir, `procs: spawned ${spawned.join(' ')} refused ${JSON.stringify(refused)}; exit 0`);
      for (const k of kids) k.kill();
      setTimeout(() => process.exit(0), 1000);
      return;
    }
    for (let i = 0; i < n; i++) startChild(i);
    for (let i = 0; i < n; i++) await waitReady(i);
    write(dir, 'runner.json', { pid: process.pid, mode: sc.mode, envKeys: Object.keys(process.env).sort(), children: kids.map((k) => k.pid) });
    log(dir, `children ready: ${kids.map((k) => k.pid).join(' ')}`);
    if (sc.mode === 'orphans') { log(dir, 'exiting 0 WITHOUT stopping the children (the job must reap them)'); process.exit(0); }
  })();
  let stopping = false;
  for (const sig of ['SIGBREAK', 'SIGINT', 'SIGTERM']) process.on(sig, () => {
    if (stopping) return; stopping = true;
    log(dir, `${sig} received: stopping ${kids.length} children`);
    let left = kids.filter((k) => k.exitCode === null && k.signalCode === null).length;
    if (!left) { log(dir, 'stopped: exit 0'); process.exit(0); }
    for (const k of kids) { k.once('exit', () => { if (--left === 0) { log(dir, 'stopped: exit 0'); process.exit(0); } }); k.kill(); }
    setTimeout(() => { log(dir, 'stopped (children already gone): exit 0'); process.exit(0); }, 3000).unref?.();
  });
  setInterval(() => {}, 1 << 30);
} else { console.error('usage: fake-runner.mjs run <scenario.json>'); process.exit(2); }
