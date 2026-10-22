#!/usr/bin/env python3
"""r5: ROOT-ONLY native validation of the challenge-activation functions on minipc (prepared by Claude; never run by it).

DEFAULT = PLAN ONLY: verifies the local pinned bytes and the pinned transport, prints the exact plan and makes NO network call.
EXECUTE requires BOTH --execute AND --root-reviewed <manifestSha> (printed by the plan). One attempt per directory: native-attempt.json
is created with O_EXCL BEFORE the first remote call. Remote effects: ONLY this run's own staging directory
C:\\ProgramData\\Enclave\\staging\\chact-native-<12 hex> (created, 5 pinned files + the fixture's own synthetic files, removed and
verified gone), plus the fixture's OWN loopback listener and OWN node.exe children (stopped by the fixture). No production entity is
touched. Transport: work/nucbox-tls-20261021/root-activate-reviewed.py c50aac8e (as the rpc-integrated native driver).
r4 (root native review):
  - No -ExecutionPolicy argument. The operator's effective policy is read and honoured: unless it is RemoteSigned, Unrestricted or
    Bypass, the fixture is NOT launched and the refusal is recorded. A PSSecurityException at launch is also recorded as a refusal.
    There is no workaround.
  - The fixture runs as a bounded child of the validate session, registered (PID+start) in <stage>/owned.jsonl before any wait.
  - Cleanup deletes the stage only after EVERY registered process (fixture host, fixture, its node children) is confirmed gone. A
    registered process still alive with its exact PID+start is stopped by that identity; nothing outside the registry is inspected
    beyond an exact-PID query, and nothing outside it is stopped. Anything unconfirmed keeps the stage and is reported.
  - native-result.json is ALWAYS written, with cleanup 'unknown' when the cleanup call itself failed; gone is never assumed.
r5 (cross-review F1-F5): cleanup is two calls.
  - DRAIN waits for, then stops, the registered identities. The stop is by an OPEN handle whose start time is re-checked
    (never Stop-Process by a number). Every CIM read is capped by the remaining budget.
  - REMOVE, with nothing waited on, re-confirms every registered identity gone, then RE-READS the registry; its registrars
    are confirmed gone by then. It deletes the stage only if:
      - the registry is unchanged;
      - no identity is alive or unknown;
      - a launch marker has its fixture-host row;
      - a fixture that ran recorded its own confirmed cleanup (children AND bounded readers).
    Otherwise it KEEPS the stage and reports why. No broad scan.
  - Validate falls back to the fixture's persisted fixture-result.json when a held pipe loses stdout. Such a result is
    reported, never counted as a pass."""
import argparse, base64, datetime, hashlib, importlib.util, json, subprocess, sys, uuid
from pathlib import Path

P = Path(__file__).resolve().parent
WORK = next(p for p in P.parents if (p / 'nucbox-tls-20261021').is_dir())
TRANSPORT = WORK / 'nucbox-tls-20261021/root-activate-reviewed.py'
TRANSPORT_SHA = 'c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
FILES = {   # exact uploaded bytes (also re-checked on minipc before anything runs)
    'chact.ps1': '850c1825e606359462b6119625b29f454dd4b0a78dfa4bd2fc27ada8c0aeb7a3',
    'node-hold-cutover.ps1': 'df2e58f2569d04b2021a570d8525769ef84976335d2c2657e7e2a3a92604a5d8',
    'edit-privacy-config.mjs': '4d9c231e624e9c51bc83e1e86b06816aa53a38a168752881a0ec71a879a8d511',
    'challengeReplica.json': '2b644d22c3fe1517fcca13fd01c07363cd0f5f5a65ea7f16fb466d958d0b62ad',
    'native-challenge-test.ps1': 'c6e5e2803e638f42a644c008132653cf5ea6e468626d815931d663783019d8fa',
}
STAGE_ROOT = r'C:\ProgramData\Enclave\staging'
PREFIX = 'chact-native-'
FIXTURE_SEC = 150                                     # native-challenge-test.ps1's own bound ($BOUND)
FIXTURE_WAIT_SEC = FIXTURE_SEC + 25                   # the validate session's own bounded wait for the fixture child
VALIDATE_SECS = FIXTURE_SEC + 60                      # transport watchdog for the validation call
CLEANUP_WAIT = (25, 10)                               # drain: wait for registered exits, then (after an exact-identity stop) confirm
DRAIN_BUDGET, DRAIN_SECS = 70, 90                     # drain's own budget (every wait and CIM timeout capped by it) / its transport watchdog
REMOVE_BUDGET, REMOVE_SECS = 30, 60
POLICY_OK = ('RemoteSigned', 'Unrestricted', 'Bypass')  # effective policies under which an unsigned local -File script may run
ATTEMPT, RESULT = 'native-attempt.json', 'native-result.json'
ENCODED_LIMIT = 7900                                  # the transport refuses longer encoded commands

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def q(s): return "'" + s.replace("'", "''") + "'"

def manifest():
    return {'transportSha': TRANSPORT_SHA, 'files': FILES, 'stagePrefix': STAGE_ROOT + '\\' + PREFIX,
            'fixtureSec': FIXTURE_SEC, 'validateSecs': VALIDATE_SECS, 'fixtureWaitSec': FIXTURE_WAIT_SEC, 'cleanupWait': list(CLEANUP_WAIT),
            'drain': [DRAIN_BUDGET, DRAIN_SECS], 'remove': [REMOVE_BUDGET, REMOVE_SECS], 'policyOk': list(POLICY_OK)}
def manifest_sha(): return hashlib.sha256(json.dumps(manifest(), sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def check_local(d=P):
    bad = {f: (sha(d / f) if (d / f).exists() else 'absent') for f in FILES if not (d / f).exists() or sha(d / f) != FILES[f]}
    if not TRANSPORT.exists() or sha(TRANSPORT) != TRANSPORT_SHA: bad['transport'] = 'absent or not c50aac8e'
    return bad

def new_stage(): return STAGE_ROOT + '\\' + PREFIX + uuid.uuid4().hex[:12]

def texts(stage, root=STAGE_ROOT, wait=CLEANUP_WAIT, fixture_ms=FIXTURE_WAIT_SEC * 1000):
    assert stage.startswith(root + '\\' + PREFIX) and "'" not in stage and '"' not in stage
    checks = "$h=@{" + ';'.join(f"'{f}'='{h}'" for f, h in FILES.items()) + "};foreach($k in $h.Keys){if((FileSha (Join-Path $s $k)) -ne $h[$k]){throw ('pin mismatch: '+$k)}}"
    ok = ','.join(f"'{x}'" for x in POLICY_OK)
    def common(budget):
        return (f"$s={q(stage)};if(-not $s.StartsWith({q(root + chr(92) + PREFIX)})){{throw 'not a chact-native stage'}};$r=[ordered]@{{stage=$s}};"
                "if(-not(Test-Path -LiteralPath $s)){$r.gone=$true;$r.registered=0;$r|ConvertTo-Json -Compress;exit 0};$g=Join-Path $s 'owned.jsonl';"
                "$L=@($(if(Test-Path -LiteralPath $g){[IO.File]::ReadAllLines($g)|Where-Object{$_ -like '{*'}|ForEach-Object{$_|ConvertFrom-Json}}));$rows=@($L|Where-Object{$_.pid});"
                f"$D=(Get-Date).AddSeconds({int(budget)});function T{{[int][math]::Max(1,[math]::Min(10,($D-(Get-Date)).TotalSeconds))}};"   # F4
                "function St($x){$v=$x.start;if($v -is [datetime]){return $v.ToUniversalTime()};try{[datetime]::Parse([string]$v,$null,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()}catch{$null}};"
                "function Same($x){$c=@(Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$x.pid) -OperationTimeoutSec (T));if($c.Count -ne 1){return 'gone'};$w=St $x;"
                "if($null -eq $w){return 'unknown'};if([math]::Abs(($c[0].CreationDate.ToUniversalTime()-$w).TotalSeconds) -lt 1){'same'}else{'gone'}};")
    return {
        'create': f"$s={q(stage)};if(Test-Path -LiteralPath $s){{throw 'stage exists'}};$null=New-Item -ItemType Directory -Path $s;"
                  "@{created=$s}|ConvertTo-Json -Compress",
        # the operator's effective execution policy is honoured (no policy override argument anywhere): refused = recorded, never worked around
        'validate': f"$s={q(stage)};function J($o){{$o|ConvertTo-Json -Compress -Depth 8}};$g=Join-Path $s 'owned.jsonl';if(@(Get-ChildItem -LiteralPath $s -Force).Count -ne {len(FILES)}){{throw 'stage file count differs'}};{checks};"
                    f"$ep=[string](Get-ExecutionPolicy);if(@({ok}) -notcontains $ep){{J @{{refused='execution-policy';executionPolicy=$ep;launched=$false}};exit 7}};"
                    "$si=New-Object Diagnostics.ProcessStartInfo;$si.FileName='powershell.exe';$f=Join-Path $s 'native-challenge-test.ps1';"
                    "$si.Arguments='-NoProfile -NonInteractive -File \"'+$f+'\" -Stage \"'+$s+'\"';$si.UseShellExecute=$false;$si.CreateNoWindow=$true;"
                    # the launch marker precedes Start: a launch whose identity never got registered is visible to REMOVE (stage kept)
                    "$si.RedirectStandardOutput=$true;$si.RedirectStandardError=$true;[IO.File]::AppendAllText($g,'{\"launching\":true}'+[char]10);$p=[Diagnostics.Process]::Start($si);"
                    "$st=$(try{$p.StartTime.ToUniversalTime().ToString('o')}catch{'unknown'});[IO.File]::AppendAllText($g,(J ([ordered]@{role='fixture-host';pid=$p.Id;start=$st}))+[char]10);"
                    "$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();"
                    f"if(-not $p.WaitForExit({int(fixture_ms)})){{J @{{timeout=$true;launched=$true;fixturePid=$p.Id}};exit 8}};"
                    "$t=$(if($o.Wait(5000)){$o.Result}else{''});$x=$(if($e.Wait(5000)){$e.Result}else{''});$j=@($t -split '\r?\n'|?{$_ -like '{*'})[-1];"
                    # F2: stdout held open by a surviving process -> the fixture's persisted result, reported as such (never a pass)
                    "if($j){$j;exit $p.ExitCode};$fr=Join-Path $s 'fixture-result.json';if(Test-Path -LiteralPath $fr){$k=@([IO.File]::ReadAllLines($fr)|?{$_ -like '{*'})[-1];"
                    "if($k){J @{fixtureResultFile=$true;exit=$p.ExitCode;result=($k|ConvertFrom-Json)};exit 10}};"
                    "if($x -match 'PSSecurityException|UnauthorizedAccess|running scripts is disabled|not digitally signed'){J @{refused='execution-policy';executionPolicy=$ep;launched=$true;exit=$p.ExitCode};exit 7};"
                    "J @{noFixtureOutput=$true;launched=$true;exit=$p.ExitCode};exit 9",
        # r5 cleanup = DRAIN then REMOVE (common prefix: the stage guard, ONE registry read, exact-PID reads capped by the budget)
        'drain': common(DRAIN_BUDGET) + f"$end=(Get-Date).AddSeconds({int(wait[0])});do{{$al=@($rows|Where-Object{{(Same $_) -ne 'gone'}});if(-not $al.Count){{break}};Start-Sleep -Seconds 1}}while((Get-Date) -lt $end -and (Get-Date) -lt $D);"
                 # F3: the stop holds the process's OWN handle (Process.Handle is opened and kept), re-checks the recorded start on it, kills THAT handle
                 "$r.stopped=@();foreach($x in @($al|Where-Object{(Same $_) -eq 'same'})){try{$h=Get-Process -Id ([int]$x.pid);$null=$h.Handle;"
                 "if([math]::Abs(($h.StartTime.ToUniversalTime()-(St $x)).TotalSeconds) -lt 1){$h.Kill();$r.stopped+=[string]$x.role+':'+$x.pid}}catch{}};"
                 f"$end=(Get-Date).AddSeconds({int(wait[1])});do{{$al=@($rows|Where-Object{{(Same $_) -ne 'gone'}});if(-not $al.Count){{break}};Start-Sleep -Seconds 1}}while((Get-Date) -lt $end -and (Get-Date) -lt $D);"
                 "$r.registered=$rows.Count;$r.alive=@($al|ForEach-Object{[string]$_.role+':'+$_.pid});$r|ConvertTo-Json -Compress",
        # REMOVE: nothing waited; every registered identity re-confirmed gone (so every registrar is gone), THEN the registry
        # re-read: deleted only if unchanged and every fail-closed condition holds; else the stage is KEPT with the reasons
        'remove': common(REMOVE_BUDGET) + "$al=@($rows|Where-Object{(Same $_) -ne 'gone'});$why=@();if($al.Count){$why+='registered own processes not confirmed exited'};"
                  "if(@($L|Where-Object{$_.launching}).Count -and -not @($rows|Where-Object{$_.role -eq 'fixture-host'}).Count){$why+='a fixture launch has no registered identity'};"
                  "$fin=@($L|Where-Object{$_.cleanup -eq 'fixture'});if(@($rows|Where-Object{$_.role -eq 'fixture'}).Count -and -not($fin.Count -eq 1 -and $fin[0].allExited -eq $true -and $fin[0].queryCleanupFailed -eq $false)){$why+='the fixture recorded no confirmed cleanup of its children and bounded readers'};"
                  "$L2=@($(if(Test-Path -LiteralPath $g){[IO.File]::ReadAllLines($g)|Where-Object{$_ -like '{*'}}));if($L2.Count -ne $L.Count){$why+='the registry changed during cleanup';$r.registeredNow=$L2.Count};"
                  "$r.registered=$rows.Count;$r.alive=@($al|ForEach-Object{[string]$_.role+':'+$_.pid});"
                  "if($why.Count){$r.gone=$false;$r.kept=($why -join '; ')+': the stage is kept';$r|ConvertTo-Json -Compress;exit 0};"
                  "Remove-Item -LiteralPath $s -Recurse -Force;$r.gone=(-not(Test-Path -LiteralPath $s));$r|ConvertTo-Json -Compress",
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
    attempted, interrupt = False, None
    try:
        attempted = True
        r['created'] = m.ps(t['create'], 40)
        if not (isinstance(r['created'], dict) and r['created'].get('created') == stage): raise RuntimeError('stage creation unconfirmed')
        for f in FILES: scp(d / f, 'minipc:/' + stage.replace('\\', '/') + '/' + f)
        r['validation'] = m.ps(t['validate'], VALIDATE_SECS)
    except BaseException as e:                       # incl. the transport's SystemExit: always recorded, cleanup still attempted
        r['error'] = f'{type(e).__name__}: {e}'
        if isinstance(e, KeyboardInterrupt): interrupt = e
    finally:
        if attempted:
            r['cleanup'] = {'gone': 'unknown', 'why': 'the cleanup calls did not complete'}
            for k, secs in (('drain', DRAIN_SECS), ('remove', REMOVE_SECS)):   # REMOVE runs even after a failed DRAIN: it is fail-closed itself
                try: r['drain' if k == 'drain' else 'cleanup'] = m.ps(t[k], secs)
                except BaseException as e:
                    r['drain' if k == 'drain' else 'cleanup'] = {'gone': 'unknown', 'why': f'the {k} call raised {type(e).__name__}: {e}'}
                    if isinstance(e, KeyboardInterrupt): interrupt = interrupt or e; break
        v = r.get('validation') if isinstance(r.get('validation'), dict) else {}
        v = v.get('result') if isinstance(v.get('result'), dict) else v
        r['executionPolicyRefused'] = v.get('refused') == 'execution-policy'
        (d / RESULT).write_text(json.dumps(r, indent=2) + '\n')
    if interrupt: raise interrupt
    ok = isinstance(r.get('validation'), dict) and r['validation'].get('pass') is True and isinstance(r.get('cleanup'), dict) and r['cleanup'].get('gone') is True
    return r, ok

def plan(bad):
    m = load_transport() if 'transport' not in bad else None
    t = texts(STAGE_ROOT + '\\' + PREFIX + '<12hex>'.replace('<12hex>', '0' * 12))
    return {'mode': 'PLAN ONLY (no network call made)', 'manifestSha': manifest_sha(), 'manifest': manifest(), 'localMismatches': bad,
            'stagePattern': STAGE_ROOT + '\\' + PREFIX + '<uuid4 hex 12>', 'steps': ['O_EXCL ' + ATTEMPT, 'create stage (refuse existing)',
            'scp 5 pinned files', 'validate: exact file count + 5 FileSha pins; effective execution policy honoured (refusal recorded, no workaround); '
            'native-challenge-test.ps1 as a registered bounded child (fixture bound %d s, wait %d s)' % (FIXTURE_SEC, FIXTURE_WAIT_SEC),
            'drain (always after a create attempt): wait for, then stop by an open re-checked handle, the registered own processes (budgeted)',
            'remove: re-confirm every registered identity gone, re-read the registry; delete + verify gone only if unchanged, launch registered and the fixture recorded its confirmed cleanup; else KEEP the stage',
            'write ' + RESULT + ' (always; cleanup unknown if its call failed)'],
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
