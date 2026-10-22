import importlib.util,json,pathlib
p=pathlib.Path(__file__).with_name('root-activate-reviewed.py');s=importlib.util.spec_from_file_location('activation',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ps=r"""$id='0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a';$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};
if((FileSha 'C:\Program Files\Enclave\control\windows\vbslike\manager\wmiserve-run.mjs') -ne '8107f272741c40a3d6ea51c0054d5fdc0904cd277346265cd01ca9de1c74ed17'){throw 'manager fix absent'};
$v=Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:8091/vms';$d=@($v.vms|Where-Object {$_.name -eq $id});
if($d.Count -ne 1 -or $d[0].id -ne 'hv4a283a1be6a20e310139992d9d19ef8b' -or $d[0].recovered -ne $true -or $d[0].status -ne 'starting'){throw 'recovered publisher changed; no action'};
$o.before=@($d|Select-Object id,name,status,recovered);
$body=@{id=$id;force=$true;enclave='nucbox-k11-4'}|ConvertTo-Json -Compress;
try{$r=Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 180 'http://127.0.0.1:9600/v1/claim-hint';$o.reply=$r|Select-Object accepted,reason,id,status}catch{$o.error=$_.Exception.Message};
$v=Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:8091/vms';$o.after=@($v.vms|Where-Object {$_.name -eq $id}|Select-Object id,name,status,recovered,reason);
$o|ConvertTo-Json -Depth 5 -Compress"""
r=m.ps(ps,secs=220);p.with_name('root-recover-publisher.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
