import importlib.util,json,pathlib
p=pathlib.Path('work/nucbox-tls-20261021/root-activate-reviewed.py');s=importlib.util.spec_from_file_location('activation',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ps="[Console]::OutputEncoding=[Text.UTF8Encoding]::new();"+m.MGR+r"""$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');manager=(Mgr)};
$id='0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77';
$v=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:8091/vms';$o.vm=@($v.vms|Where-Object {$_.name -eq $id}|Select-Object id,name,status,recovered,reason);
$s=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:9600/v1/host/state';$o.host=@($s.deployments|Where-Object {$_.id -eq $id}|Select-Object id,status,reason);
$o.node=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 2000|Where-Object {$_ -match 'a69dcbba' }|Select-Object -Last 18|ForEach-Object {[string]$_});
$o.shield=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\shield.log' -Tail 3000|Where-Object {$_ -match 'a69dcbba|error|timeout'}|Select-Object -Last 18|ForEach-Object {[string]$_});
$o.network=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\network.log' -Tail 1000|Where-Object {$_ -match 'a69dcbba' }|Select-Object -Last 20|ForEach-Object {[string]$_});
$o|ConvertTo-Json -Depth 5 -Compress"""
r=m.ps(ps,secs=60);pathlib.Path('work/api-mcp-recovery-20261023/diagnostic-after.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
