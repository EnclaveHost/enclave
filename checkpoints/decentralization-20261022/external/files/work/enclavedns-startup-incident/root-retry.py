import subprocess,base64,pathlib
ps=r'''$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$id='0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c';$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};
$s=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:9600/v1/host/state';$d=@($s.deployments|Where-Object {$_.id -eq $id});if($d.Count -ne 1 -or $d[0].status -ne 'failed' -or $d[0].reason -notlike '*partition is Starting*'){throw 'Current deployment differs from reviewed startup failure; no retry'}
$o.before=@($d|Select-Object id,status,reason);$v=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:8091/vms';$o.beforeVms=@($v.vms|Select-Object id,name,status)
$body=@{id=$id;force=$true;enclave='nucbox-k11-4'}|ConvertTo-Json -Compress
try {$o.retry=Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 180 'http://127.0.0.1:9600/v1/claim-hint'} catch {$o.retryError=$_.Exception.Message; if($_.ErrorDetails.Message){$o.reply=$_.ErrorDetails.Message}}
$s=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:9600/v1/host/state';$o.after=@($s.deployments|Where-Object {$_.id -eq $id}|Select-Object id,status,reason);'RESULT '+($o|ConvertTo-Json -Depth 5 -Compress)
'''
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(ps.encode('utf-16le')).decode()],capture_output=True,timeout=220)
(pathlib.Path(__file__).parent/'root-retry.out').write_bytes(r.stdout+r.stderr);print(r.stdout.decode(errors='replace')[:12000]);print('SSH_EXIT',r.returncode);raise SystemExit(r.returncode)
