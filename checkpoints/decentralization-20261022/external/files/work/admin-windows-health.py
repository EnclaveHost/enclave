import subprocess,base64,json
from pathlib import Path
s=r'''$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$d=Invoke-RestMethod 'http://127.0.0.1:9600/v1/deployments';$n=Get-Content 'C:\ProgramData\Enclave\network\state\status.json' -Raw|ConvertFrom-Json;[pscustomobject]@{at=[DateTime]::UtcNow.ToString('o');deployments=@($d.deployments|Select-Object id,status);networkUpdatedAt=$n.updatedAt;networkApps=@($n.apps).Count;networkReady=@($n.apps|Where-Object {$_.ready}).Count;fallback=@($n.apps|Where-Object {$_.fallbackActive}).Count}|ConvertTo-Json -Depth 4'''
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','minipc','powershell','-NoProfile','-EncodedCommand',base64.b64encode(s.encode('utf-16-le')).decode()],capture_output=True,text=True,timeout=45)
if r.returncode:raise RuntimeError(r.stderr[:400])
d=json.loads(r.stdout);Path('outputs/admin-control-audit/windows-health.json').write_text(json.dumps(d,indent=2)+'\n');print(json.dumps(d))
