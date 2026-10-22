#!/usr/bin/env python3
"""ROOT ONLY. Native Windows PowerShell 5.1 SCRATCH fixture for config-persistence-r3 migrate-local-config.ps1 (d2ae8f69), DUMMY data only.
Prepared by Claude; never run by it. Same shape as root's reviewed native-component.py (transport c50aac8e, staging, attempt journal).
  native-config-fixture.py                       PLAN ONLY (no network): prints the manifest of every file it would upload
  native-config-fixture.py --execute <manifest>  ONE attempt (attempt.json created exclusively; never overwritten)
What runs on the host:
  1. a new stage C:\\ProgramData\\Enclave\\staging\\config-native-fixture-<12 hex> (refused if it exists); the pinned files copied in;
  2. inline (root's transport): every pin re-checked on the host, csc v4 compiles FixtureJob.cs (root's reviewed b82285d6) +
     ConfigNativeFixture.cs, then Fixture.exe <stage> runs under a 420 s bound;
  3. Fixture.exe (inside its own FixtureJob) builds a private scratch tree in the stage and runs the UNCHANGED script ONLY as
     `powershell.exe -NoProfile -NonInteractive -File <stage>\\migrate-local-config.ps1 ...` plus real cmd.exe parser checks.
NO execution-policy argument, no policy change, no EncodedCommand for the script, no privilege change, no task/service, no
production path. Under the host's current Restricted policy the -File step is reported BLOCKED (not a pass); whether and how a
process-scoped policy may be authorized is root's/the user's decision, outside this fixture.
PASS = Fixture.exe exited 0 with ALL PASS. The stage (dummy files only) is removed whenever cleanup is CERTAIN: Fixture.exe exited
by itself (not timed out) and reported cleanupClean (no reparse point left, its own job drained) - pass or fail, every finding is
in result.json. When cleanup is uncertain the stage is LEFT for recovery and its path recorded."""
import importlib.util, pathlib, hashlib, json, subprocess, uuid, datetime, sys
P = pathlib.Path(__file__).resolve().parent.parent; W = next(p for p in P.parents if p.name == 'work')
T = W / 'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(T.read_bytes()).hexdigest() == 'c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
NATIVE = ['FixtureJob.cs', 'ConfigNativeFixture.cs']
STAGE_FILES = sorted(p.name for p in (P / 'stage').iterdir() if p.is_file())     # incl. fixture-manifest.json, migrate-local-config.ps1
FILES = {**{n: hashlib.sha256((P / 'native' / n).read_bytes()).hexdigest() for n in NATIVE},
         **{n: hashlib.sha256((P / 'stage' / n).read_bytes()).hexdigest() for n in STAGE_FILES}}
assert FILES['FixtureJob.cs'] == 'b82285d61fb64dddcd2149b50a9f56d6b1ee59ba9e4e442481cf7d133125741a', 'not root-reviewed FixtureJob'
assert FILES['migrate-local-config.ps1'] == 'd2ae8f6965176045186f1da9373778ee3daeb0b6d5144d3c46b2b2c2ad54739f', 'not the r3 script'
M = hashlib.sha256(json.dumps(FILES, sort_keys=True).encode()).hexdigest()

INLINE = r"""$s='STAGE';PINS
$csc=$env:WINDIR+'\Microsoft.NET\Framework64\v4.0.30319\csc.exe';
function Run($file,$argsText,$seconds){
 $i=New-Object Diagnostics.ProcessStartInfo $file;$i.Arguments=$argsText;$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true;
 $p=New-Object Diagnostics.Process;$p.StartInfo=$i;[void]$p.Start();$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();$done=$p.WaitForExit($seconds*1000);$timeout=-not $done;
 if(-not $done){$p.Kill();$done=$p.WaitForExit(5000)};
 $outDone=$false;if($done){$outDone=$o.Wait(3000) -and $e.Wait(1000)};
 @{exited=$done;timedOut=$timeout;complete=$outDone;code=$(if($done){$p.ExitCode}else{-1});output=$(if($outDone){$o.Result}else{'output incomplete'});log=$(if($outDone){$e.Result}else{''})}
};
$b=Run $csc ('/nologo /target:exe /r:System.Web.Extensions.dll /out:"'+$s+'\Fixture.exe" "'+$s+'\FixtureJob.cs" "'+$s+'\ConfigNativeFixture.cs"') 60;
$t=$null;if($b.exited -and -not $b.timedOut -and $b.code -eq 0){$t=Run ($s+'\Fixture.exe') ('"'+$s+'"') 420};
@{build=$b;test=$t;executionPolicy=[string](Get-ExecutionPolicy)}|ConvertTo-Json -Compress -Depth 5
"""


def inline(stage):
    pins = ''.join("if((FileSha ($s+'\\%s')) -ne '%s'){throw 'pin differs: %s'};" % (n, h, n) for n, h in FILES.items() if n in NATIVE or n == 'fixture-manifest.json')
    return INLINE.replace('STAGE', stage).replace('PINS', pins)


def compiler_failed_cleanly(b):
    # A missing/unknown compiler result or a timeout is never cleanup evidence.
    return (b.get('exited') is True and b.get('timedOut') is False
            and b.get('complete') is True and type(b.get('code')) is int
            and b['code'] != 0)


def main(argv):
    if argv != ['--execute', M]:
        s = inline('C:\\ProgramData\\Enclave\\staging\\config-native-fixture-000000000000')
        print(json.dumps({'mode': 'plan (no network)', 'manifest': M, 'files': FILES, 'inlineChars': len(s), 'execute': f'--execute {M}'}, indent=1))
        return 0 if not argv else 2
    s = importlib.util.spec_from_file_location('transport', T); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
    stage = 'C:\\ProgramData\\Enclave\\staging\\config-native-fixture-' + uuid.uuid4().hex[:12]
    r = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'stage': stage, 'manifest': M, 'files': FILES}
    with (P / 'root' / 'attempt.json').open('x') as f: json.dump(r, f)
    clean = False; certain = False
    try:
        r['created'] = m.ps("$s='%s';if(Test-Path -LiteralPath $s){throw 'exists'};$null=New-Item -ItemType Directory -Path $s;@{created=$s}|ConvertTo-Json -Compress" % stage, 30)
        if r['created'].get('created') != stage: raise RuntimeError('creation not confirmed')
        for n in FILES:
            src = P / ('native' if n in NATIVE else 'stage') / n
            subprocess.run(['timeout', '30', 'scp', '-q', '-o', 'BatchMode=yes', str(src), 'minipc:/' + stage.replace('\\', '/') + '/' + n], check=True, capture_output=True)
        r['validation'] = v = m.ps(inline(stage), 520)
        t = v.get('test', {}) or {}; b = v.get('build', {}) or {}
        out = t.get('output', '') if isinstance(t.get('output'), str) else ''
        try: r['fixture'] = json.loads(out.strip().split('\r\n')[0])
        except Exception: r['fixture'] = None
        fx = r['fixture'] or {}
        certain = t.get('exited') is True and not t.get('timedOut') and t.get('complete') is True and fx.get('cleanupClean') is True
        clean = b.get('code') == 0 and t.get('code') == 0 and certain and 'ALL PASS' in out and fx.get('allPass') is True
        r['ok'] = clean; r['blockedByExecutionPolicy'] = fx.get('blockedByExecutionPolicy')
        if compiler_failed_cleanly(b): certain = True  # compiler exited; no fixture was launched
    except BaseException as e:
        r['error'] = type(e).__name__ + ': ' + str(e); r['ok'] = False
    finally:
        if certain:
            try: r['cleanup'] = m.ps("$s='%s';Remove-Item -LiteralPath $s -Recurse -Force;@{gone=(-not(Test-Path -LiteralPath $s))}|ConvertTo-Json -Compress" % stage, 60)
            except BaseException as e: r['cleanup'] = {'gone': 'unknown', 'error': str(e)}
        else: r['cleanup'] = {'gone': 'unknown', 'leftForRecovery': stage}
        (P / 'root' / 'result.json').write_text(json.dumps(r, indent=2) + '\n')
    print(json.dumps({k: r.get(k) for k in ('stage', 'ok', 'blockedByExecutionPolicy', 'cleanup', 'error')}))
    return 0 if r.get('ok') and r.get('cleanup', {}).get('gone') is True else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
