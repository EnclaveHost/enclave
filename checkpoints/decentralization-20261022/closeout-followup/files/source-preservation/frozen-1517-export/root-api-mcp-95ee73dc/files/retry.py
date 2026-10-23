import importlib.util,json,pathlib,sys
ids={'a69dcbba':'0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77'}
short=sys.argv[1];ident=ids[short]
p=pathlib.Path('work/nucbox-tls-20261021/root-activate-reviewed.py');s=importlib.util.spec_from_file_location('activation',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ps=r"""$id='DEPLOYMENT';$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o');id=$id};
if((FileSha 'C:\Program Files\Enclave\control\windows\vbslike\manager\wmiserve-run.mjs') -ne '8107f272741c40a3d6ea51c0054d5fdc0904cd277346265cd01ca9de1c74ed17'){throw 'manager fix absent'};
$v=Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:8091/vms';
if(@($v.vms|Where-Object {$_.recovered -eq $true -or $_.unattributed -eq $true -or $_.name -eq $id}).Count -ne 0){throw 'reconciliation incomplete or target VM already exists; no retry'};
$s=Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:9600/v1/host/state';$d=@($s.deployments|Where-Object {$_.id -eq $id});
if($d.Count -ne 1 -or $d[0].status -ne 'failed' -or $d[0].reason -notlike '*did not become ready within 300000 ms (last status starting)*'){throw 'reviewed hold changed; no retry'};
$o.before=@($d|Select-Object id,status,reason);
$body=@{id=$id;force=$true;enclave='nucbox-k11-4'}|ConvertTo-Json -Compress;
try{$r=Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 180 'http://127.0.0.1:9600/v1/claim-hint';$o.reply=$r|Select-Object accepted,reason,id,status}catch{$o.error=$_.Exception.Message};
$v=Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:8091/vms';$o.after=@($v.vms|Where-Object {$_.name -eq $id}|Select-Object id,name,status,recovered,reason);
$o|ConvertTo-Json -Depth 5 -Compress""".replace('DEPLOYMENT',ident)
r=m.ps(ps,secs=220);pathlib.Path('work/api-mcp-recovery-20261023/retry.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
sys.exit(0 if r.get('reply',{}).get('accepted') is True else 1)
