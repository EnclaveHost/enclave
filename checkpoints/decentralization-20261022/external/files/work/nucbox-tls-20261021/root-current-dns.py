import importlib.util,json,pathlib
p=pathlib.Path(__file__).with_name('root-activate-reviewed.py');s=importlib.util.spec_from_file_location('activation',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ps=m.MGR+r"""$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');manager=(Mgr)};
$id='0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c';
$v=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:8091/vms';$o.vm=@($v.vms|Where-Object {$_.name -eq $id}|Select-Object id,name,status,recovered,reason);
$s=Invoke-RestMethod -TimeoutSec 8 'http://127.0.0.1:9600/v1/host/state';$o.host=@($s.deployments|Where-Object {$_.id -eq $id}|Select-Object id,status,reason);
$o.node=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 2000|Where-Object {$_ -match '59f1273d' -and $_ -match 'certificate|isolation|wallet policy'}|Select-Object -Last 6|ForEach-Object {[string]$_});
$o.network=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\network.log' -Tail 1000|Where-Object {$_ -match '59f1273d' -and $_ -match 'proof|egress|circuit'}|Select-Object -Last 5|ForEach-Object {[string]$_});
$o|ConvertTo-Json -Depth 5 -Compress"""
r=m.ps(ps,secs=60);p.with_name('root-current-dns.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
