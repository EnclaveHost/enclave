"""Read-only post-activation evidence; emits no config, keys or raw logs."""
import datetime,importlib.util,json,pathlib
root=pathlib.Path(__file__).resolve().parents[3]
s=importlib.util.spec_from_file_location('t',root/'work/nucbox-tls-20261021/root-activate-reviewed.py');t=importlib.util.module_from_spec(s);s.loader.exec_module(t)
p=r'''[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$before=@(Get-NetTCPConnection -LocalPort 9600 -State Listen|ForEach-Object {[int]$_.OwningProcess});$h=Invoke-RestMethod -TimeoutSec 8 http://127.0.0.1:9600/v1/host/state;$after=@(Get-NetTCPConnection -LocalPort 9600 -State Listen|ForEach-Object {[int]$_.OwningProcess});[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');before=$before;after=$after;deployments=@($h.deployments|Where-Object {$_.status -eq 'running'}|Select-Object id,status,leaseUntil);readiness=$h.leaseReadiness}|ConvertTo-Json -Depth 6 -Compress'''
x=t.ps(p,40)
if 'error' in x:print(json.dumps(x));raise SystemExit(2)
b=root/'work/resume-after-checkpoint-20261022/node-pair-runner/runs'
z=json.loads((b/'identify-result-identify-20261023t011924z.json').read_text());r=next(json.loads(l) for l in z['journal']['lines'] if json.loads(l).get('final')=='IDENTIFIED')
base={d['id']:d for d in r['deployments'] if d['status']=='running'};cur={d['id']:d for d in x['deployments']}
start=int(datetime.datetime.fromisoformat('2026-10-23T01:17:13.614966+00:00').timestamp()*1000)
rr=x.get('readiness') or {};ready={d['id']:d for d in rr.get('deployments',[]) if d.get('status')=='ready'}
passed=x['before']==x['after']==[28460] and set(cur)==set(base) and rr.get('startedAt',0)>start
checks={k:(k in ready and ready[k].get('checkedAt',0)>start and ready[k].get('leaseUntil')==cur[k].get('leaseUntil') and ready[k].get('runner')=='0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a') for k in base}
advanced=[k for k in base if k in cur and cur[k]['leaseUntil']>base[k]['leaseUntil']]
o={'at':x['at'],'sameProcessBeforeAfter':x['before']==x['after']==[28460],'sameNineRunning':set(cur)==set(base),'allNineFreshReady':passed and all(checks.values()),'readinessSequence':rr.get('sequence'),'readinessInFlight':rr.get('inFlight'),'readinessCompletedAt':rr.get('completedAt'),'pendingRunningChecks':[d['id'] for d in rr.get('deployments',[]) if d.get('id') in cur and d.get('status')=='pending'],'readyChecks':checks,'advancedLeases':advanced,'current':x['deployments'],'note':'An advanced lease under the new process is evidence of renewal; transaction provenance still needs its event/log corroboration. Readiness rows reset to pending on each pass; a mid-pass false allNineFreshReady is incomplete observation, not proof of service failure.'}
out=root/'outputs/decentralization-audit/windows-node-renewal-observation-20261023.json';out.write_text(json.dumps(o,indent=2)+'\n')
print(json.dumps({k:v for k,v in o.items() if k not in ('current','readyChecks')}))
