"""Mutation check of common.py's safety logic: each mutant weakens one guard; the unchanged test suite must FAIL on it."""
import shutil, subprocess, sys, tempfile
from pathlib import Path
A = Path(__file__).resolve().parent; SRC = (A/'common.py').read_text()
MUT = {
 'config-before-stop': [("    ops.systemctl('stop', UNIT)\n", "    atomic_config(old_config, config.stat().st_mode & 0o777, config)\n    ops.systemctl('stop', UNIT)\n")],
 'no-deadline-wait': [("    if deadlines:\n        wait", "    if False:\n        wait")],
 'no-concurrent-config-cas': [("    assert config.read_bytes() == new_config, 'config changed concurrently: refuse overwriting it'\n", "")],
 'no-dropin-check': [("    assert ops.read_dropins() == CURRENT['dropins'], 'drop-ins changed concurrently: refuse restarting into an unknown unit'\n", "")],
 'non-additive-admission': [("','.join(existing + [new])", "','.join([new])")],
 'admission-ignores-public': [("    if set(existing) != set(public_list) or len(public_list) != len(set(public_list)): raise AssertionError('the installed list is not the public allowlist')\n", "")],
 'reserialize-config': [("    new = text.replace(needle, json.dumps(new_dist), 1).encode('utf-8')", "    new = (json.dumps({**json.loads(raw), 'dist': new_dist}, indent=2) + '\\n').encode()")],
 'ignore-workingdir': [("    if unit.get('WorkingDirectory') != current['workingDirectory']:", "    if False:")],
 'ignore-dropins': [("    if dropins != current['dropins']:", "    if False:")],
 'cas-no-restore': [("    e.write_bytes(old); subprocess.run([SYSTEMCTL, 'restart', SERVICE], check=True, timeout=45)\n    print('ADMISSION-RESTORED after failure')", "    print('ADMISSION-RESTORED after failure')")],
 'small-margin-ok': [("<= ROLLBACK_MARGIN_S + ADOPT_S", "<= 0")],
}
bad = 0
for name, subs in MUT.items():
    s = SRC
    for a, b in subs: assert a in s, (name, a[:60]); s = s.replace(a, b)
    d = Path(tempfile.mkdtemp()); shutil.copytree(A/'tests', d/'tests'); shutil.copytree(A/'evidence', d/'evidence'); (d/'common.py').write_text(s)
    r = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests'], cwd=d, capture_output=True, text=True)
    killed = r.returncode != 0; bad += not killed
    print(('KILLED  ' if killed else 'SURVIVED'), name); shutil.rmtree(d)
print(f'mutants {len(MUT)} survived {bad}'); sys.exit(1 if bad else 0)
