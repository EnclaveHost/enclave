from pathlib import Path
import hashlib,importlib.util,json,datetime,base64
r=Path(__file__).resolve().parent;w=r.parent
t=w/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(t.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
spec=importlib.util.spec_from_file_location('transport',t);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
i=json.loads((w/'lease-readiness-20261022/candidate-inventory.json').read_text())
files=i['control']['files']
print(type(files).__name__,flush=True)
if isinstance(files,dict):names=list(files)
else:names=[x.get('name',x.get('path')) for x in files]
assert len(names)==101 and all(isinstance(x,str) and '..' not in x and not x.startswith('/') for x in names)
q=lambda s:"'"+s.replace("'","''")+"'"
root=r"C:\Program Files\Enclave\control"
result={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':{},'batches':[]}
for start in range(0,len(names),14):
 batch=names[start:start+14]
 script="$o=[ordered]@{};foreach($n in @("+','.join(q(x) for x in batch)+")){$o[$n]=FileSha (Join-Path "+q(root)+" $n)};$o|ConvertTo-Json -Compress"
 assert len(base64.b64encode((m.HEAD.replace('SECS','35')+script).encode('utf-16-le')))<=7900
 x=m.ps(script,35)
 if 'error' in x:raise RuntimeError(x)
 assert set(x)==set(batch)
 result['files'].update(x);result['batches'].append({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'count':len(x)})
 (r/'snapshot.partial.json').write_text(json.dumps(result,indent=2)+'\n')
 print('Hashed',len(result['files']),flush=True)
script=r"""$h=Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:9600/v1/host/state';$u=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName Update;$i=Get-ScheduledTaskInfo -InputObject $u;[ordered]@{now=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();leases=@($h.deployments|ForEach-Object{[ordered]@{id=[string]$_.id;status=[string]$_.status;leaseUntil=[long]$_.leaseUntil}});updateState=[string]$u.State;nextUpdate=$i.NextRunTime.ToUniversalTime().ToString('o');privacy=FileSha 'C:\Program Files\Enclave\network\privacy-agent.mjs';runNode=FileSha 'C:\ProgramData\Enclave\run-node.cmd';localConfig=FileSha 'C:\ProgramData\Enclave\node-config.local.cmd';privacyConfig=FileSha 'C:\ProgramData\Enclave\network\privacy-config.json'}|ConvertTo-Json -Depth 5 -Compress"""
x=m.ps(script,45)
if 'error' in x:raise RuntimeError(x)
result['state']=x;result['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();(r/'snapshot.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'fileCount':len(result['files']),'running':sum(x['status']=='running' for x in result['state']['leases']),'updateState':result['state']['updateState'],'nextUpdate':result['state']['nextUpdate']}))
