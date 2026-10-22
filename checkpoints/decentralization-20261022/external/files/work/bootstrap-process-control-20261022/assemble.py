from pathlib import Path
import hashlib,re,shutil
P=Path(__file__).resolve().parent; N=P/'native'; S=N/'stage'
s=(N/'native-bootstrap.ps1').read_text()
s=s[s.index('param('):]
s='''# Root-owned Windows bootstrap test fixture. Uses an unnamed job for this process and
# its descendants. Never selects processes by path/name/command line. Unknown cleanup
# preserves evidence. Existing execution policy applies. No production VM/task changes.
'''+s
s=s.replace("  'bounded-query.ps1' = '3a07a15f2dee557a4e2331cc176bc553142943b31d4578a9e8131179632f39b8'",'\n'.join("  '%s' = '%s'"%(n,hashlib.sha256((N/n).read_bytes()).hexdigest()) for n in ['FixtureJob.cs','FixtureJobCheck.cs']))
s=re.sub(r"\. \(Join-Path \$Stage 'bounded-query.ps1'\)[^\n]*",'''# Compile only the small ownership helper, then join before any fixture workload.
try {
  Add-Type -Path (Join-Path $Stage 'FixtureJob.cs') -ErrorAction Stop
  $fixtureJob = New-Object Enclave.Testing.FixtureJob
} catch {
  $out.status = 'PRECHECK'; $out.error = 'job unavailable: ' + $_.Exception.Message
  $out | ConvertTo-Json -Compress; exit 3
}''',s)
a=s.index("# processes naming this run's unique folders")
b=s.index("# the harness's lines",a)
s=s[:a]+'''# Membership is kernel tracked. The same open handle is checked and terminated;
# repeated snapshots cover descendants created while cleanup is in progress.
function Stop-Own { $fixtureJob.StopChildren((HardLeftMs)) }
'''+s[b:]
s=s.replace('$checks.Count -eq 4','$checks.Count -eq 5')
s=s.replace('distribution-bootstrap-r2-native','distribution-bootstrap-job-native')
marker='  # ---- 1 the shipping scripts parse'
pos=s.index(marker)
s=s[:pos]+'''  # Exercise native ownership, orphan cleanup and same-path decoy survival first.
  $jobExe = Join-Path $work 'FixtureJobCheck.exe'
  $jbuild = Invoke-Step $csc @('/nologo', '/target:exe', ('/out:' + $jobExe),
    (Join-Path $Stage 'FixtureJob.cs'), (Join-Path $Stage 'FixtureJobCheck.cs')) 60000
  Ran $jbuild 'job test compile'
  $checks.processOwnership = $false
  $out.jobBuild = [ordered]@{ code = $jbuild.code; output = ($jbuild.out + $jbuild.err).Trim() }
  if ($jbuild.code -ne 0 -or $jbuild.timedOut) { throw 'job test compile failed' }
  $jtest = Invoke-Step $jobExe @($work) 60000
  Ran $jtest 'job ownership tests'
  $checks.processOwnership = ($jtest.code -eq 0 -and -not $jtest.timedOut -and $jtest.outComplete -and $jtest.out -match 'ALL PASS')
  $out.jobTests = [ordered]@{ code = $jtest.code; output = ($jtest.out + $jtest.err).Trim() }
  if (-not $checks.processOwnership) { throw 'native process ownership checks failed' }

'''+s[pos:]
s=s.replace('#      and confirmed gone (pid + start time; a second query); a step\'s unconfirmed handle must also have exited',"#      and confirmed gone through job membership; a step's unconfirmed handle must also have exited")
s=s.replace('bounded-query.ps1 does it','the retained process handle requires')
s=s.replace('  $out.status = \'UNKNOWN\'; $out.pass = $false;',"  $fixtureJob.Dispose()\n  $out.status = 'UNKNOWN'; $out.pass = $false;")
s=s.replace('# ---- the harness\'s verdict',"$fixtureJob.Dispose()\n# ---- the harness's verdict")
(N/'native-bootstrap.ps1').write_text(s)
(S/'bounded-query.ps1').unlink()
for name in ['FixtureJob.cs','FixtureJobCheck.cs','native-bootstrap.ps1']: shutil.copyfile(N/name,S/name)
files={p.relative_to(S).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(S.rglob('*')) if p.is_file()}
d=(N/'run-native.py').read_text()
a=d.index('"""'); b=d.index('"""',a+3)
d=d[:a]+'''"""Root-owned bootstrap harness. PLAN by default; explicit exact manifest needed to run.
Uses isolated stage plus temporary work directory; preserves files on uncertain cleanup.
Windows job membership scopes cleanup to the fixture descendants. No policy override.
"""'''+d[b+3:]
a=d.index('FILES = {'); b=d.index('\nSTAGE_ROOT',a)
d=d[:a]+'FILES = '+repr(files)+d[b:]
d=d.replace('distribution-bootstrap-r2-native','distribution-bootstrap-job-native')
d='\n'.join(line for line in d.splitlines() if "if a.execute: print(json.dumps({'refused': 'NOT NATIVE-READY" not in line)+'\n'
(N/'run-native.py').write_text(d)
