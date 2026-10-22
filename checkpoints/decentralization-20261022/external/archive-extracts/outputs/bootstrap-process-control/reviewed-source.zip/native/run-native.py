#!/usr/bin/env python3
"""Root-owned bootstrap harness. PLAN by default; explicit exact manifest needed to run.
Uses isolated stage plus temporary work directory; preserves files on uncertain cleanup.
Windows job membership scopes cleanup to the fixture descendants. No policy override.
"""
import argparse, base64, datetime, hashlib, importlib.util, json, subprocess, sys, uuid
from pathlib import Path
import pathlib

P = Path(__file__).resolve().parent
WORK = next(p for p in P.parents if p.name == 'work' and (p / 'nucbox-tls-20261021').is_dir())
TRANSPORT = WORK / 'nucbox-tls-20261021/root-activate-reviewed.py'
TRANSPORT_SHA = 'c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
STAGE_DIR = P / 'stage'
FILES = {'BootstrapCheck.cs': '023d8d57b74daf937727472303b426192d3a49bd5793f12c819dfc4c138c53d6', 'FixtureJob.cs': 'b82285d61fb64dddcd2149b50a9f56d6b1ee59ba9e4e442481cf7d133125741a', 'FixtureJobCheck.cs': '9e2d37679695f85ff1b8eebaa40f8208b4602303100ed804989bbc476d1d0901', 'native-bootstrap.ps1': '1bb3d6520309d19c2896e93366615aea782616989a2a7588ce0115f8a6e89225', 'repo/cli/host.ps1': '9c396209801be2edeae0d8e55d76d268b495e4755a3a464925843ed21b696488', 'repo/test/windows-native/Harness.cs': '5ec0768735a8bba108062e804ec348ca2d2397028abe92ac839bce2387ec3547', 'repo/test/windows-native/fixtures.json': '4e27f00729086ebbf0a550dcffa8cf8ecf0f34d377abd400acab18bc89127721', 'repo/test/windows-native/make-fixtures.mjs': '94608d043f00739e34913c47c678853cd40d5bcd00b5eb9e865185a36008983e', 'repo/test/windows-native/node-verdicts.json': 'bbd28794165202f292dec38d9540defeb5971f7af8ebb45efc207839bdec1a9d', 'repo/test/windows-native/run.ps1': 'bc337ae54703a9560bc1cbace2dd503fc7bfea58bf8ddf00f3187602e8d86d1b', 'repo/windows/installer/EnclaveSetup.cs': '5567d0ec12f31368b3687914c48cfd807eb93806b602d6a86e23c9558095bd19', 'repo/windows/installer/EnclaveSetup.manifest': 'e2b9315ca02b67d5b9de90a9b246d32d5e6e134aaf041e0b12bc674a2de468cc', 'repo/windows/installer/install-host.ps1': '1d1580c8f9ac22f6ec96a34cea8455853b21a21cff5214187710f3483953b721', 'repo/windows/installer/update-host.ps1': '36f9e0d61afe58b77e566033ad1155d5c771252874f622592837c33e0a990112', 'repo/windows/node/release-channel.mjs': 'f690c29b606879468db94b7b78f283e7de09f94a262803e13ee4dc61b447f942', 'repo/windows/node/update-watch.mjs': '9104b137b884ae5d46dfa94f2ec8529d36ee2cd51c89f204eec9335cd1af46a7', 'repo/windows/tray/TrayTheme.cs': '6de0a61684121d635772735772908521a3eb0179a5583abf1fc1ab13469d9284'}
STAGE_ROOT = r'C:\ProgramData\Enclave\staging'
PREFIX = 'distribution-bootstrap-job-native-'
FIXTURE_SEC = 900                                     # native-bootstrap.ps1's own bound ($BOUND_SEC)
VALIDATE_SECS = FIXTURE_SEC + 60                       # the transport's watchdog only after the fixture's own bound
CLEAN = {'PASS', 'FAIL', 'PARTIAL', 'REFUSED', 'PRECHECK'}   # terminal reports after which no own child can still run
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
    refused = "'execution polic|not digitally signed|running scripts is disabled'"
    return {
        'create': f"$s={q(stage)};if(Test-Path -LiteralPath $s){{throw 'stage exists'}};$null=New-Item -ItemType Directory -Path $s;"
                  + ''.join(f"$null=New-Item -ItemType Directory -Path ($s+'\\{win(d)}');" for d in DIRS) + "@{created=$s}|ConvertTo-Json -Compress",
        # under the host's own execution policy; the last line is always one JSON report (the fixture's, or this wrapper's)
        'validate': f"$s={q(stage)};$ep=[string](Get-ExecutionPolicy);"
                    f"try{{if(@(Get-ChildItem -LiteralPath $s -Recurse -Force -File).Count -ne {len(FILES)}){{throw 'stage file count differs'}};{checks}}}"
                    "catch{@{status='PRECHECK';pass=$false;error=$_.Exception.Message;executionPolicy=$ep}|ConvertTo-Json -Compress;exit 1};"
                    "$ErrorActionPreference='Continue';$o=@(& powershell.exe -NoProfile -NonInteractive -File ($s+'\\native-bootstrap.ps1') -Stage $s 2>&1|%{\"$_\"});$c=$LASTEXITCODE;"
                    "$j=@($o|?{$_ -like '{*'})|select -Last 1;if($j){$j;exit $c};$t=($o -join ' ');"
                    f"$r=$t -match {refused};@{{status=$(if($r){{'REFUSED'}}else{{'NO-RESULT'}});pass=$false;policyRefused=$r;executionPolicy=$ep;exit=$c;"
                    "output=$t.Substring(0,[math]::Min(600,$t.Length))}|ConvertTo-Json -Compress;exit 1",
        # Only called after this run positively confirmed creation of its stage.
        'cleanup': f"$s={q(stage)};if(-not $s.StartsWith({q(STAGE_ROOT + chr(92) + PREFIX)})){{throw 'not a distribution-bootstrap-job-native stage'}};"
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

def report(v):   # the fixture's (or the validate wrapper's) own terminal report inside a transport result, if there is one
    rep = v.get('result') if isinstance(v, dict) and 'error' in v else v
    return rep if isinstance(rep, dict) and 'status' in rep else None

def execute(m, scp, d=STAGE_DIR, stage=None, rec=P):
    stage = stage or new_stage(); t = texts(stage)
    r = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'stage': stage, 'files': FILES,
         'manifestSha': manifest_sha(), 'transportSha': TRANSPORT_SHA}
    with (rec / ATTEMPT).open('x') as f: json.dump(r, f, indent=2)          # O_EXCL BEFORE any remote call
    attempted = created = validating = False; interrupt = None
    try:
        attempted = True
        r['created'] = m.ps(t['create'], 40)
        if not (isinstance(r['created'], dict) and r['created'].get('created') == stage): raise RuntimeError('stage creation unconfirmed')
        created = True
        for f in FILES: scp(d / f, 'minipc:/' + stage.replace('\\', '/') + '/' + f)
        validating = True
        r['validation'] = m.ps(t['validate'], VALIDATE_SECS)
    except BaseException as e:                       # M1: incl. SystemExit/KeyboardInterrupt from the transport: recorded, never silent
        r['error'] = f'{type(e).__name__}: {e}'
        if isinstance(e, KeyboardInterrupt): interrupt = e
    finally:
        rep = report(r.get('validation'))
        r['status'] = rep.get('status') if rep else ('NO-REPORT' if validating else 'NOT-VALIDATED')
        if validating and (rep is None or rep.get('childExitUnknown') or rep.get('status') not in CLEAN):
            # the fixture may still have a running child: remove NOTHING; root inspects (read-only) before any cleanup
            r['cleanup'] = {'skipped': 'fixture child exit unknown or no terminal report', 'recovery': {'stage': stage, 'left': rep.get('leftForRecovery') if rep else None}}
        elif attempted and not created:
            # An existing directory or a lost create response does not establish
            # ownership. Preserve it, including any partially created stage.
            r['cleanup'] = {'skipped': 'stage creation was not confirmed; ownership unknown', 'recovery': {'stage': stage}}
        elif created:
            r['cleanup'] = {'gone': 'unknown', 'why': 'the cleanup call did not complete'}   # M1: never assumed gone
            try: r['cleanup'] = m.ps(t['cleanup'], 40)
            except BaseException as e:
                r['cleanup'] = {'gone': 'unknown', 'why': f'the cleanup call raised {type(e).__name__}: {e}'}
                if isinstance(e, KeyboardInterrupt): interrupt = interrupt or e
            if not isinstance(r['cleanup'], dict): r['cleanup'] = {'gone': 'unknown', 'raw': r['cleanup']}
        if rep and rep.get('leftForRecovery'): r['cleanup']['leftForRecovery'] = rep.get('leftForRecovery')   # L4: every branch
        (rec / RESULT).write_text(json.dumps(r, indent=2) + '\n')
    if interrupt: raise interrupt
    ok = bool(rep) and rep.get('status') == 'PASS' and rep.get('pass') is True and isinstance(r.get('cleanup'), dict) and r['cleanup'].get('gone') is True
    return r, ok

def plan(bad):
    m = load_transport() if 'transport' not in bad else None
    t = texts(STAGE_ROOT + '\\' + PREFIX + '0' * 12)
    return {'mode': 'PLAN ONLY (no network call made)', 'manifestSha': manifest_sha(), 'manifest': manifest(), 'localMismatches': bad,
            'stagePattern': STAGE_ROOT + '\\' + PREFIX + '<uuid4 hex 12>', 'steps': ['O_EXCL ' + ATTEMPT, 'create stage (refuse existing)',
            'scp %d pinned files' % len(FILES), 'validate: exact recursive file count + FileSha pin of the fixture (it pins the other %d), then native-bootstrap.ps1 under the host execution policy (bound %d s)' % (len(FILES) - 1, FIXTURE_SEC),
            'cleanup own stage + verify gone, unless the fixture reports childExitUnknown / gives no terminal report (then RECOVERY: nothing removed)',
            'success only on fixture status PASS; PARTIAL / REFUSED / FAIL / UNKNOWN are reported as such', 'write ' + RESULT],
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
