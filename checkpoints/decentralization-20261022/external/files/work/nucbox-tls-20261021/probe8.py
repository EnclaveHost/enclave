# READ-ONLY, scoped probe 8: ONLY the crash stacks of the Windows manager (the 40 lines before each "[run] exited" in
# the last 6000 lines of shield.log), truncated 300 characters per line. A service stack trace: no keys, env or data.
import subprocess, base64, pathlib, json
ps = r'''$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'
function trim($s,$n){ $s=[string]$s; $s=($s -replace '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]',''); if($s.Length -gt $n){$s.Substring(0,$n)+'…'}else{$s} }
$t=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\shield.log' -Tail 6000); $out=@()
for($i=0;$i -lt $t.Count;$i++){ if($t[$i] -match '\[run\] exited'){ $s=[Math]::Max(0,$i-40); $out+=,@(@($t[$s..$i]) | Where-Object { $_ -notmatch 'console enclave-app|\[winmgr\] (liveness|answers)' } | ForEach-Object { trim $_ 300 }) } }
'RESULT '+(@{at=[DateTime]::UtcNow.ToString('o'); crashes=$out.Count; stacks=$out} | ConvertTo-Json -Depth 5 -Compress)
'''
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                    base64.b64encode(ps.encode('utf-16le')).decode()], capture_output=True, timeout=170)
here = pathlib.Path(__file__).parent
(here / 'probe8.out.raw').write_bytes(r.stdout + r.stderr)
t = r.stdout.decode('utf-8', 'replace'); i = t.find('RESULT ')
if i >= 0: (here / 'probe8.json').write_text(json.dumps(json.loads(t[i + 7:].strip().splitlines()[0]), indent=1))
print('SSH_EXIT', r.returncode, 'bytes', len(r.stdout)); raise SystemExit(r.returncode)
