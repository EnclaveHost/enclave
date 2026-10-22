from pathlib import Path
import importlib.util,hashlib,json
b=Path(__file__).resolve().parent
t=b.parents[1]/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(t.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('transport',t);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ps=r'''$h=Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 -Uri 'http://127.0.0.1:9600/v1/host/state';[ordered]@{at=[DateTime]::UtcNow.ToString('o');deployments=@($h.deployments|ForEach-Object{[ordered]@{id=$_.id;status=$_.status;leaseUntil=$_.leaseUntil;reason=$_.reason;error=$_.error}});readiness=$h.leaseReadiness}|ConvertTo-Json -Depth 7 -Compress'''
v=m.ps(ps,40)
(b/'nucbox-queued-state.json').write_text(json.dumps(v,indent=2)+'\n')
print(json.dumps(v,indent=2))
