// NATIVE WRITER CANARY (7d, node-hold-host-review-20261021/native-writer). ROOT RUNS IT on the Windows node with the node
// binary the network agent uses, through run-canary.ps1 (pins, scratch dir, watchdog, cleanup). Scratch ordinary files
// ONLY: no production config, keys, VMs, tasks, services, accounts or firewall. Never run by 7d remotely.
//   node canary.mjs --candidate <wallet-admission candidate> --original <wallet-admission 7a024c43> --reader <reader.mjs>
//                   --scratch <empty dir> --out <result.json> [--powershell <powershell.exe>] [--simulate]
// --simulate (Linux self-test of THIS harness only): holders are emulated by refusing fs.renameSync; nothing about
// Windows is learned from it.
//
// What it separates:
//   OBSERVED (normal reader): a real separate Node process reading the channel exactly as the privacy agent does, in a
//     tight loop, while the ORIGINAL then the CANDIDATE writer commits as fast as it can. Reported as counts; a normal
//     Node reader opens with FILE_SHARE_DELETE, so 0 replace refusals is the expectation to confirm or refute.
//   HOLDER MAP: a PowerShell [IO.File]::Open holder with share Read / ReadWrite / ReadWrite+Delete, against the ORIGINAL
//     writer: which share modes refuse the replace, and with which error code. Share Read is the POSITIVE fixture (a
//     holder without FILE_SHARE_DELETE, like some scanners or non-Node readers): it must refuse, or the fixture is invalid.
//   RESILIENCE (candidate, share Read holder): released within the budget -> allow, hold and heartbeat each succeed;
//     held past it -> a bounded refusal, the previous document byte-identical, no temp file, deadlines never extended.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const SIM = process.argv.includes('--simulate');
const CAND = path.resolve(arg('--candidate')), ORIG = path.resolve(arg('--original')), READER = path.resolve(arg('--reader'));
const SCRATCH = path.resolve(arg('--scratch')), OUT = path.resolve(arg('--out'));
const PS = arg('--powershell', 'powershell.exe');
const runner = '0x' + '12'.repeat(32), id = '0x' + 'ab'.repeat(32), ref = 'catalog://0x' + 'cd'.repeat(32) + '/1';
const children = new Set();
const result = { at: new Date().toISOString(), node: process.version, platform: process.platform, simulate: SIM, observed: {}, holderMap: {}, checks: {} };
const watchdog = setTimeout(() => { result.checks.watchdog = { pass: false, why: 'canary exceeded 120 s' }; finish(3); }, 120_000);
const check = (name, pass, detail) => { result.checks[name] = { pass: !!pass, ...detail }; };

if (!fs.existsSync(SCRATCH) || fs.readdirSync(SCRATCH).length) throw new Error('--scratch must be an existing EMPTY directory');
const C = await import(pathToFileURL(CAND).href), O = await import(pathToFileURL(ORIG).href);
let n = 0; const fresh = () => { const d = path.join(SCRATCH, `c${++n}`); fs.mkdirSync(d); return path.join(d, 'wallet-admission.json'); };
const tmps = (file) => fs.readdirSync(path.dirname(file)).filter((x) => x.endsWith('.tmp'));
const code = (f) => { try { f(); return null; } catch (e) { return e.code || e.message; } };

// --- simulation hooks (Linux self-test only) ---
let simHold = null; const realRename = fs.renameSync;
if (SIM) fs.renameSync = (a, b) => { if (simHold && b === simHold.file && performance.now() < simHold.until && !/Delete/.test(simHold.share)) throw Object.assign(new Error('EPERM: simulated holder'), { code: 'EPERM' }); return realRename(a, b); };

/** A holder process with [IO.File]::Open(file, Open, Read, <share>) for <ms>; resolves once it HOLDS the file. */
function holder(file, ms, share) {
  if (SIM) { simHold = { file, until: performance.now() + ms, share }; return Promise.resolve({ done: new Promise((r) => setTimeout(r, ms)) }); }
  const q = file.replace(/'/g, "''"), sh = share.replace(/\+/g, ', ');
  const cmd = `$f=[IO.File]::Open('${q}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]'${sh}');[Console]::Out.WriteLine('held');[Console]::Out.Flush();Start-Sleep -Milliseconds ${ms};$f.Close()`;
  const p = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(p); const done = new Promise((r) => p.on('exit', (c) => { children.delete(p); r(c); }));
  return new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error('holder did not open the file within 15 s')), 15_000);
    let out = ''; p.stdout.on('data', (d) => { out += d; if (out.includes('held')) { clearTimeout(t); ok({ done }); } });
    p.on('exit', (c) => { if (!out.includes('held')) { clearTimeout(t); no(new Error(`holder exited ${c} without holding`)); } });
  });
}
function readerRun(mod, file, ms) {
  const p = spawn(process.execPath, [READER, mod, file, runner, String(ms)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(p); let out = '';
  p.stdout.on('data', (d) => { out += d; });
  return new Promise((ok) => p.on('exit', () => { children.delete(p); try { ok(JSON.parse(out.trim())); } catch { ok({ unparsed: out.slice(0, 300) }); } }));
}

try {
  // ---------- OBSERVED: a normal Node reader against each writer ----------
  for (const [label, M] of [['original', O], ['candidate', C]]) {
    const file = fresh(), w = new M.WalletAllowWriter({ file, runner });
    w.allow(id, { appRef: ref, configCid: '', validUntil: Date.now() + 80_000 });
    const r = readerRun(label === 'original' ? ORIG : CAND, file, 6000);
    await new Promise((x) => setTimeout(x, 300));                       // the reader is up and reading
    const end = Date.now() + 5000, errors = {}; let commits = 0, failed = 0, slowest = 0;
    while (Date.now() < end) {
      const t0 = performance.now(), c = code(() => w.heartbeat()), dt = performance.now() - t0;
      slowest = Math.max(slowest, dt);
      if (c) { failed++; errors[c] = (errors[c] || 0) + 1; } else commits++;
    }
    const rd = await r;
    result.observed[`normalReader_${label}`] = { commits, failed, errors, slowestCommitMs: Math.round(slowest), reader: rd, tmpLeft: tmps(file).length };
    check(`normalReader_${label}_reads_whole`, rd && rd.reads > 0 && Object.keys(rd.errors || {}).every((k) => !/invalid|large|equivocation|rollback/i.test(k)),
      { why: 'the normal reader never saw a torn, oversized or rolled-back document' });
  }
  check('normalReader_candidate_no_failure', result.observed.normalReader_candidate.failed === 0, { why: 'with the candidate no commit failed under a normal reader' });

  // ---------- HOLDER MAP (original writer): which share modes refuse the replace ----------
  for (const share of ['Read', 'ReadWrite', 'ReadWrite+Delete']) {
    const file = fresh(), w = new O.WalletAllowWriter({ file, runner });
    const h = await holder(file, 1500, share);
    const c = code(() => w.allow(id, { appRef: ref, configCid: '', validUntil: Date.now() + 60_000 }));
    await h.done; simHold = null;
    result.holderMap[share] = { replaceRefused: !!c, code: c, tmpLeft: tmps(file).length };
  }
  check('positive_fixture_share_Read_refuses', !!result.holderMap.Read.code && ['EPERM', 'EACCES', 'EBUSY'].includes(result.holderMap.Read.code),
    { why: 'a holder without FILE_SHARE_DELETE refuses the original writer with a sharing code (else the fixture is invalid)' });

  // ---------- RESILIENCE (candidate): transient holder released within the budget ----------
  const budget = C.COMMIT_RETRY?.budgetMs;
  check('candidate_declares_budget', Number.isInteger(budget) && budget > 0 && budget <= 1000, { budget });
  for (const op of ['allow', 'hold', 'heartbeat']) {
    const file = fresh(), w = new C.WalletAllowWriter({ file, runner });
    w.allow(id, { appRef: ref, configCid: '', validUntil: Date.now() + 80_000 });
    const V = Date.now() + 60_000;
    const h = await holder(file, 150, 'Read');
    const tStart = Date.now(), t0 = performance.now();
    const c = code(() => op === 'allow' ? w.allow(id, { appRef: ref, configCid: '', validUntil: V }) : op === 'hold' ? w.hold(id) : w.heartbeat());
    const took = Math.round(performance.now() - t0); await h.done; simHold = null;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const deadlineOk = doc.issuedAt <= tStart + 5 && doc.expiresAt === doc.issuedAt + 30_000 && (op !== 'allow' || doc.allows[id]?.validUntil === V) && (op !== 'hold' || !doc.allows[id]);
    check(`transient_${op}`, c === null && deadlineOk && tmps(file).length === 0,
      { code: c, tookMs: took, revision: doc.revision, issuedAtVsStartMs: doc.issuedAt - tStart, why: 'released within the budget: committed, deadlines fixed at the first try, no temp' });
  }
  // ---------- RESILIENCE (candidate): persistent holder ----------
  {
    const file = fresh(), w = new C.WalletAllowWriter({ file, runner });
    const before = fs.readFileSync(file);
    const h = await holder(file, 3000, 'Read');
    const t0 = performance.now();
    const c = code(() => w.allow(id, { appRef: ref, configCid: '', validUntil: Date.now() + 60_000 }));
    const took = Math.round(performance.now() - t0);
    const intact = fs.readFileSync(file).equals(before), left = tmps(file).length;
    await h.done; simHold = null;
    const after = code(() => w.heartbeat());
    check('persistent_bounded_intact', ['EPERM', 'EACCES', 'EBUSY'].includes(c) && took >= budget - 5 && took < budget + 1500 && intact && left === 0 && after === null,
      { code: c, tookMs: took, budget, intact, tmpLeft: left, afterReleaseHeartbeat: after, why: 'refused after the budget, never later; old document byte-identical; no temp; works again once released' });
  }
} catch (e) {
  check('harness', false, { why: String(e.stack || e).slice(0, 600) });
}
finish(0);

function finish(codeOut) {
  clearTimeout(watchdog);
  for (const p of children) { try { p.kill(); } catch {} }
  if (SIM) fs.renameSync = realRename;
  result.pass = Object.values(result.checks).every((c) => c.pass);
  try { fs.writeFileSync(OUT, JSON.stringify(result, null, 1)); } catch {}
  process.stdout.write(JSON.stringify({ pass: result.pass, out: OUT }) + '\n');
  process.exit(codeOut || (result.pass ? 0 : 1));
}
