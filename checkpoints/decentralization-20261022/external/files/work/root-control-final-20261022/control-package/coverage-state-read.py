from pathlib import Path
import hashlib,importlib.util,json,datetime
r=Path(__file__).resolve().parent;t=r.parents[1]/'nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(t.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('transport',t);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
script=r"""$h=Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 -Uri 'http://127.0.0.1:9600/v1/host/state';[ordered]@{at=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();apps=@($h.deployments|ForEach-Object{[ordered]@{id=[string]$_.id;status=[string]$_.status;appRef=[string]$_.appRef;leaseUntil=[long]$_.leaseUntil;iso=[string]$_.isolation.instance;reason=[string]$_.reason;error=[string]$_.error}})}|ConvertTo-Json -Depth 5 -Compress"""
x=m.ps(script,60);(r/('coverage-state-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')).write_text(json.dumps(x,indent=2)+'\n');print(json.dumps(x));assert 'error' not in x
