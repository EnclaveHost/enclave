#!/usr/bin/env python3
"""ROOT-ONLY native Windows PowerShell 5.1 + in-box csc fixture for distribution-bootstrap (EnclaveSetup.cs policy pinning +
relaunch quoting; the repo's own native verifier harness). Prepared by Claude; never run by it. Pattern: updater-first-hop-r4
native/run-native.py (root-executed 93383).

DEFAULT = PLAN ONLY (no network). EXECUTE needs --execute AND --root-reviewed <manifestSha>; one attempt per directory
(native-attempt.json, O_EXCL, before the first remote call). Remote writes: ONLY this run's own
C:\\ProgramData\\Enclave\\staging\\distribution-bootstrap-native-<12 hex> (15 pinned files in their repo layout) and fresh
%TEMP% folders the fixture removes; the built EnclaveSetup.exe is hashed, never started. Removed and verified gone.
No task, service, VM, network beyond 127.0.0.1, ProgramData\\Enclave-setup or Program Files is changed.
Transport: work/nucbox-tls-20261021/root-activate-reviewed.py c50aac8e."""
import argparse, base64, datetime, hashlib, importlib.util, json, subprocess, sys, uuid
from pathlib import Path
import pathlib

P = Path(__file__).resolve().parent
WORK = next(p for p in P.parents if p.name == 'work' and (p / 'nucbox-tls-20261021').is_dir())
TRANSPORT = WORK / 'nucbox-tls-20261021/root-activate-reviewed.py'
TRANSPORT_SHA = 'c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
STAGE_DIR = P / 'stage'
FILES = {
    'BootstrapCheck.cs': '327adb168958d9159768390a6a95a7c9a118faa34036670b52165989da3b81fa',
    'native-bootstrap.ps1': '41c637ba2ecbdc1dd7c4e5f0f0c4db9e73158c98b6a7bf822626c52260bd8274',
    'repo/cli/host.ps1': '9c396209801be2edeae0d8e55d76d268b495e4755a3a464925843ed21b696488',
    'repo/test/windows-native/Harness.cs': '5ec0768735a8bba108062e804ec348ca2d2397028abe92ac839bce2387ec3547',
    'repo/test/windows-native/fixtures.json': '4e27f00729086ebbf0a550dcffa8cf8ecf0f34d377abd400acab18bc89127721',
    'repo/test/windows-native/make-fixtures.mjs': '94608d043f00739e34913c47c678853cd40d5bcd00b5eb9e865185a36008983e',
    'repo/test/windows-native/node-verdicts.json': 'bbd28794165202f292dec38d9540defeb5971f7af8ebb45efc207839bdec1a9d',
    'repo/test/windows-native/run.ps1': 'bc337ae54703a9560bc1cbace2dd503fc7bfea58bf8ddf00f3187602e8d86d1b',
    'repo/windows/installer/EnclaveSetup.cs': '6d707db7c6ef95a4e3f127dd1220b8856186203bf37b3eff69a999ab2d0fb60a',
    'repo/windows/installer/EnclaveSetup.manifest': 'e2b9315ca02b67d5b9de90a9b246d32d5e6e134aaf041e0b12bc674a2de468cc',
    'repo/windows/installer/install-host.ps1': '1d1580c8f9ac22f6ec96a34cea8455853b21a21cff5214187710f3483953b721',
    'repo/windows/installer/update-host.ps1': '36f9e0d61afe58b77e566033ad1155d5c771252874f622592837c33e0a990112',
    'repo/windows/node/release-channel.mjs': 'f690c29b606879468db94b7b78f283e7de09f94a262803e13ee4dc61b447f942',
    'repo/windows/node/update-watch.mjs': '9104b137b884ae5d46dfa94f2ec8529d36ee2cd51c89f204eec9335cd1af46a7',
    'repo/windows/tray/TrayTheme.cs': '6de0a61684121d635772735772908521a3eb0179a5583abf1fc1ab13469d9284',
}
STAGE_ROOT = r'C:\ProgramData\Enclave\staging'
PREFIX = 'distribution-bootstrap-native-'
FIXTURE_SEC = 900                                     # native-bootstrap.ps1's own bound ($BOUND_SEC)
VALIDATE_SECS = FIXTURE_SEC + 60
ATTEMPT, RESULT = 'native-attempt.json', 'native-result.json'
DIRS = sorted({str(pathlib.PurePosixPath(f).parent) for f in FILES if '/' in f} | {str(p) for f in FILES for p in pathlib.PurePosixPath(f).parents if str(p) not in ('.', '')}, key=lambda d: (d.count('/'), d))
ENCODED_LIMIT = 7900

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def q(s): return "'" + s.replace("'", "''") + "'"
def win(rel): return rel.replace('/', '\\')

def manifest():
    return {'transportSha': TRANSPORT_SHA, 'files': FILES, 'stagePrefix': STAGE_ROOT + '\\' + PREFIX,
            'fixtureSec': FIXTURE_SEC, 'validateSecs': VALIDATE_SECS}
def manifest_sha(): return hashlib.sha256(json.dumps(manifest(), sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def check_local(d=STAGE_DIR):
    bad = {f: (sha(d / f) if (d / f).exists() else 'absent') for f in FILES if not (d / f).exists() or sha(d / f) != FILES[f]}
    if not TRANSPORT.exists() or sha(TRANSPORT) != TRANSPORT_SHA: bad['transport'] = 'absent or not c50aac8e'
    return bad

def new_stage(): return STAGE_ROOT + '\\' + PREFIX + uuid.uuid4().hex[:12]

def texts(stage):
    assert stage.startswith(STAGE_ROOT + '\\' + PREFIX) and "'" not in stage
    checks = f"if((FileSha ($s+'\\native-bootstrap.ps1')) -ne '{FILES['native-bootstrap.ps1']}'){{throw 'pin mismatch: native-bootstrap.ps1'}}"
    return {
        'create': f"$s={q(stage)};if(Test-Path -LiteralPath $s){{throw 'stage exists'}};$null=New-Item -ItemType Directory -Path $s;"
                  + ''.join(f"$null=New-Item -ItemType Directory -Path ($s+'\\{win(d)}');" for d in DIRS) + "@{created=$s}|ConvertTo-Json -Compress",
        'validate': f"$s={q(stage)};if(@(Get-ChildItem -LiteralPath $s -Recurse -Force -File).Count -ne {len(FILES)}){{throw 'stage file count differs'}};{checks};"
                    "& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ($s+'\\native-bootstrap.ps1') -Stage $s;"
                    "if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}",
        # unique to this run: also attempted when creation was unconfirmed (the create text refuses an existing path)
        'cleanup': f"$s={q(stage)};if(-not $s.StartsWith({q(STAGE_ROOT + chr(92) + PREFIX)})){{throw 'not an updater-first-hop-r4-native stage'}};"
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

def execute(m, scp, d=STAGE_DIR, stage=None, rec=P):
    stage = stage or new_stage(); t = texts(stage)
    r = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'stage': stage, 'files': FILES,
         'manifestSha': manifest_sha(), 'transportSha': TRANSPORT_SHA}
    with (rec / ATTEMPT).open('x') as f: json.dump(r, f, indent=2)          # O_EXCL BEFORE any remote call
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
        (rec / RESULT).write_text(json.dumps(r, indent=2) + '\n')
    v = r.get('validation') if isinstance(r.get('validation'), dict) else {}
    ok = v.get('pass') is True and isinstance(r.get('cleanup'), dict) and r['cleanup'].get('gone') is True
    return r, ok

def plan(bad):
    m = load_transport() if 'transport' not in bad else None
    t = texts(STAGE_ROOT + '\\' + PREFIX + '0' * 12)
    return {'mode': 'PLAN ONLY (no network call made)', 'manifestSha': manifest_sha(), 'manifest': manifest(), 'localMismatches': bad,
            'stagePattern': STAGE_ROOT + '\\' + PREFIX + '<uuid4 hex 12>', 'steps': ['O_EXCL ' + ATTEMPT, 'create stage (refuse existing)',
            'scp %d pinned files' % len(FILES), 'validate: exact recursive file count + %d FileSha pins, then native-bootstrap.ps1 (bound %d s)' % (len(FILES), FIXTURE_SEC),
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
