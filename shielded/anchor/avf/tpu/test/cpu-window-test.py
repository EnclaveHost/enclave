#!/usr/bin/env python3
"""cpu-window-test.py -- tpu/cpu-window.py against synthetic sampler files whose right answers are known."""
import os, subprocess, sys, tempfile
H = os.path.dirname(os.path.abspath(__file__)); TOOL = os.path.join(H, '..', 'cpu-window.py')
APP = 'host.enclave.anchor.avf'; COMM = {'app': 'lave.anchor.avf', 'vm': 'virtmgr_lave.an', 'vmm': 'crosvm_anchorlo'}
checks = fails = 0
def expect(ok, what):
    global checks, fails; checks += 1
    if not ok: fails += 1; print('FAIL', what)

def stat(pid, comm, ppid, ticks, start, reaped=0):
    f = ['S', str(ppid)] + ['0'] * 9 + [str(ticks), '0', str(reaped)] + ['0'] * 5 + [str(start)]
    return f'{pid} ({comm}) ' + ' '.join(f)

def run(procs_at, times, win, toks=10, hz=100, ps_line=lambda t: 'PS ok 400'):
    """procs_at(t) -> list of (pid, ppid, name, comm, ticks, start) or (pid, ppid, name, 'GONE')"""
    d = tempfile.mkdtemp(); sp = os.path.join(d, 's'); cp = os.path.join(d, 'c')
    with open(sp, 'w') as f:
        for t in times:
            # user 400/s (of which guest 300/s, which the kernel ALSO lists in the guest column), idle 400/s: 4 of 8 cores busy
            f.write(f'T {t:.2f} 0\n'); f.write(f'cpu  {int(t * 400)} 0 0 {int(t * 400)} 0 0 0 0 {int(t * 300)} 0\n')
            for p in procs_at(t):
                if p[3] == 'GONE': f.write(f'P {p[0]} {p[1]} {p[2]} | GONE\n')
                else: f.write(f'P {p[0]} {p[1]} {p[2]} | {stat(p[0], p[3], p[1], p[4], p[5], p[6] if len(p) > 6 else 0)}\n')
            if ps_line(t): f.write(ps_line(t) + '\n')
        f.write('END\n')
    a, b = win
    with open(cp, 'w') as f:
        f.write(f'LOCAL turn 1 window boottime_ms start={int(a * 1000) - 500} first={int(a * 1000)} end={int(b * 1000)}\n')
        f.write('LOCAL turn 1 STATS {status=eos, prefill_tokens=5, decode_tokens=%d, decode_tok_s=1.0}\n' % toks)
    r = subprocess.run([sys.executable, TOOL, sp, cp, '--hz', str(hz)], capture_output=True, text=True)
    return r.returncode, r.stdout

def chain(t, app_rate=10, vmm_rate=400, vmm_until=None):
    """the app at pid 100, its virtmgr 200, its crosvm 300 (started at boot+1 s); ticks grow at the given per-second rates"""
    ps = [(100, 1, APP, COMM['app'], int(app_rate * t), 100), (200, 100, 'virtmgr_lave.anchor.avf', COMM['vm'], int(5 * t), 100)]
    if vmm_until is None or t <= vmm_until: ps.append((300, 200, 'crosvm_anchorlocal', COMM['vmm'], int(vmm_rate * (t - 1)), 100))
    return ps

T = [1 + 0.25 * i for i in range(81)]                                        # 1.00 .. 21.00 s, every 0.25 s
rc, out = run(lambda t: chain(t), T, (5.0, 15.0))
# 10 s window: app 10 ticks/s, virtmgr 5, crosvm 400 -> 415 ticks/s = 4.15 core-s/s -> 41.5 core-s, 4150 ms/token over 10
expect(rc == 0 and 'COMPLETE' in out and 'INCOMPLETE' not in out, 'a steady run is COMPLETE: ' + out)
expect('41.50 core-s' in out and '4.15 cores busy' in out and '4150 core-ms per decoded token' in out, 'the whole chain, the VM included: ' + out)
expect('crosvm_anchorlocal 40.00' in out, 'the VM process is counted under its real name: ' + out)

expect('4.00 cores busy device-wide' in out, 'device-wide busy does not count guest time twice: ' + out)
rc, out = run(lambda t: chain(t) + [(900, 1, 'crosvm_other', 'crosvm_other', int(1000 * t), 100)], T, (5.0, 15.0))
expect('41.50 core-s' in out, 'a crosvm that is NOT a descendant of the app is not counted: ' + out)
expect(rc == 1 and 'ownership unresolved' in out, '... and a VM-type process of the uid outside the tree makes it INCOMPLETE: ' + out)

rc, out = run(lambda t: chain(t, vmm_until=10.0), T, (5.0, 15.0))
expect(rc == 1 and 'INCOMPLETE' in out and 'exited inside the window' in out, 'a VM that exits mid-window is kept and flagged: ' + out)
expect('crosvm_anchorlocal 20.00' in out, 'its CPU up to its last sample is kept, not dropped: ' + out)

def reuse(t):
    ps = chain(t)
    if t >= 10: ps = [p for p in ps if p[0] != 300] + [(300, 1, 'crosvm_anchorlocal', COMM['vmm'], int(50 * t), 1000)]
    return ps
rc, out = run(reuse, T, (5.0, 15.0))
expect('crosvm_anchorlocal 19.00' in out and 'exited inside the window' in out, 'a reused pid (new start time, foreign parent) is another process: ' + out)

rc, out = run(lambda t: chain(t) + ([(300, 200, 'crosvm_anchorlocal', 'GONE')] if abs(t - 8.0) < 0.01 else []), T, (5.0, 15.0))
expect(rc == 1 and 'stat read failed' in out, 'a failed read of an owned process makes it INCOMPLETE: ' + out)

rc, out = run(lambda t: chain(t), [t for t in T if not (9.0 < t < 15.5)], (5.0, 15.0))
expect(rc == 1 and 'apart' in out, 'a sampling gap at the window edge makes it INCOMPLETE: ' + out)

rc, out = run(lambda t: chain(t), [t for t in T if t >= 6.0], (5.0, 15.0))
expect(rc == 1 and 'UNMEASURED' in out, 'a window that starts before the first sample is UNMEASURED: ' + out)

rc, out = run(lambda t: [p for p in chain(t) if p[0] != 300 or t >= 9.0], T, (5.0, 15.0))
expect(rc == 1 and 'running before its first sample' in out, 'a process first sampled mid-window but started before it is flagged: ' + out)

def late(t):   # the VM genuinely starts at 9 s (start time 900 ticks), inside the window: all of its CPU is inside
    ps = chain(t)[:2]
    if t >= 9.25: ps.append((300, 200, 'crosvm_anchorlocal', COMM['vmm'], int(400 * (t - 9)), 900))
    return ps
rc, out = run(late, T, (5.0, 15.0))
expect(rc == 0 and 'crosvm_anchorlocal 24.00' in out, 'a process that starts inside the window counts from zero, COMPLETE: ' + out)

rc, out = run(lambda t: [(100, 1, APP, 'imposter', 10 * int(t), 100)] + chain(t)[1:], T, (5.0, 15.0))
expect(rc == 1 and 'UNMEASURED' in out, 'a process with the app name but another comm is not the root, so nothing is owned: ' + out)

# the audit's repro: samples with valid device lines but no process of the app at all -> never "COMPLETE, 0 core-s"
rc, out = run(lambda t: [], [0.0, 1.0, 2.0, 3.0], (1.0, 2.0))
expect(rc == 1 and 'UNMEASURED' in out and 'COMPLETE:' not in out, 'no process observed is UNMEASURED, not zero CPU: ' + out)
rc, out = run(lambda t: chain(t), T, (5.0, 15.0), ps_line=lambda t: 'PS FAILED 1' if abs(t - 9.0) < 0.01 else 'PS ok 400')
expect(rc == 1 and 'INCOMPLETE' in out and 'PS FAILED' in out, 'a failed process-table read inside the window: INCOMPLETE: ' + out)
rc, out = run(lambda t: chain(t), T, (5.0, 15.0), ps_line=lambda t: None if abs(t - 12.0) < 0.01 else 'PS ok 400')
expect(rc == 1 and 'no PS line' in out, 'a sample without its process-table marker: INCOMPLETE: ' + out)
rc, out = run(lambda t: chain(t), T, (5.0, 15.0), ps_line=lambda t: 'PS ok 0')
expect(rc == 1 and 'INCOMPLETE' in out, 'an EMPTY process table is not a successful read: ' + out)
rc, out = run(lambda t: chain(t)[:2], T, (5.0, 15.0))
expect(rc == 1 and 'no VM process' in out, 'the app seen but its VM never seen: INCOMPLETE: ' + out)
# sampler v2: fast KNOWN samples between full scans every 2 s -> COMPLETE; scans 5 s apart -> INCOMPLETE
full_every = lambda period: (lambda t: 'PS ok 400' if abs((t - 1) / period - round((t - 1) / period)) < 1e-6 else 'PS known 3')
rc, out = run(lambda t: chain(t), T, (5.0, 15.0), ps_line=full_every(2.0))
expect(rc == 0 and '41.50 core-s' in out, 'known-pid samples between 2 s scans: COMPLETE: ' + out)
rc, out = run(lambda t: chain(t), T, (5.0, 15.0), ps_line=full_every(5.0))
expect(rc == 1 and 'scans were up to' in out, 'full scans 5 s apart through the window: INCOMPLETE: ' + out)
def reaping(t):   # virtmgr reaps a short-lived child mid-window: its cutime grows by 2.00 core-s
    ps = chain(t); v = list(ps[1]); v.append(200 if t >= 10 else 0); ps[1] = tuple(v); return ps
rc, out = run(reaping, T, (5.0, 15.0))
expect(rc == 1 and 'reaped children using 2.00 core-s' in out, 'a child that lived between scans is detected via cutime: ' + out)

# sampler v3: timing samples carry only "PS known", discovery is separate "D" lines every 2 s
def with_scans(every, fail_at=None):
    def gen(procs_at, times, win, **kw):
        rc, out = run(procs_at, times, win, ps_line=lambda t: 'PS known 3', **kw)
        return rc, out
    return gen
def run_d(procs_at, times, win, scans):
    d = tempfile.mkdtemp(); sp = os.path.join(d, 's'); cp = os.path.join(d, 'c')
    with open(sp, 'w') as f:
        for t in times:
            f.write(f'T {t:.2f} 0\n'); f.write(f'cpu  {int(t * 400)} 0 0 {int(t * 400)} 0 0 0 0 {int(t * 300)} 0\n')
            for p in procs_at(t): f.write(f'P {p[0]} {p[1]} {p[2]} | {stat(p[0], p[3], p[1], p[4], p[5])}\n')
            f.write('PS known 3\n')
        for line in scans: f.write(line + '\n')
        f.write('END\n')
    a, b = win
    with open(cp, 'w') as f:
        f.write(f'LOCAL turn 1 window boottime_ms start={int(a * 1000) - 500} first={int(a * 1000)} end={int(b * 1000)}\n')
        f.write('LOCAL turn 1 STATS {status=eos, prefill_tokens=5, decode_tokens=10, decode_tok_s=1.0}\n')
    r = subprocess.run([sys.executable, TOOL, sp, cp], capture_output=True, text=True); return r.returncode, r.stdout
good = [f'D {t:.2f} {t + 1.3:.2f} ok 800' for t in range(1, 22, 2)]
rc, out = run_d(lambda t: chain(t), T, (5.0, 15.0), good)
expect(rc == 0 and '41.50 core-s' in out, 'timing samples + discovery scans every 2 s (each 1.3 s long): COMPLETE: ' + out)
rc, out = run_d(lambda t: chain(t), T, (5.0, 15.0), [x for x in good if not x.startswith(('D 7.', 'D 9.', 'D 11.'))])
expect(rc == 1 and 'scans were up to' in out, 'discovery scans 8 s apart: INCOMPLETE: ' + out)
rc, out = run_d(lambda t: chain(t), T, (5.0, 15.0), good + ['D 10.00 10.50 FAILED 1'])
expect(rc == 1 and 'discovery scan(s) around the window failed' in out, 'a failed discovery scan: INCOMPLETE: ' + out)

# the SAMPLER itself, run on this host with a fake ps: a failed enumeration is written as PS FAILED, never as an empty sample
import time
SAMPLER = os.path.join(H, '..', 'cpu-sampler.sh')
def sampler(ps_body):
    d = tempfile.mkdtemp(); b = os.path.join(d, 'bin'); os.mkdir(b)
    with open(os.path.join(b, 'ps'), 'w') as f: f.write('#!/bin/sh\n' + ps_body)
    os.chmod(os.path.join(b, 'ps'), 0o755); out = os.path.join(d, 'o'); open(out + '.run', 'w').close()
    p = subprocess.Popen(['sh', SAMPLER, str(os.getuid()), out, '0.05'], env=dict(os.environ, PATH=b + ':' + os.environ['PATH']))
    time.sleep(0.4); os.unlink(out + '.run'); p.wait(timeout=10)
    return open(out).read()
o = sampler('exit 3\n')
expect(' FAILED 3' in o and ' ok ' not in o and o.rstrip().endswith('END'), 'the sampler records a failed ps as a FAILED scan: ' + o[-200:])
o = sampler(f'echo "  PID  PPID   UID NAME"; echo "  {os.getpid()}  1  {os.getuid()} me"; echo "  1 0 0 init"\n')
expect(f'P {os.getpid()} 1 me | {os.getpid()} (' in o and ' ok 3' in o, 'a good table: the uid row with its stat, and a D scan line with the row count: ' + o[-300:])
expect('PS known 1' in o and 'PS ok' not in o and o.count(' ok 3') >= 2, 'timing samples read the discovered pid (PS known 1); scans are D lines, at least one per loop and one at stop: ' + o[-300:])
print(f"{'PASS' if not fails else 'FAIL'}: {checks} checks, {fails} failures"); sys.exit(1 if fails else 0)
