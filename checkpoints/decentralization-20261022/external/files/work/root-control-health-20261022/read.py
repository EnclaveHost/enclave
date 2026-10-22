import pathlib,hashlib,importlib.util,json
W=pathlib.Path.cwd();t=W/'work/nucbox-tls-20261021/root-activate-reviewed.py'
assert hashlib.sha256(t.read_bytes()).hexdigest()=='c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f'
s=importlib.util.spec_from_file_location('transport',t);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ps=r'''$pd='C:\ProgramData\Enclave';$n=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$h=Invoke-RestMethod -UseBasicParsing -TimeoutSec 8 -Uri 'http://127.0.0.1:9600/v1/host/state';$s=[IO.File]::ReadAllText($pd+'\network\state\status.json')|ConvertFrom-Json;$d=[IO.File]::ReadAllText($pd+'\network\wallet-admission.json')|ConvertFrom-Json;$e=[IO.File]::ReadAllText($pd+'\network\state\egress-routes.json')|ConvertFrom-Json;$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');records=@($h.deployments|%{[ordered]@{id=[string]$_.id;status=[string]$_.status;held=($_.walletHeld -eq $true);leaseInMs=([int64]$_.leaseUntil*1000-$n)}});statusAgeMs=($n-[int64]$s.updatedAt);walletFresh=($s.walletAdmission.fresh -eq $true);walletApplied=($s.walletAdmission.applied -eq $true);generationMatch=([string]$s.walletAdmission.generation -ceq [string]$d.generation);walletError=$s.walletAdmission.error;allows=@($s.walletAdmission.allows);egress=@($e.apps.PSObject.Properties.Name);egressInMs=([int64]$e.expiresAt-$n);configSha=FileSha ($pd+'\network\privacy-config.json');localSha=FileSha ($pd+'\node-config.local.cmd');launcherSha=FileSha ($pd+'\run-node.cmd');updaterSha=FileSha 'C:\Program Files\Enclave\update-host.ps1'};$o|ConvertTo-Json -Depth 6 -Compress'''
r=m.ps(ps,60)
p=W/'work/root-control-health-20261022/result.json'
with p.open('x') as f:json.dump(r,f,indent=2)
print(json.dumps(r,indent=2))
