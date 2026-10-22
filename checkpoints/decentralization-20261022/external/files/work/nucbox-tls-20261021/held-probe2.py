# READ-ONLY, scoped: node.log lines for 0xd9798e4c since the 12:13Z restart (all kinds, incl. "isolation adopted"), last 15,
# truncated; and the manager's current recovered/unattributed record count. No keys, env or app data.
import subprocess, base64, pathlib, json
ps = r'''$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'; $o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')}
function trim($s,$n){ $s=[string]$s; $s=($s -replace '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]',''); if($s.Length -gt $n){$s.Substring(0,$n)+'…'}else{$s} }
$nl=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 3000)
$o.d9798=@($nl | Where-Object { $_ -match 'd9798e4c' } | Select-Object -Last 15 | ForEach-Object { trim $_ 220 })
try{ $v=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:8091/vms'; $o.recovered=@($v.vms | Where-Object { $_.recovered -or $_.unattributed } | ForEach-Object { [string]$_.id+' '+(trim $_.name 10)+' '+$_.status+' rec='+$_.recovered+' unattr='+$_.unattributed }) }catch{ $o.mgrError=trim $_.Exception.Message 160 }
'RESULT '+($o | ConvertTo-Json -Depth 4 -Compress)
'''
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                    base64.b64encode(ps.encode('utf-16le')).decode()], capture_output=True, timeout=120)
t = r.stdout.decode('utf-8', 'replace'); i = t.find('RESULT ')
j = json.loads(t[i + 7:].strip().splitlines()[0]) if i >= 0 else {"error": t[-300:]}
pathlib.Path(__file__).with_name('held-probe2.json').write_text(json.dumps(j, indent=1)); print(json.dumps(j, indent=1))
