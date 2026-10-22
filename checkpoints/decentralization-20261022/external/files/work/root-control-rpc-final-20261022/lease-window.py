from pathlib import Path
import hashlib,importlib.util,json,datetime
r=Path(__file__).resolve().parent;t=r.parent/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(t.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
spec=importlib.util.spec_from_file_location('transport',t);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
s=r'''$h=Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:9600/v1/host/state';$u=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName Update;$i=Get-ScheduledTaskInfo -InputObject $u;[ordered]@{now=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();leases=@($h.deployments|Where-Object{$_.status -eq 'running'}|ForEach-Object{[ordered]@{id=[string]$_.id;leaseUntil=[long]$_.leaseUntil}});updateState=[string]$u.State;nextUpdate=$i.NextRunTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Depth 5 -Compress'''
v=m.ps(s,45)
if 'error' in v:raise RuntimeError(v)
now=v['now'];ends={x['id']:x['leaseUntil'] for x in v['leases']};assert len(ends)==9
best=[];last=-1
for sec in range(now,now+4*3600):
 for id,end in list(ends.items()):
  if end-sec<=250:ends[id]=(end+1800 if id.startswith('0x59f1273d') else sec+1800)
 left=min(ends.values())-sec
 if left>last:
  best.append({'at':datetime.datetime.fromtimestamp(sec,datetime.timezone.utc).isoformat(),'minRemaining':left})
 last=left
out={'actual':v,'forecastAssumptions':'Illustrative only: normal renewals land at 250 seconds remaining; self-hosted leases reset to 1800 seconds, paid EnclaveDNS extends by 1800. RPC, policy, mining and timer delays not modeled.','forecastLocalMaxima':best,'highestForecastMinRemaining':max(x['minRemaining'] for x in best)}
(r/'lease-window-current.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'actualMinRemaining':min(x['leaseUntil'] for x in v['leases'])-now,'running':9,'updateState':v['updateState'],'nextUpdate':v['nextUpdate'],'forecast':best}))
