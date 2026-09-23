#!/usr/bin/env python3
"""cpu-window-test.py -- tpu/cpu-window.py against synthetic sampler files whose right answers are known."""
import os, subprocess, sys, tempfile
H = os.path.dirname(os.path.abspath(__file__)); TOOL = os.path.join(H, '..', 'cpu-window.py')
APP = 'host.enclave.anchor.avf'; COMM = {'app': 'lave.anchor.avf', 'vm': 'virtmgr_lave.an', 'vmm': 'crosvm_anchorlo'}
checks = fails = 0
def expect(ok, what):
    global checks, fails; checks += 1
    if not ok: fails += 1; print('FAIL', what)

def stat(pid, comm, ppid, ticks, start):
    f = ['S', str(ppid)] + ['0'] * 9 + [str(ticks), '0'] + ['0'] * 6 + [str(start)]
    return f'{pid} ({comm}) ' + ' '.join(f)

def run(procs_at, times, win, toks=10, hz=100, extra=None):
    """procs_at(t) -> list of (pid, ppid, name, comm, ticks, start) or (pid, ppid, name, 'GONE')"""
    d = tempfile.mkdtemp(); sp = os.path.join(d, 's'); cp = os.path.join(d, 'c')
    with open(sp, 'w') as f:
        for t in times:
            f.write(f'T {t:.2f} 0\n'); f.write(f'cpu  {int(t * 800)} 0 0 {int(t * 400)} 0 0 0 0 0 0\n')
            for p in procs_at(t):
                if p[3] == 'GONE': f.write(f'P {p[0]} {p[1]} {p[2]} | GONE\n')
                else: f.write(f'P {p[0]} {p[1]} {p[2]} | {stat(p[0], p[3], p[1], p[4], p[5])}\n')
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

rc, out = run(lambda t: chain(t) + [(900, 1, 'crosvm_other', 'crosvm_other', int(1000 * t), 100)], T, (5.0, 15.0))
expect('41.50 core-s' in out, 'a crosvm that is NOT a descendant of the app is not counted: ' + out)

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
expect('0.00 core-s' in out, 'a process with the app name but another comm is not the root: ' + out)
print(f"{'PASS' if not fails else 'FAIL'}: {checks} checks, {fails} failures"); sys.exit(1 if fails else 0)
