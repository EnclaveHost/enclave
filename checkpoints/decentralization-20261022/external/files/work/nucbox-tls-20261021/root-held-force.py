# ROOT-RUN ONLY (prepared by claude 6b7af721; not executed by it). ONE forced relaunch of ONE held nucbox app, only when the
# exact held state is proven on the host right before the POST (held-recovery-plan.txt step 2).
#   python3 root-held-force.py 59f1273d      (or 7ae476a3; one at a time)
import subprocess, base64, pathlib, sys, json
IDS = {"59f1273d": "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c",
       "7ae476a3": "0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33"}
if len(sys.argv) != 2 or sys.argv[1] not in IDS: sys.exit("usage: root-held-force.py 59f1273d|7ae476a3")
dep = IDS[sys.argv[1]]
ps = r'''$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$id='__DEP__';$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o'); id=$id}
$s=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:9600/v1/host/state';$d=@($s.deployments|Where-Object {$_.id -eq $id})
if($d.Count -ne 1 -or $d[0].status -ne 'provisioning' -or $d[0].reason -notlike '*did not end in a known state*'){throw ('not the reviewed held state: '+(($d|Select-Object status,reason)|ConvertTo-Json -Compress))}
$v=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:8091/vms'
if(@($v.vms|Where-Object {$_.recovered -or $_.unattributed}).Count -ne 0){throw 'a recovered/unattributed record exists: reconcile it first'}
if(@($v.vms|Where-Object {[string]$_.name -eq $id}).Count -ne 0){throw 'the manager already holds a record for this deployment: no second VM'}
$l=@(Get-NetTCPConnection -State Listen -LocalPort 8091); if($l.Count -ne 1 -or $l[0].OwningProcess -ne 35464){throw ('manager pid changed since the activation: '+(($l|Select-Object OwningProcess)|ConvertTo-Json -Compress))}
$o.before=@($d|Select-Object id,status,reason)
$body=@{id=$id;force=$true;enclave='nucbox-k11-4'}|ConvertTo-Json -Compress
try {$o.retry=Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 180 'http://127.0.0.1:9600/v1/claim-hint'} catch {$o.retryError=$_.Exception.Message; if($_.ErrorDetails.Message){$o.reply=$_.ErrorDetails.Message}}
$s=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:9600/v1/host/state';$o.after=@($s.deployments|Where-Object {$_.id -eq $id}|Select-Object id,status,reason)
'RESULT '+($o|ConvertTo-Json -Depth 5 -Compress)
'''.replace('__DEP__', dep)
r = subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-NonInteractive','-EncodedCommand',
                    base64.b64encode(ps.encode('utf-16le')).decode()], capture_output=True, timeout=240)
out = pathlib.Path(__file__).with_name(f'root-held-force-{sys.argv[1]}.out'); out.write_bytes(r.stdout + r.stderr)
print(r.stdout.decode(errors='replace')[-6000:], r.stderr.decode(errors='replace')[-1500:]); print('SSH_EXIT', r.returncode); sys.exit(r.returncode)
