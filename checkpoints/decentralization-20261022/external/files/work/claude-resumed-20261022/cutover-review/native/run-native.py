#!/usr/bin/env python3
"""ROOT-ONLY native validation of the frozen cutover-review candidate 943a5f01 on minipc (prepared by Claude; never run by it).

DEFAULT = PLAN ONLY: verifies the local pinned bytes and the pinned transport, prints the exact plan (files, stage pattern,
every PowerShell text and its encoded size) and makes NO network call.
EXECUTE requires BOTH --execute AND --root-reviewed <manifestSha> (printed by the plan): root reviews these sources, then
passes the manifest digest it reviewed. One attempt per directory: native-attempt.json is created with O_EXCL BEFORE the first
remote call and is never overwritten; delete nothing to "retry" - root decides.
Remote effects: ONLY this run's own unique staging directory C:\\ProgramData\\Enclave\\staging\\cutover-review-native-<12 hex>
(created, filled with the 5 pinned files, removed and verified gone). native-test.ps1 is read-only on every live entity.
Transport: work/nucbox-tls-20261021/root-activate-reviewed.py c50aac8e (ssh minipc, encoded command, watchdog), as the
predecessor node-bounded-queries-20261022/native/run-native.py."""
import argparse, base64, datetime, hashlib, importlib.util, json, subprocess, sys, uuid
from pathlib import Path

P = Path(__file__).resolve().parent
WORK = P.parents[2]                                   # native -> cutover-review -> claude-resumed-20261022 -> work
TRANSPORT = WORK / 'nucbox-tls-20261021/root-activate-reviewed.py'
TRANSPORT_SHA = 'c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
FILES = {   # exact uploaded bytes (also re-checked on minipc before anything runs)
    'cutover.ps1': '943a5f0173a291c8ed2a3d160552dd5ab8633069cc331ba9c39b6806460e2093',
    'native-test.ps1': 'a7f288d799345168cd5191926f83bb2bb7aa8354b98f2f9bf9d1b89fc1f9763d',
    'sim-guard.ps1': 'f98cfbaf7802e2f6fb5be001748c2fecd5c82a17096c668e348364f8a0770973',
    'native-path-test.ps1': 'acf28de25471dc912538bbcce546a1c32aece89d4f7ccd32af6c927e220f56a6',
    'readiness-cadence-test.ps1': 'e150efa594100bd6ce9cfe4fa8a23a1c4b397c7d9420d0f905a549fa1d107054',
}
STAGE_ROOT = r'C:\ProgramData\Enclave\staging'
PREFIX = 'cutover-review-native-'
FIXTURE_SEC = 870                                     # native-test.ps1's own bound ($FIXTURE_SEC)
VALIDATE_SECS = FIXTURE_SEC + 60                      # transport watchdog for the validation call
ATTEMPT, RESULT = 'native-attempt.json', 'native-result.json'
ENCODED_LIMIT = 7900                                  # the transport refuses longer encoded commands

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def q(s): return "'" + s.replace("'", "''") + "'"

def manifest():
    return {'transportSha': TRANSPORT_SHA, 'files': FILES, 'stagePrefix': STAGE_ROOT + '\\' + PREFIX,
            'fixtureSec': FIXTURE_SEC, 'validateSecs': VALIDATE_SECS}
def manifest_sha(): return hashlib.sha256(json.dumps(manifest(), sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def check_local(d=P):
    bad = {f: (sha(d / f) if (d / f).exists() else 'absent') for f in FILES if not (d / f).exists() or sha(d / f) != FILES[f]}
    if not TRANSPORT.exists() or sha(TRANSPORT) != TRANSPORT_SHA: bad['transport'] = 'absent or not c50aac8e'
    return bad

def new_stage(): return STAGE_ROOT + '\\' + PREFIX + uuid.uuid4().hex[:12]

def texts(stage):
    assert stage.startswith(STAGE_ROOT + '\\' + PREFIX) and "'" not in stage
    checks = ';'.join(f"if((FileSha ($s+'\\{f}')) -ne '{h}'){{throw 'pin mismatch: {f}'}}" for f, h in FILES.items())
    return {
        'create': f"$s={q(stage)};if(Test-Path -LiteralPath $s){{throw 'stage exists'}};$null=New-Item -ItemType Directory -Path $s;"
                  "@{created=$s}|ConvertTo-Json -Compress",
        'validate': f"$s={q(stage)};if(@(Get-ChildItem -LiteralPath $s -Force).Count -ne {len(FILES)}){{throw 'stage file count differs'}};{checks};"
                    "& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ($s+'\\native-test.ps1') -Stage $s;"
                    "if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}",
        # unique to this run: also attempted when creation was unconfirmed (the create text refuses an existing path)
        'cleanup': f"$s={q(stage)};if(-not $s.StartsWith({q(STAGE_ROOT + chr(92) + PREFIX)})){{throw 'not a cutover-review-native stage'}};"
                   "if(Test-Path -LiteralPath $s){Remove-Item -LiteralPath $s -Recurse -Force};@{gone=(-not(Test-Path -LiteralPath $s))}|ConvertTo-Json -Compress",
    }

def load_transport():
    if sha(TRANSPORT) != TRANSPORT_SHA: raise SystemExit('transport is not the pinned c50aac8e')
    spec = importlib.util.spec_from_file_location('transport', TRANSPORT); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m

def encoded_sizes(m, t):
    return {k: len(base64.b64encode((m.HEAD.replace('SECS', '900') + v).encode('utf-16-le'))) for k, v in t.items()}

def scp_real(local, remote):
    subprocess.run(['timeout', '40', 'scp', '-q', '-o', 'BatchMode=yes', str(local), remote], check=True, capture_output=True)

def execute(m, scp, d=P, stage=None):
    stage = stage or new_stage(); t = texts(stage)
    r = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'stage': stage, 'files': FILES,
         'manifestSha': manifest_sha(), 'transportSha': TRANSPORT_SHA}
    with (d / ATTEMPT).open('x') as f: json.dump(r, f, indent=2)          # O_EXCL BEFORE any remote call
    attempted = False
    try:
        attempted = True
        r['created'] = m.ps(t['create'], 40)
        if not (isinstance(r['created'], dict) and r['created'].get('created') == stage): raise RuntimeError('stage creation unconfirmed')
        for f in FILES: scp(d / f, 'minipc:/' + stage.replace('\\', '/') + '/' + f)
        r['validation'] = m.ps(t['validate'], VALIDATE_SECS)
    except Exception as e: r['error'] = str(e)
    finally:
        if attempted: r['cleanup'] = m.ps(t['cleanup'], 40)
        (d / RESULT).write_text(json.dumps(r, indent=2) + '\n')
    v = r.get('validation') if isinstance(r.get('validation'), dict) else {}
    ok = v.get('pass') is True and isinstance(r.get('cleanup'), dict) and r['cleanup'].get('gone') is True
    return r, ok

def plan(bad):
    m = load_transport() if 'transport' not in bad else None
    t = texts(STAGE_ROOT + '\\' + PREFIX + '<12hex>'.replace('<12hex>', '0' * 12))
    return {'mode': 'PLAN ONLY (no network call made)', 'manifestSha': manifest_sha(), 'manifest': manifest(), 'localMismatches': bad,
            'stagePattern': STAGE_ROOT + '\\' + PREFIX + '<uuid4 hex 12>', 'steps': ['O_EXCL ' + ATTEMPT, 'create stage (refuse existing)',
            'scp 5 pinned files', 'validate: exact file count + 5 FileSha pins, then native-test.ps1 (bound %d s)' % FIXTURE_SEC,
            'cleanup own stage (always after a create attempt) + verify gone', 'write ' + RESULT],
            'texts': t, 'encodedSizes': encoded_sizes(m, t) if m else None, 'encodedLimit': ENCODED_LIMIT,
            'execute': f'python3 {Path(__file__).name} --execute --root-reviewed {manifest_sha()}'}

def main(argv):
    ap = argparse.ArgumentParser(); ap.add_argument('--execute', action='store_true'); ap.add_argument('--root-reviewed')
    a = ap.parse_args(argv); bad = check_local()
    if not a.execute:
        print(json.dumps(plan(bad), indent=2)); return 0 if not bad else 2
    if bad: print(json.dumps({'refused': 'local bytes or transport are not pinned', 'mismatches': bad})); return 2
    if a.root_reviewed != manifest_sha(): print(json.dumps({'refused': 'missing or wrong --root-reviewed (root must review this manifest first)'})); return 2
    if (P / ATTEMPT).exists(): print(json.dumps({'refused': ATTEMPT + ' exists: one attempt per directory, root decides'})); return 2
    m = load_transport(); t = texts(new_stage())
    if max(encoded_sizes(m, t).values()) >= ENCODED_LIMIT: print(json.dumps({'refused': 'encoded command too long'})); return 2
    r, ok = execute(m, scp_real)
    print(json.dumps(r)); return 0 if ok else 1

if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
