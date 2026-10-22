// LOCAL (Linux) proof of the validation fixtures before any Windows run: the synthetic runner's modes, and the fixture
// chain driving the REAL runner bundle + REAL packages through current -> ban -> unban -> stop, judged by the stage tool.
//   node harness-local.mjs <stageDir> <app-static.json>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)), DIST = path.resolve(HERE, '../dist');
const [, , STAGE, STATIC] = process.argv;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winval-local-'));
let failures = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const run = (args, opts = {}) => new Promise((ok) => { const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }); let out = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('close', (code) => ok({ code, out })); });
const wait = async (f, ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await f()) return true; } catch {} await sleep(300); } return false; };
try {
  // 1. synthetic runner modes (no job object on Linux: the cap scenarios are only exercised for their reporting)
  for (const mode of ['serve', 'orphans', 'fail', 'alloc', 'cpu', 'procs']) {
    const dir = path.join(tmp, mode), sc = path.join(tmp, `${mode}.json`);
    fs.writeFileSync(sc, JSON.stringify({ mode, children: 3, stateDir: dir, allocMiB: 64, cpuMs: 1000 }));
    const c = spawn(process.execPath, [path.join(DIST, 'fake-runner.mjs'), 'run', sc], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
    const exit = new Promise((ok) => c.on('exit', (code) => ok(code)));
    if (mode === 'serve') {
      check(await wait(() => JSON.parse(fs.readFileSync(path.join(dir, 'runner.json'))).children?.length === 3, 15000), 'serve: 3 children ready');
      const kids = JSON.parse(fs.readFileSync(path.join(dir, 'runner.json'))).children;
      c.kill('SIGTERM'); const code = await exit; await sleep(500);
      check(code === 0 && kids.every((p) => !alive(p)), 'serve: stop signal -> children stopped, exit 0', `code ${code}`);
      check(/SIGTERM received/.test(fs.readFileSync(path.join(dir, 'fake-runner.log'), 'utf8')), 'serve: graceful path logged');
      const child = JSON.parse(fs.readFileSync(path.join(dir, 'child-0.json')));
      check(child.randomOk && child.port > 0, 'serve: child sockets + crypto work', JSON.stringify(child.envKeys));
    } else if (mode === 'orphans') {
      const code = await exit; const kids = JSON.parse(fs.readFileSync(path.join(dir, 'runner.json'))).children;
      check(code === 0 && kids.length === 3 && kids.every(alive), 'orphans: runner exits 0 leaving 3 live children (on Windows the job must reap them)');
      for (const p of kids) { try { process.kill(p, 'SIGTERM'); } catch {} }          // our own children only
    } else if (mode === 'fail') check(await exit === 1, 'fail: exit 1');
    else if (mode === 'alloc') { check(await exit === 0, 'alloc: exit 0'); const a = JSON.parse(fs.readFileSync(path.join(dir, 'child-0.json'))).alloc; check(a?.ok === true && a.gotMiB === 70, 'alloc: report written (10 MiB steps)', JSON.stringify(a)); }
    else if (mode === 'procs') { const code = await exit; const r = JSON.parse(fs.readFileSync(path.join(dir, 'runner.json'))); await sleep(300);
      check(code === 0 && r.children.length === 3 && r.refused.length === 0 && r.children.every((p) => !alive(p)), 'procs: no job here -> all 3 spawn, recorded, stopped, exit 0', JSON.stringify(r.refused)); }
    else if (mode === 'cpu') { check(await exit === 0, 'cpu: exit 0'); check(JSON.parse(fs.readFileSync(path.join(dir, 'child-0.json'))).cpu?.wallMs >= 1000, 'cpu: report written'); }
  }
  // 2. fixture chain + REAL runner + REAL packages
  const work = path.join(tmp, 'world');
  fs.mkdirSync(work);
  const world = spawn(process.execPath, [path.join(DIST, 'fixture-world.mjs'), work, path.join(STAGE, 'packages'), STATIC], { stdio: 'ignore' });
  check(await wait(() => fs.existsSync(path.join(work, 'world.json')), 20000), 'fixture world up');
  const w = JSON.parse(fs.readFileSync(path.join(work, 'world.json'))), cfg = path.join(work, 'host-services.json');
  const runner = spawn(process.execPath, ['--max-old-space-size=128', path.join(STAGE, 'bin/host-services-runner.mjs'), 'run', cfg], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
  const health = () => run([path.join(STAGE, 'bin/stage-tool.mjs'), 'health', '--config', cfg]);
  let h; check(await wait(async () => (h = await health()).code === 0, 90000), 'real runner: stage-1 health all PASS (current policy, 4 roles, static labels)', h?.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | '));
  check(/static platform label/.test(h?.out || '') && /"status":"current"/.test(h?.out || ''), 'real runner: gate current + static labels checked');
  await fetch(`${w.control}/ban`, { method: 'POST' });
  check(await wait(async () => !(await fetch(`http://127.0.0.1:${w.ports.dir}/health`).then(() => true, () => false)), 60000), 'ban: every role stops');
  h = await health(); check(h.code === 2 && /banned by platform policy/.test(h.out) && alive(runner.pid), 'ban: health fails on the gate; runner stays up', `code ${h.code} alive ${alive(runner.pid)} ${h.out.split('\n').filter((l) => /gate|FAIL/.test(l)).join(' | ').slice(0, 600)}`);
  await fetch(`${w.control}/unban`, { method: 'POST' });
  check(await wait(async () => (h = await health()).code === 0, 90000), 'unban: roles restart, health PASS');
  const exit = new Promise((ok) => runner.on('exit', (code) => ok(code))); runner.kill('SIGTERM');
  check(await exit === 0, 'stop: runner exits 0');
  await fetch(`${w.control}/shutdown`, { method: 'POST' }).catch(() => {});
  await new Promise((ok) => world.on('exit', ok));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`harness-local: ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
