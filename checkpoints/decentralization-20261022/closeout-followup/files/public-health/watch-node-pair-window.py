"""Read-only bounded observation of the lease/update window; never activates anything."""
from pathlib import Path
import importlib.util,hashlib,json,time,datetime
b=Path(__file__).resolve().parent;t=b.parents[1]/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(t.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('transport',t);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ps=r'''$h=Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 -Uri 'http://127.0.0.1:9600/v1/host/state';$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName Update;$i=Get-ScheduledTaskInfo -InputObject $t;[ordered]@{at=[DateTime]::UtcNow.ToString('o');now=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();running=@($h.deployments|Where-Object{$_.status -eq 'running'}|ForEach-Object{[ordered]@{id=$_.id;leaseUntil=$_.leaseUntil}});readiness=$h.leaseReadiness;update=[ordered]@{state=[string]$t.State;enabled=$t.Settings.Enabled;next=$i.NextRunTime.ToUniversalTime().ToString('o')}}|ConvertTo-Json -Depth 7 -Compress'''
end=time.monotonic()+1800;previous=None
while time.monotonic()<end:
 v=m.ps(ps,40);v['observedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();v['windowCandidate']=False
 try:
  lease=min(int(d['leaseUntil'])-int(v['now']) for d in v['running']);n=datetime.datetime.fromisoformat(v['update']['next'].replace('Z','+00:00')).timestamp();v['leaseSecondsLeft']=lease
  v['windowCandidate']=lease>=1730 and v['update']['state']=='Ready' and v['update']['enabled'] is True and n-int(v['now'])>=2035
 except (KeyError,TypeError,ValueError):pass
 (b/'node-pair-window-latest.json').write_text(json.dumps(v,indent=2)+'\n')
 summary={k:v.get(k) for k in ('at','running','update','windowCandidate','error')};encoded=json.dumps(summary,sort_keys=True)
 if encoded!=previous:print(json.dumps({**summary,'leaseSecondsLeft':v.get('leaseSecondsLeft')}),flush=True);previous=encoded
 if v['windowCandidate']:raise SystemExit(0)
 time.sleep(min(30,max(0,end-time.monotonic())))
print('Bound reached; no activation performed.',flush=True);raise SystemExit(3)
