"""Mutation check: each mutant weakens ONE guard of common.py; the unchanged python suite must FAIL on it. Copies live BESIDE
this folder (relative paths stay valid), and an UNMUTATED control copy must pass first, else the run is invalid."""
import shutil, subprocess, sys
from pathlib import Path
A = Path(__file__).resolve().parent; SRC = (A/'common.py').read_text()
OTHER = {   # name: (file, from, to) - run against the python suite AND the node tests
 'block-hash-ignored': ('boot-funding.mjs', 'export const CANONICAL_BLOCK = ["number", "hash", "parentHash", "timestamp"];', 'export const CANONICAL_BLOCK = ["number", "parentHash", "timestamp"];'),
 'block-timestamp-ignored': ('boot-funding.mjs', 'export const CANONICAL_BLOCK = ["number", "hash", "parentHash", "timestamp"];', 'export const CANONICAL_BLOCK = ["number", "hash", "parentHash"];'),
 'block-number-unchecked': ('boot-funding.mjs', '  if (BigInt(blocks[0].number) !== n) throw', '  if (false) throw'),
 'block-null-accepted': ('boot-funding.mjs', '  return !!x && !!y && CANONICAL_BLOCK.every(', '  return (!x || !y) || CANONICAL_BLOCK.every('),
 'decision-from-working-tree': ('boot-funding.mjs', '  if (got !== want) throw new Error', '  if (false) throw new Error'),
}
MUT = {
 # the first attempt's (unchanged code)
 'config-before-stop': ("    ops.systemctl('stop', UNIT)\n", "    atomic_config(old_config, config.stat().st_mode & 0o777, config)\n    ops.systemctl('stop', UNIT)\n"),
 'no-deadline-wait': ("    if deadlines:\n        wait", "    if False:\n        wait"),
 'no-concurrent-config-cas': ("    assert config.read_bytes() == new_config, 'config changed concurrently: refuse overwriting it'\n", ""),
 'no-dropin-check': ("    assert ops.read_dropins() == CURRENT['dropins'], 'drop-ins changed concurrently: refuse restarting into an unknown unit'\n", ""),
 'non-additive-admission': ("','.join(existing + [new])", "','.join([new])"),
 'cas-no-restore': ("    e.write_bytes(old); subprocess.run([SYSTEMCTL, 'restart', SERVICE], check=True, timeout=45)\n    print('ADMISSION-RESTORED after failure')", "    print('ADMISSION-RESTORED after failure')"),
 'small-margin-ok': ("<= ROLLBACK_MARGIN_S + ADOPT_S", "<= 0"),
 # this attempt's
 'admission-drops-prior': ("    if prior not in existing: raise", "    if False: raise"),
 'admission-count-ignored': ("    if len(existing) != expected: raise", "    if False: raise"),
 'build-any-approval': ("    if approved_text != APPROVED_COMMIT_TEXT: out.append", "    if False: out.append"),
 'build-marker-at-least-once': ("        if lines.count(w) != 1: out.append", "        if lines.count(w) < 1: out.append"),
 'build-a6-image-ok': ("        if inv[f] == h: out.append", "        if False: out.append"),
 'build-kernel-may-change': ("        if inv[f] != h: out.append(f'{f} changed", "        if False: out.append(f'{f} changed"),
 'build-measurement-file-unchecked': ("    if m is not None and measurement_text != m + '\\n': out.append", "    if False: out.append"),
 'source-bytes-unchecked': ("        if sha(git('show', rev['commit'] + ':supervisor.js')) != rev['supervisorSha256']: out.append", "        if False: out.append"),
 'approval-unchecked': ("    if appr != f'build-sha256 {sha(raw)}\\n': raise", "    if False: raise"),
 'plan-unchecked': ("    if plan.get('buildSha256') != h or plan.get('measurement') != rec['measurement'] or plan.get('files') != rec['files']:\n        raise", "    if False:\n        raise"),
 'guestd-replacement-adopted': ("        if str(r.get('id')) != want['guest']: out.append", "        if False: out.append"),
 'guestd-starting-ok': ("        if r.get('status') != 'running': out.append", "        if False: out.append"),
 'guestd-no-record-ok': ("        if not re.fullmatch(r'[0-9a-f]{64}', str(r.get('recordSha256') or '')): out.append", "        if False: out.append"),
 'guestd-history-ignored': ("        if hist != want['history']: out.append", "        if False: out.append"),
 'guestd-two-live-ok': ("        if len(live) != 1: out.append", "        if not live: out.append"),
 'guestd-stale-listing-ok': ("    if now - st.st_mtime > max_age or", "    if False or"),
 'guestd-public-listing-ok': ("    if st.st_mode & 0o077: raise", "    if False: raise"),
 'availability-pretends-adopted': ("    if held is None: return 'absent: the old control is not registered and adopted nothing', []", "    if held is None: return 'present and agrees with guestd', []"),
 'funding-register-accepted': ("        if f['action'] != {'action': 'setProofKey', 'reason': 'only the proof key differs'}: out.append", "        if f['action'].get('action') not in ('setProofKey', 'register', 'adopt'): out.append"),
 'funding-fields-ignored': ("            out.append('the registered fields are not exactly", "            pass  # out.append('the registered fields are not exactly"),
 'funding-pending-ignored': ("or [int(x) for x in o['pending']] != [n, n]: out.append", ": out.append"),
 'funding-no-headroom': ("'maxAgeS': 360, 'headroomPct': 125,", "'maxAgeS': 360, 'headroomPct': 100,"),
 'funding-delegation-ignored': ("        if lc(f['operator']['code']) != P['operatorCode']: out.append", "        if False: out.append"),
 'funding-stale-ok': ("        if age >= P['maxAgeS'] or age < -30: out.append", "        if False: out.append"),
 'funding-min-gas': ("        if gas != max(int(x) for x in sp['gasEstimates'])", "        if gas != min(int(x) for x in sp['gasEstimates'])"),
 'keep-any-measurement': ("or v.get('expectedMeasurement') != want or v.get('observedMeasurement') != want or", "or"),
 'keep-failed-verdict-ok': ("    if v.get('pass') is not True: out.append('pass is not true')\n    if v.get('status') != 'verified' or v.get('admissionSafe') is not True: out.append", "    if False: out.append"),
 'keep-raw-unchecked': ("        if file_sha(raw) != v.get('rawSha256'): out.append", "        if False: out.append"),
 'keep-before-attach-ok': ("        if not attached_at or at <= datetime.datetime.fromisoformat(attached_at).timestamp(): out.append", "        if False: out.append"),
}
def run(name, src, file='common.py'):
    d = A.parent / f'{A.name}.mut-{name}'
    if d.exists(): shutil.rmtree(d)
    # never root's runtime files: evidence/ carries only the pinned original baseline into the copy
    shutil.copytree(A, d, ignore=shutil.ignore_patterns('.git', 'logs', '__pycache__', '*.mut-*', '*private*', 'boot-funding*.json', 'guestd-baseline*.json',
                                                         'lease-preflight*.json', 'ROOT-*', 'result.json', 'private-backup'))
    (d/file).write_text(src)
    r = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests'], cwd=d, capture_output=True, text=True, timeout=600)
    if r.returncode == 0:
        r = subprocess.run(['node', '--test', 'tests/boot-funding.test.mjs'], cwd=d, capture_output=True, text=True, timeout=600)
    shutil.rmtree(d); return r
c = run('control', SRC)
if c.returncode != 0: print('CONTROL FAILED: the run is invalid\n' + c.stderr[-2000:]); sys.exit(2)
print('control (unmutated copy) passes')
bad = 0
for name, (a, b) in MUT.items():
    assert SRC.count(a) == 1, (name, a[:70])
    r = run(name, SRC.replace(a, b)); killed = r.returncode != 0; bad += not killed
    print(('KILLED  ' if killed else 'SURVIVED'), name)
for name, (f, a, b) in OTHER.items():
    s = (A/f).read_text(); assert s.count(a) == 1, (name, a[:70])
    r = run(name, s.replace(a, b), f); killed = r.returncode != 0; bad += not killed
    print(('KILLED  ' if killed else 'SURVIVED'), name)
print(f'mutants {len(MUT) + len(OTHER)} survived {bad}'); sys.exit(1 if bad else 0)
