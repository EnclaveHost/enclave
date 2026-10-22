#!/usr/bin/env python3
"""LOCAL fixture tests of native-test.ps1 (Linux pwsh 7.4 with -LocalSmoke; NOT Windows / NOT PS 5.1 evidence).
Each case builds its own temp stage with the exact staged layout (a shim 'powershell.exe' on PATH execs pwsh), runs the fixture,
checks the exit code/JSON, verifies no fixture process survives, removes the stage and verifies it is gone.
Negative cases edit ONLY the temp stage copy of native-test.ps1 (never the package) to prove failures propagate."""
import json, os, pathlib, shutil, subprocess, sys, tempfile, time

N = pathlib.Path(__file__).resolve().parent.parent
PWSH = '/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh'
LAYOUT = ['install-host.r5.ps1', 'update-host.r5.ps1', 'install-host.r4.ps1', 'update-host.r4.ps1', 'fakebundle/install-host.ps1', 'native-test.ps1']
results = []

def stage(edit=None, tamper=None):
    t = pathlib.Path(tempfile.mkdtemp(prefix='installer-r5-native-'))
    s = t / 'stage'; (s / 'fakebundle').mkdir(parents=True); shim = t / 'bin'; shim.mkdir()
    for f in LAYOUT: shutil.copy2(N / f, s / f)
    (shim / 'powershell.exe').write_text(f'#!/bin/sh\nexec "{PWSH}" "$@"\n'); (shim / 'powershell.exe').chmod(0o755)
    if edit:
        txt = (s / 'native-test.ps1').read_text(); old, new = edit; assert txt.count(old) == 1, old; (s / 'native-test.ps1').write_text(txt.replace(old, new))
    if tamper: p = s / tamper; p.write_bytes(p.read_bytes() + b' ')
    return t, s

def run(name, want_exit, edit=None, tamper=None, check=None, timeout=420):
    t, s = stage(edit, tamper)
    env = dict(os.environ, PATH=f"{t / 'bin'}:{os.environ['PATH']}")
    p = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(s / 'native-test.ps1'), '-Stage', str(s), '-LocalSmoke'],
                       capture_output=True, text=True, env=env, timeout=timeout)
    try: j = json.loads([l for l in p.stdout.splitlines() if l.strip()][-1])
    except Exception: j = {'unparsed': p.stdout[-800:], 'stderr': p.stderr[-800:]}
    time.sleep(4)   # the stand-in sleeps 3 s; it must be gone too
    left = subprocess.run(['pgrep', '-f', str(s)], capture_output=True, text=True).stdout.split()
    outside = [x for x in t.iterdir() if x.name not in ('stage', 'bin')]
    shutil.rmtree(t); gone = not t.exists()
    ok = p.returncode == want_exit and not left and gone and not outside
    why = '' if ok else f'exit {p.returncode} (want {want_exit}) left={left} gone={gone} outside={outside}'
    if ok and check:
        try: check(j)
        except AssertionError as e: ok, why = False, str(e)
    results.append((name, ok)); print(('PASS ' if ok else 'FAIL ') + name, why, flush=True)
    if not ok: print(json.dumps(j)[:3000])
    return j

def positive(j):
    st = {c['check']: c['result'] for c in j['checks']}
    assert j['pass'] is True and j['failed'] == [], j['failed']
    skipped = [k for k, v in st.items() if v.startswith('SKIPPED')]
    assert len(skipped) == 4 and all(k.split(':')[0] in ('install.r4 CONTROL', 'pending.r5', 'wrapper.r5', 'wrapper.r4 CONTROL') for k in skipped), skipped
    assert sum(v == 'PASS' for v in st.values()) == 11, st
    assert all(c['evidence'] in ('native-interpreter', 'mocked-task-semantics') for c in j['checks'])
    assert j['children']['install.r5']['result']['code'] == 7 and j['children']['install.r5']['result']['childCompleted'] is True
    assert j['children']['pending.r4']['result']['events'].count('start Relay') == 0
def failed_names(*subs):
    def c(j):
        assert j['pass'] is False and all(any(s in f for f in j['failed']) for s in subs), j.get('failed')
    return c
def child_error(key, sub):
    def c(j):
        ch = j['children'][key]; assert ch['exit'] == 3 and sub in json.dumps(ch.get('result')), ch
        assert any('children:' in f for f in j['failed']), j['failed']
    return c

run('positive local smoke: 11 PASS, 4 Windows-only SKIPPED', 0, check=positive)
run('tampered pinned byte refuses before any part (exit 3)', 3, tamper='update-host.r5.ps1', check=lambda j: j['pins']['update-host.r5.ps1'] is False or (_ for _ in ()).throw(AssertionError(j)))
run('wrong expected exit code propagates as a FAILED check (exit 1)', 1, edit=('$EXPECT_CODE = 7', '$EXPECT_CODE = 8'), check=failed_names('install.r5: exact Install returns'))
run('real mutator in a part hits the TRIPWIRE and fails the run', 1,
    edit=("    $script:LogLines = New-Object Collections.Generic.List[string]\n", "    Stop-ScheduledTask -TaskName 'RealTask'\n    $script:LogLines = New-Object Collections.Generic.List[string]\n"),
    check=child_error('install.r5', 'TRIPWIRE: Stop-ScheduledTask'))
run('write outside the stage hits the TRIPWIRE', 1,
    edit=("    WriteFx (Join-Path $FX 'dep.ps1')", "    WriteFx '/tmp/installer-r5-native-OUTSIDE.txt' 'x'\n    WriteFx (Join-Path $FX 'dep.ps1')"),
    check=child_error('wrapper.r5', 'TRIPWIRE: write outside the stage'))
run('a child overrunning its bound is killed and fails the run', 1, edit=('$CHILD_MS = 90000', '$CHILD_MS = 1500'),
    check=lambda j: (j['children']['install.r5']['timedOut'] is True and any('children:' in f for f in j['failed'])) or (_ for _ in ()).throw(AssertionError(j['children']['install.r5'])))
assert not pathlib.Path('/tmp/installer-r5-native-OUTSIDE.txt').exists(), 'outside write happened'
print(json.dumps({'pass': sum(ok for _, ok in results), 'fail': sum(not ok for _, ok in results)}))
sys.exit(0 if all(ok for _, ok in results) else 1)
