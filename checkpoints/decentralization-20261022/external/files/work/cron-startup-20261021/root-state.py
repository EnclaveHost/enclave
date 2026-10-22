import importlib.util,json,pathlib
p=pathlib.Path('work/nucbox-tls-20261021/root-activate-reviewed.py').resolve();s=importlib.util.spec_from_file_location('transport',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
r=m.ps(r"""$id='0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c';$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};
$s=Invoke-RestMethod -TimeoutSec 15 'http://127.0.0.1:9600/v1/host/state';
$o.deployments=@($s.deployments|Where-Object {$_.id -eq $id}|Select-Object id,status,reason);
$v=Invoke-RestMethod -TimeoutSec 15 'http://127.0.0.1:8091/vms';
$o.vms=@($v.vms|Where-Object {$_.name -eq $id}|Select-Object id,name,status,recovered,vmState,reason);
$o|ConvertTo-Json -Depth 5 -Compress""",secs=80)
pathlib.Path(__file__).with_suffix('.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
