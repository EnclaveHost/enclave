import importlib.util,json,pathlib
p=pathlib.Path('work/nucbox-tls-20261021/root-activate-reviewed.py')
s=importlib.util.spec_from_file_location('activation',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
r=m.ps(r"""$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};
$s=Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:9600/v1/host/state';
$o.deployments=@($s.deployments|Select-Object id,status,reason);
$v=Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:8091/vms';
$o.vms=@($v.vms|Select-Object id,name,status,recovered,vmState,reason);
$o|ConvertTo-Json -Depth 5 -Compress""")
pathlib.Path('work/nucbox-ram96-20261023/apps-recovery.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
