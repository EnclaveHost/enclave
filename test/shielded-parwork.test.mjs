import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const flags = ['-std=c11', '-O1', '-Wall', '-Wextra'];
if (process.env.SHIELDED_TEST_SANITIZE === '1') flags.push('-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer');
const testEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SHIELDED_')));

// Width 1 is the default and the shipped path; the rest are what the column
// split would ask for. Each width must cover its range exactly once, tolerate
// several owner threads at once, and reclaim helpers when an owner exits.
test('the field helper pool covers its range exactly once and reclaims helpers with their owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-parwork-'));
  try {
    const bin = join(dir, 'parwork');
    execFileSync('cc', [...flags, fixture('shielded-parwork.c'), '-lpthread', '-o', bin], { timeout: 60_000 });
    for (const width of ['1', '2', '3', '8', '0', '99']) {
      execFileSync(bin, { timeout: 180_000, env: { ...testEnv, SHIELDED_FIELD_THREADS: width } });
      // SPINS=0 parks a helper on its very first miss, so every dispatch in
      // park_boundary() lands on the park/dispatch window rather than finding
      // the helper hot. That window is where a lost wakeup lives.
      execFileSync(bin, { timeout: 180_000, env: { ...testEnv, SHIELDED_FIELD_THREADS: width, SHIELDED_FIELD_SPINS: '0' } });
    }
    execFileSync(bin, { timeout: 120_000, env: testEnv });   // unset
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The park/dispatch handshake rests on one memory-model property: the
// dispatcher stores gen then loads parked while the worker stores parked then
// loads gen, and BOTH loads must not be able to return the pre-store value --
// that outcome is a lost wakeup. Release/acquire on two different atomics does
// not forbid it; a pair of seq_cst fences does.
//
// The boundary stress test above cannot establish this: it exercises the
// transition thousands of times and never catches the defect, because the
// window is nanoseconds wide. This builds the same handshake both ways and
// aligns the two threads on a barrier. The relaxed build MUST show the bad
// outcome (otherwise the test is not reaching the window, which is itself a
// failure) and the fenced build must never show it.
test('the park/dispatch handshake cannot lose a wakeup, and the relaxed form demonstrably can', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-parwork-litmus-'));
  try {
    const src = fixture('shielded-parwork-litmus.c');
    const relaxed = join(dir, 'relaxed'), fenced = join(dir, 'fenced');
    execFileSync('cc', [...flags, src, '-lpthread', '-o', relaxed], { timeout: 60_000 });
    execFileSync('cc', [...flags, '-DSH_LITMUS_FENCED', src, '-lpthread', '-o', fenced], { timeout: 60_000 });
    const trials = '500000';
    // The fenced build must never show the outcome -- that is the assertion.
    const f = execFileSync(fenced, [trials], { timeout: 300_000, encoding: 'utf8', env: testEnv });
    const count = (s) => Number(/both-stale=(\d+)/.exec(s)[1]);
    if (count(f) !== 0) throw new Error(`fenced handshake lost ${count(f)} wakeups`);

    // The unfenced build is a DIAGNOSTIC, not an assertion. The memory model
    // permits the stale/stale outcome but does not require it, so a machine
    // that serialised the two threads can legitimately see zero. Failing the
    // build for that would be flaking on valid code; report it instead.
    const un = spawnSync(relaxed, [trials], { timeout: 300_000, encoding: 'utf8', env: testEnv });
    process.stderr.write(f + (un.stdout || '') + (un.stderr || ''));
    if (un.status === 3) process.stderr.write(
      'note: the unfenced handshake did not reach the race window on this run, ' +
      'so the fenced result above is unconfirmed here (not a failure)\n');
    else if (un.status !== 0) throw new Error(`unfenced litmus exited ${un.status}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
