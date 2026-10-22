# READ-ONLY, scoped probe 5 of nucbox: the certificate path for its apps.
#   - node.log: LAST 8000 lines, only lines mentioning "certificate" or "cert" AND a nucbox app id, truncated 300 chars;
#     per-app counts by message shape and the last 4 lines per app
#   - each CURRENT partition console (C:\ProgramData\Enclave\logs\partitions\<vm>.log for running VMs): only lines that
#     mention certif/tls/acme/sni/spki, last 8 per VM, truncated 260 (guest bytes are untrusted data, control chars stripped)
# No keys, env, secrets, DB or full logs.
import subprocess, base64, pathlib, json
ps = r'''$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'; $o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')}
function trim($s,$n){ $s=[string]$s; $s=($s -replace '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]',''); if($s.Length -gt $n){$s.Substring(0,$n)+'…'}else{$s} }
$ids='59f1273d','d9798e4c','7ae476a3','38f368d6','a69dcbba','a77d0c57','c13d4b6a','e64f7cba','ef514ed3'
$tail=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 8000)
$o.nodeTail=(trim $tail[0] 12)+' .. '+(trim $tail[-1] 12)
$cert=@($tail | Where-Object { $_ -match 'certif' })
$o.nodeCert=[ordered]@{}
foreach($i in $ids){ $l=@($cert | Where-Object { $_ -match $i }); $o.nodeCert[$i]=[ordered]@{count=$l.Count; shapes=@($l | ForEach-Object { (($_ -replace '^\S+\s+','') -replace '\d{2}:\d{2}:\d{2}','') -replace 'retry in \d+s','retry' } | ForEach-Object { trim $_ 200 } | Sort-Object -Unique | Select-Object -First 6); last=@($l | Select-Object -Last 4 | ForEach-Object { trim $_ 300 })} }
$o.nodeCertOther=@($cert | Where-Object { $l=$_; -not ($ids | Where-Object { $l -match $_ }) } | Select-Object -Last 8 | ForEach-Object { trim $_ 260 })
$running=@(Get-VM | Where-Object { $_.State -eq 'Running' -and $_.Name -like 'enclave-app-*' } | ForEach-Object { $_.Name })
$o.running=$running
$o.consoles=[ordered]@{}
foreach($v in $running){ $f=Join-Path 'C:\ProgramData\Enclave\logs\partitions' ($v+'.log'); if(Test-Path -LiteralPath $f){ $o.consoles[$v]=@(Get-Content -LiteralPath $f -Tail 3000 | Where-Object { $_ -match 'certif|tls|acme|sni|spki|DOM serving' -and $_ -notmatch 'tls handshake error' } | Select-Object -Last 8 | ForEach-Object { trim $_ 260 }); $o.consoles[$v+'#handshakeErrors']=@(Get-Content -LiteralPath $f -Tail 3000 | Where-Object { $_ -match 'tls handshake error' }).Count } }
'RESULT '+($o | ConvertTo-Json -Depth 6 -Compress)
'''
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                    base64.b64encode(ps.encode('utf-16le')).decode()], capture_output=True, timeout=170)
here = pathlib.Path(__file__).parent
(here / 'probe5.out.raw').write_bytes(r.stdout + r.stderr)
t = r.stdout.decode('utf-8', 'replace'); i = t.find('RESULT ')
if i >= 0: (here / 'probe5.json').write_text(json.dumps(json.loads(t[i + 7:].strip().splitlines()[0]), indent=1))
print('SSH_EXIT', r.returncode, 'bytes', len(r.stdout)); raise SystemExit(r.returncode)
