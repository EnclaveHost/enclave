import subprocess,base64,pathlib,json,datetime
P=pathlib.Path(__file__).resolve().parent
ps=r'''$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};
$live='C:\Program Files\Enclave\control\windows\vbslike\manager\server.mjs';$stage='C:\ProgramData\Enclave\hotfix\enclavedns-liveness-20261021';
$o.managerSourceHash=[string](Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash.ToLower();
$o.stagedFixHash=[string](Get-FileHash -LiteralPath (Join-Path $stage 'server.mjs.fixed') -Algorithm SHA256).Hash.ToLower();
$o.stagedBackupHash=[string](Get-FileHash -LiteralPath (Join-Path $stage 'server.mjs.before') -Algorithm SHA256).Hash.ToLower();
try {$s=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:9600/v1/host/state';$o.deployments=@($s.deployments | ForEach-Object { @{id=[string]$_.id;status=[string]$_.status;instanceId=[string]$_.instanceId;isolationId=[string]$_.isolationId;leaseExpiry=[string]$_.leaseExpiry} })} catch {$o.hostError=[string]$_.Exception.Message}
try {$v=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:8091/vms';$o.vms=@($v.vms | ForEach-Object { @{id=[string]$_.id;status=[string]$_.status;vmState=[string]$_.vmState;deploymentId=[string]$_.deploymentId} })} catch {$o.managerError=[string]$_.Exception.Message}
$o.tasks=@(Get-ScheduledTask | Where-Object {$_.TaskName -match '^Enclave' -and $_.TaskName -notmatch 'InstallValidation'} | ForEach-Object { @{name=[string]$_.TaskName;state=[string]$_.State} });
'RESULT '+($o | ConvertTo-Json -Depth 5 -Compress)
'''
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(ps.encode('utf-16le')).decode()],capture_output=True,text=True,timeout=45)
assert r.returncode==0,(r.returncode,r.stderr[:500]);line=next(x[7:] for x in r.stdout.splitlines() if x.startswith('RESULT '));d=json.loads(line)
(P/'windows-readiness.json').write_text(json.dumps(d,indent=2)+'\n');print(json.dumps(d))
