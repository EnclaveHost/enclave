#!/usr/bin/env python3
"""Negative controls for first_hop_test.py: each mutant of src/first-hop.ps1 (temp copy; the source is never edited) drops ONE
safety step; the suite must then FAIL exactly the scenarios that guard that step."""
import os, pathlib, subprocess, sys, tempfile
HERE = pathlib.Path(__file__).resolve().parent; SRC = (HERE.parent / 'src/first-hop.ps1').read_text()
MUT = {
 'no pre-replace CAS/re-check': ("  if ((Sha $Target) -ne $LiveSha -or -not (Window $t1 120) -or @(UpdaterProcesses).Count -ne 0) {\n    $j.phase = 'aborted-no-change'",
                                  "  if ($false) {\n    $j.phase = 'aborted-no-change'", {'K '}),
 'no restore after a failed apply': ("  $res = Restore-Guarded; $out.restore = $res\n", "  $res = 'RECOVERY_REQUIRED: mutant'; $out.restore = $res\n", {'J ', 'R ', 'S ', 'T ', 'U '}),
 'restore without the fresh task/updater guard': ("    if (-not (Window $t 30) -or @(UpdaterProcesses).Count -ne 0) { return", "    if ($false) { return", {'T '}),
 'missing next run accepted': ("  if ($null -eq $task.secondsToNext) { return $false }\n", "  if ($null -eq $task.secondsToNext) { return $true }\n", {'Q '}),
 'non-Ready states accepted (r2 Window)': ("  if ($task.state -ne 'Ready' -or $task.enabled -ne $true) { return $false }\n", "  if ($task.state -eq 'Running') { return $false }\n", {'V ', 'W ', 'X '}),   # Y stays refused: the [bool] check guards it too
 'no task window gate': ("  $g.taskWindow = Window $f.task $WindowSec\n", "  $g.taskWindow = $true\n", {'D ', 'E ', 'Q ', 'V ', 'W ', 'X ', 'Y ', 'Z '}),
}
bad = 0
for name, (a, b, want) in MUT.items():
    assert SRC.count(a) == 1, name
    d = tempfile.mkdtemp(prefix='fh-mut-'); m = pathlib.Path(d) / 'first-hop.ps1'; m.write_text(SRC.replace(a, b))
    p = subprocess.run([sys.executable, '-B', str(HERE / 'first_hop_test.py')], capture_output=True, text=True, env=dict(os.environ, FH_SCRIPT=str(m)), timeout=600)
    failed = {(l[5:7] if l[6] == ' ' else l[5:8]) for l in p.stdout.splitlines() if l.startswith('FAIL ')}
    ok = p.returncode == 1 and failed == want
    bad += not ok; print('PASS' if ok else 'FAIL', f'mutant "{name}": suite failed {sorted(failed)} (want {sorted(want)})', flush=True)
    m.unlink(); os.rmdir(d)
print({'mutants': len(MUT), 'caught': len(MUT) - bad}); sys.exit(1 if bad else 0)
