import importlib.util,json,pathlib
p=pathlib.Path('work/nucbox-tls-20261021/root-activate-reviewed.py').resolve();s=importlib.util.spec_from_file_location('transport',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
r=m.ps(r"""$id='0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c';$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};
if((FileSha 'C:\Program Files\Enclave\control\windows\vbslike\manager\wmiserve-run.mjs') -ne '8107f272741c40a3d6ea51c0054d5fdc0904cd277346265cd01ca9de1c74ed17'){throw 'manager pin changed; no retry'};
$s=Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:9600/v1/host/state';$d=@($s.deployments|Where-Object {$_.id -eq $id});
if($d.Count -ne 1 -or $d[0].status -ne 'failed' -or $d[0].reason -notmatch 'partition is Starting: it stopped by itself'){throw 'failure state changed; no retry'};
$v=Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:8091/vms';if(@($v.vms|Where-Object {$_.name -eq $id}).Count -ne 0){throw 'a VM exists; no retry'};
$o.before=$d|Select-Object id,status,reason;
$body=@{id=$id;force=$true;enclave='nucbox-k11-4'}|ConvertTo-Json -Compress;
try{$r=Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 180 'http://127.0.0.1:9600/v1/claim-hint';$o.reply=$r|Select-Object accepted,reason,id,status}catch{$o.error=$_.Exception.Message};
$v=Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:8091/vms';$o.after=@($v.vms|Where-Object {$_.name -eq $id}|Select-Object id,name,status,recovered,reason);
$o|ConvertTo-Json -Depth 5 -Compress""",secs=220)
pathlib.Path(__file__).with_suffix('.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
