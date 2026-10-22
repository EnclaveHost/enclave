import subprocess,base64,json,datetime
from pathlib import Path
script=r'''$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$h=Invoke-RestMethod -TimeoutSec 5 'http://127.0.0.1:9600/v1/health';$s=Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:9600/v1/host/state';$v=Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:8091/vms';[pscustomobject]@{healthy=$h.ok;leaseGas=$s.availability.leaseGas;operator=$s.availability.operator;deployments=@($s.deployments|Select-Object id,state,status,error,reason,name,leaseUntil);vms=@($v.vms|Select-Object id,status)}|ConvertTo-Json -Depth 8 -Compress'''
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode()],capture_output=True,text=True,timeout=45);assert r.returncode==0,r.stderr
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),**json.loads(r.stdout)}
Path('outputs/storage-adapter-incident/windows-recovery-live.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
