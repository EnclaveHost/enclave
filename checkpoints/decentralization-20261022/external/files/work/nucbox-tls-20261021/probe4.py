# READ-ONLY, scoped probe of nucbox (minipc) for the route-publication path (authorized: service/port/cert public metadata
# and config STRUCTURE; never keys, env, secrets, DB or full logs):
#   - the privacy agent's own status file(s) (status.json under C:\ProgramData\Enclave\network: per-app circuits, proof and
#     lease expiry), with any field whose name mentions key/secret/token/password dropped;
#   - network.log: only the LAST 4000 lines, filtered to the proof / publication / policy / authorization messages, counted
#     per message kind, the last 30 such lines truncated to 260 characters;
#   - listening sockets on :443 and the processes owning them (names only).
import subprocess, base64, pathlib, json
ps = r'''$ErrorActionPreference='Continue';$ProgressPreference='SilentlyContinue'; $o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')}
function trim($s,$n){ $s=[string]$s; $s=($s -replace '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]',''); if($s.Length -gt $n){$s.Substring(0,$n)+'…'}else{$s} }
function scrub($x){ if($x -is [System.Management.Automation.PSCustomObject]){ $h=[ordered]@{}; foreach($p in $x.PSObject.Properties){ if($p.Name -match 'key|secret|token|password|private|seed|sk$'){ $h[$p.Name]='<dropped>' } else { $h[$p.Name]=scrub $p.Value } }; return $h } elseif($x -is [System.Array]){ return @($x | ForEach-Object { scrub $_ }) } else { return $x } }
$files=@(Get-ChildItem -LiteralPath 'C:\ProgramData\Enclave\network' -Recurse -File -Filter 'status.json' -ErrorAction SilentlyContinue | Select-Object -First 4)
$o.statusFiles=@($files | ForEach-Object { $_.FullName+' '+$_.Length+' '+$_.LastWriteTimeUtc.ToString('o') })
$o.status=[ordered]@{}; foreach($f in $files){ try{ $o.status[$f.FullName]=scrub (Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json) }catch{ $o.status[$f.FullName]='unreadable: '+$_.Exception.Message } }
$log='C:\ProgramData\Enclave\logs\network.log'
$tail=@(Get-Content -LiteralPath $log -Tail 4000)
$o.logTailFirst=trim $tail[0] 40; $o.logTailLast=trim $tail[-1] 40
$pat='local guest proof|optional discovery transport|app policy|chain/app authorization|route|publish|circuit|proof'
$hits=@($tail | Where-Object { $_ -match $pat })
$o.kinds=[ordered]@{}; foreach($k in 'local guest proof','optional discovery transport','app policy','chain/app authorization','publish','circuit'){ $o.kinds[$k]=@($hits | Where-Object { $_ -match [regex]::Escape($k) }).Count }
$o.lastLines=@($hits | Select-Object -Last 30 | ForEach-Object { trim $_ 260 })
$o.distinctProofErrors=@($hits | Where-Object { $_ -match 'local guest proof' } | ForEach-Object { ($_ -replace '^\S+\s+','') -replace ' \(\d+ more since the last line\)','' } | ForEach-Object { trim $_ 220 } | Sort-Object -Unique | Select-Object -First 20)
$o.listen443=@(Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress+':443 pid '+$_.OwningProcess+' '+(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName })
'RESULT '+($o | ConvertTo-Json -Depth 8 -Compress)
'''
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                    base64.b64encode(ps.encode('utf-16le')).decode()], capture_output=True, timeout=170)
here = pathlib.Path(__file__).parent
(here / 'probe4.out.raw').write_bytes(r.stdout + r.stderr)
t = r.stdout.decode('utf-8', 'replace'); i = t.find('RESULT ')
if i >= 0:
    j = json.loads(t[i + 7:].strip().splitlines()[0]); (here / 'probe4.json').write_text(json.dumps(j, indent=1))
print('SSH_EXIT', r.returncode, 'bytes', len(r.stdout)); raise SystemExit(r.returncode)
