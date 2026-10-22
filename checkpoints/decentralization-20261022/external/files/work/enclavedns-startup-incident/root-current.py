import subprocess,base64,pathlib,datetime
ps=r'''$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$id='0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c';$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};
try {$s=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:9600/v1/host/state';$o.deployment=@($s.deployments | Where-Object {$_.id -eq $id} | Select-Object id,status,reason,isolationId,isolationHeld,instanceId,runner,leaseExpiry,app,version);$o.total=@($s.deployments).Count} catch {$o.hostError=$_.Exception.Message}
try {$v=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:8091/vms';$o.vms=@($v.vms | Select-Object id,status,vmState,deploymentId,error,reason)} catch {$o.managerError=$_.Exception.Message}
$o.logFiles=@(Get-ChildItem -LiteralPath 'C:\ProgramData\Enclave\logs' -File -ErrorAction SilentlyContinue | Select-Object Name,Length,LastWriteTimeUtc)
'RESULT '+($o | ConvertTo-Json -Depth 5 -Compress)
'''
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(ps.encode('utf-16le')).decode()],capture_output=True,timeout=80)
p=pathlib.Path(__file__).parent/'root-current.out';p.write_bytes(r.stdout+r.stderr);print(r.stdout.decode(errors='replace')[:14000]);print('SSH_EXIT',r.returncode);raise SystemExit(r.returncode)
