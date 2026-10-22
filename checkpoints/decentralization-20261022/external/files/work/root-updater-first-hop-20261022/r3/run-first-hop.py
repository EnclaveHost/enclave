#!/usr/bin/env python3
"""ROOT-ONLY first hop of the minipc updater: C:\\Program Files\\Enclave\\update-host.ps1 e0d9df1c (live legacy, 2026.10.12.47)
-> update-host r5 36f9e0d6 (role-preserving, rollback guard, PS 5.1 Install stderr fix, accepted signed-channel code unchanged).
Prepared by Claude; never run by it. Pattern: cutover-review / installer-review native run-native.py (root-reviewed).

  run-first-hop.py                                     PLAN ONLY (default): local pins, every PowerShell text, no network
  run-first-hop.py --mode check    --root-reviewed M   read-only gates on minipc (own stage, removed afterwards)
  run-first-hop.py --mode apply    --root-reviewed M   the swap (one attempt per directory: attempt-apply.json, O_EXCL)
  run-first-hop.py --mode rollback --root-reviewed M --run-id R   back to e0d9df1c from that apply's private backup

Remote writes: this run's own C:\\ProgramData\\Enclave\\staging\\updater-first-hop-<12 hex> (2 pinned files; removed + verified
gone); for apply/rollback also C:\\Program Files\\Enclave\\update-host.ps1 (CAS e0d9df1c <-> 36f9e0d6, ACL kept) and the private
backup C:\\ProgramData\\Enclave\\update-host-first-hop\\<runId>. Never: the task, the manifest, a policy, a process, a service.
Transport: work/nucbox-tls-20261021/root-activate-reviewed.py c50aac8e."""
import argparse, base64, datetime, hashlib, importlib.util, json, re, subprocess, sys, uuid
from pathlib import Path

P = Path(__file__).resolve().parent
WORK = next(p for p in P.parents if p.name == 'work' and (p / 'nucbox-tls-20261021').is_dir())
TRANSPORT = WORK / 'nucbox-tls-20261021/root-activate-reviewed.py'
TRANSPORT_SHA = 'c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
FILES = {'first-hop.ps1': 'd57c5ef60bad7e9575bc9b2215f9b5b2eccd4e0a7689fb56fa041e3d828771b0',
         'update-host.first-hop.ps1': '36f9e0d61afe58b77e566033ad1155d5c771252874f622592837c33e0a990112'}
LIVE = 'e0d9df1c271bf09cc21e8f00452fd0415087fb33b8030a7d16bbd717b7058531'
STAGE_ROOT = r'C:\ProgramData\Enclave\staging'
PREFIX = 'updater-first-hop-'
WINDOW_SEC = 600                      # first-hop.ps1 -WindowSec: the Update task must not be due within 10 min
SECS = {'check': 150, 'apply': 210, 'rollback': 210}
ENCODED_LIMIT = 7900
RUNID_RE = r'^[0-9]{14}-[0-9a-f]{8}$'

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def q(s): return "'" + s.replace("'", "''") + "'"
def manifest(): return {'transportSha': TRANSPORT_SHA, 'files': FILES, 'live': LIVE, 'stagePrefix': STAGE_ROOT + '\\' + PREFIX, 'windowSec': WINDOW_SEC, 'secs': SECS}
def manifest_sha(): return hashlib.sha256(json.dumps(manifest(), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
def check_local(d=P):
    bad = {f: (sha(d / f) if (d / f).exists() else 'absent') for f in FILES if not (d / f).exists() or sha(d / f) != FILES[f]}
    if not TRANSPORT.exists() or sha(TRANSPORT) != TRANSPORT_SHA: bad['transport'] = 'absent or not c50aac8e'
    return bad
def new_stage(): return STAGE_ROOT + '\\' + PREFIX + uuid.uuid4().hex[:12]
def new_run_id(): return datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S') + '-' + uuid.uuid4().hex[:8]

def texts(stage, mode, run_id=''):
    assert stage.startswith(STAGE_ROOT + '\\' + PREFIX) and "'" not in stage and mode in SECS
    assert (run_id == '') if mode == 'check' else bool(re.match(RUNID_RE, run_id))
    checks = ';'.join(f"if((FileSha ($s+'\\{f}')) -ne '{h}'){{throw 'pin mismatch: {f}'}}" for f, h in FILES.items())
    rid = f" -RunId '{run_id}'" if run_id else ''
    return {
        'create': f"$s={q(stage)};if(Test-Path -LiteralPath $s){{throw 'stage exists'}};$null=New-Item -ItemType Directory -Path $s;@{{created=$s}}|ConvertTo-Json -Compress",
        'run': f"$s={q(stage)};if(@(Get-ChildItem -LiteralPath $s -Recurse -Force -File).Count -ne {len(FILES)}){{throw 'stage file count differs'}};{checks};"
               f"& (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ($s+'\\first-hop.ps1') "
               f"-Mode {mode.capitalize()} -Stage $s -WindowSec {WINDOW_SEC}{rid};if($LASTEXITCODE -ne 0){{exit $LASTEXITCODE}}",
        'cleanup': f"$s={q(stage)};if(-not $s.StartsWith({q(STAGE_ROOT + chr(92) + PREFIX)})){{throw 'not an updater-first-hop stage'}};"
                   "if(Test-Path -LiteralPath $s){Remove-Item -LiteralPath $s -Recurse -Force};@{gone=(-not(Test-Path -LiteralPath $s))}|ConvertTo-Json -Compress",
    }

def load_transport():
    if sha(TRANSPORT) != TRANSPORT_SHA: raise SystemExit('transport is not the pinned c50aac8e')
    spec = importlib.util.spec_from_file_location('transport', TRANSPORT); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m
def encoded_sizes(m, t): return {k: len(base64.b64encode((m.HEAD.replace('SECS', '900') + v).encode('utf-16-le'))) for k, v in t.items()}
def scp_real(local, remote): subprocess.run(['timeout', '40', 'scp', '-q', '-o', 'BatchMode=yes', str(local), remote], check=True, capture_output=True)
def attempt_name(mode, ts): return f'attempt-check-{ts}.json' if mode == 'check' else f'attempt-{mode}.json'

def execute(m, scp, mode, run_id='', d=P, stage=None):
    stage = stage or new_stage(); t = texts(stage, mode, run_id); ts = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    r = {'at': ts, 'mode': mode, 'runId': run_id, 'stage': stage, 'files': FILES, 'manifestSha': manifest_sha(), 'transportSha': TRANSPORT_SHA}
    with (d / attempt_name(mode, ts)).open('x') as f: json.dump(r, f, indent=2)          # O_EXCL BEFORE any remote call
    try:
        r['created'] = m.ps(t['create'], 40)
        if not (isinstance(r['created'], dict) and r['created'].get('created') == stage): raise RuntimeError('stage creation unconfirmed')
        for f in FILES: scp(d / f, 'minipc:/' + stage.replace('\\', '/') + '/' + f)
        r['result'] = m.ps(t['run'], SECS[mode])
    except Exception as e: r['error'] = str(e)
    finally:
        r['cleanup'] = m.ps(t['cleanup'], 40)
        (d / f'result-{mode}-{ts}.json').write_text(json.dumps(r, indent=2) + '\n')
    res = r.get('result') if isinstance(r.get('result'), dict) else {}
    inner = res.get('result') if isinstance(res.get('result'), dict) else res        # transport wraps a non-zero exit as {error, result}
    ok = inner.get('ok') is True and inner.get('exit') == 0 and 'error' not in res and isinstance(r.get('cleanup'), dict) and r['cleanup'].get('gone') is True
    return r, ok

def plan(bad):
    m = load_transport() if 'transport' not in bad else None
    z = STAGE_ROOT + '\\' + PREFIX + '0' * 12
    t = {**{'check-' + k: v for k, v in texts(z, 'check').items()}, 'apply-run': texts(z, 'apply', '20261022000000-00000000')['run'],
         'rollback-run': texts(z, 'rollback', '20261022000000-00000000')['run']}
    return {'mode': 'PLAN ONLY (no network call made)', 'manifestSha': manifest_sha(), 'manifest': manifest(), 'localMismatches': bad,
            'texts': t, 'encodedSizes': encoded_sizes(m, t) if m else None, 'encodedLimit': ENCODED_LIMIT,
            'commands': {k: f'python3 {Path(__file__).name} --mode {k} --root-reviewed {manifest_sha()}' + (' --run-id <apply runId>' if k == 'rollback' else '') for k in SECS}}

def main(argv):
    ap = argparse.ArgumentParser(); ap.add_argument('--mode', choices=list(SECS)); ap.add_argument('--root-reviewed'); ap.add_argument('--run-id', default='')
    a = ap.parse_args(argv); bad = check_local()
    if not a.mode: print(json.dumps(plan(bad), indent=2)); return 0 if not bad else 2
    if bad: print(json.dumps({'refused': 'local bytes or transport are not pinned', 'mismatches': bad})); return 2
    if a.root_reviewed != manifest_sha(): print(json.dumps({'refused': 'missing or wrong --root-reviewed (root must review this manifest first)'})); return 2
    if a.mode == 'rollback':
        if not re.match(RUNID_RE, a.run_id): print(json.dumps({'refused': '--run-id <runId of the completed apply> is required'})); return 2
        applied = [json.loads(p.read_text()) for p in sorted(P.glob('result-apply-*.json'))]
        if not any(x.get('runId') == a.run_id for x in applied): print(json.dumps({'refused': 'no local apply result with that runId'})); return 2
        run_id = a.run_id
    elif a.run_id: print(json.dumps({'refused': '--run-id is only for rollback'})); return 2
    else: run_id = new_run_id() if a.mode == 'apply' else ''
    if a.mode != 'check' and (P / attempt_name(a.mode, '')).exists(): print(json.dumps({'refused': attempt_name(a.mode, '') + ' exists: one attempt, root decides'})); return 2
    m = load_transport()
    if max(encoded_sizes(m, texts(new_stage(), a.mode, run_id)).values()) >= ENCODED_LIMIT: print(json.dumps({'refused': 'encoded command too long'})); return 2
    r, ok = execute(m, scp_real, a.mode, run_id)
    print(json.dumps(r)); return 0 if ok else 1

if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
