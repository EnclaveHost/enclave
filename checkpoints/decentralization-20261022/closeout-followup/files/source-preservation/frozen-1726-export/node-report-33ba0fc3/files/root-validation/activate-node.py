"""Exact-file, node-only activation. Requires a reviewed immutable release.json.
Steps: stage, preflight, stop-node, install, start-node, verify. No manager/VM control.
Each mutating step is explicit. Backups permit rollback of these exact files.
"""
import argparse,base64,datetime,hashlib,importlib.util,json,pathlib,subprocess
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[2]
s=importlib.util.spec_from_file_location('helper',ROOT/'work/nucbox-tls-20261021/root-activate-reviewed.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=argparse.ArgumentParser(description=__doc__);p.add_argument('step',choices=['stage','preflight','stop-node','install','start-node','verify','stop-for-rollback','rollback']);a=p.parse_args()
manifest=json.loads((HERE/'release.json').read_text())
assert manifest['reviewed'] is True
allowed={'windows/node/host.mjs','windows/node/chain.mjs','windows/node/isolation-client.mjs'}
assert set(manifest['files'])==allowed
repo=pathlib.Path(manifest['repo'])
assert subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()==manifest['commit']
assert not subprocess.check_output(['git','-C',str(repo),'status','--porcelain','--untracked-files=no'],text=True).strip()
stage=r'C:\ProgramData\Enclave\hotfix\coupled-shares-20261023'
control=r'C:\Program Files\Enclave\control'
rows=[]
for rel,v in manifest['files'].items():
 assert hashlib.sha256((repo/rel).read_bytes()).hexdigest()==v['after']
 assert len(v['before'])==len(v['after'])==64 and all(c in '0123456789abcdef' for c in v['before']+v['after'])
 rows.append(dict(rel=rel,live=control+'\\'+rel.replace('/','\\'),stage=stage+'\\'+pathlib.Path(rel).name,before=v['before'],after=v['after']))
data=base64.b64encode(json.dumps(rows).encode()).decode()
common=r'''$ErrorActionPreference='Stop';$rows=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('ROWS'))|ConvertFrom-Json);function State {$l=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object {$_.LocalPort -in @(9600,8091)});[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');nodeTask=(Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node').State.ToString();listeners=@($l|Select-Object LocalAddress,LocalPort,OwningProcess)}};function CheckTask {$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node';$x=@($t.Actions);if($x.Count -ne 1 -or $x[0].Execute -ne 'cmd.exe' -or $x[0].Arguments -ne '/c "C:\ProgramData\Enclave\run-node.cmd"'){throw 'Unexpected Node scheduled task'}};function CheckFiles($key){foreach($r in $rows){if((FileSha $r.live) -ne $r.$key){throw ('live source changed: '+$r.rel)}}};function Staged {foreach($r in $rows){if((FileSha $r.stage) -ne $r.after){throw ('staged source changed: '+$r.rel)};& 'C:\Program Files\Enclave\runtime\node\node.exe' --check $r.stage;if($LASTEXITCODE -ne 0){throw ('native syntax failed: '+$r.rel)}}};function Stopped {CheckTask;$s=State;if($s.nodeTask -eq 'Running' -or @($s.listeners|Where-Object {$_.LocalPort -eq 9600}).Count -ne 0){throw 'Node still active'};if(@($s.listeners|Where-Object {$_.LocalPort -eq 8091}).Count -ne 1){throw 'Shield listener changed'}};
'''.replace('ROWS',data)
last=HERE/'activation-last.json'
preflight_receipt=HERE/'activation-preflight-pinned.json'
requires={'preflight':'stage','stop-node':'preflight','install':'stop-node','start-node':'install','verify':'start-node'}
if a.step in requires:
 prior=json.loads(last.read_text())
 assert (prior['step']==requires[a.step] or (a.step=='verify' and prior['step']=='verify')) and prior['result'].get('ok') is True
 assert prior['commit']==manifest['commit']
 if a.step in ('stop-node','install','start-node'):
  age=datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(prior['at'])
  assert age.total_seconds()<600,'preceding receipt stale; inspect before proceeding'
if a.step in ('stop-node','install','start-node','verify'):
 baseline=json.loads(preflight_receipt.read_text())
 assert baseline['commit']==manifest['commit']
 shield=[x for x in baseline['result']['state']['listeners'] if x['LocalPort']==8091]
 assert len(shield)==1
 shield_pid=int(shield[0]['OwningProcess'])
 common+=f"$shieldNow=@((State).listeners|Where-Object {{$_.LocalPort -eq 8091}});if($shieldNow.Count -ne 1 -or $shieldNow[0].OwningProcess -ne {shield_pid}){{throw 'Shield restarted since preflight; inspect before proceeding'}};"
if a.step=='stage':
 r=m.ps("$p='"+stage+"';if(-not(Test-Path -LiteralPath $p)){New-Item -ItemType Directory -Path $p|Out-Null};@{ok=$true}|ConvertTo-Json -Compress",30)
 if not r.get('ok'):raise RuntimeError(r)
 for row in rows:
  subprocess.run(['scp','-o','BatchMode=yes','-o','ConnectTimeout=15',str(repo/row['rel']),'minipc:'+row['stage'].replace('\\','/')],check=True,timeout=45)
 body="CheckTask;CheckFiles 'before';Staged;@{ok=$true;state=(State)}"
elif a.step=='preflight':
 body=r'''CheckTask;CheckFiles 'before';Staged;$s=State;if(@($s.listeners|Where-Object {$_.LocalPort -eq 9600}).Count -ne 1 -or @($s.listeners|Where-Object {$_.LocalPort -eq 8091}).Count -ne 1){throw 'Expected Node and Shield listeners'};$h=Invoke-RestMethod -TimeoutSec 5 http://127.0.0.1:8091/health;if($h.memory.poolMiB -ne 98304){throw 'RAM pool changed'};$v=Invoke-RestMethod -TimeoutSec 8 http://127.0.0.1:8091/vms;@{ok=$true;state=$s;managerMemory=$h.memory;vms=@($v.vms|Select-Object id,name,status,memory)}'''
elif a.step=='stop-node':
 body="CheckTask;CheckFiles 'before';Staged;Stop-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'Node';@{ok=$true;state=(State)}"
elif a.step=='stop-for-rollback':
 body="CheckTask;CheckFiles 'after';Stop-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'Node';@{ok=$true;state=(State)}"
elif a.step=='install':
 body=r'''Stopped;CheckFiles 'before';Staged;foreach($r in $rows){$b=$r.live+'.pre-coupled-'+$r.before.Substring(0,12);if(Test-Path -LiteralPath $b){if((FileSha $b) -ne $r.before){throw 'Backup collision'}}else{Copy-Item -LiteralPath $r.live -Destination $b};if((FileSha $b) -ne $r.before){throw 'Backup failed'}};foreach($r in $rows){$t=$r.live+'.coupled-new';Copy-Item -LiteralPath $r.stage -Destination $t -Force;if((FileSha $t) -ne $r.after){throw 'Copy changed'};Move-Item -LiteralPath $t -Destination $r.live -Force};CheckFiles 'after';@{ok=$true;state=(State)}'''
elif a.step=='start-node':
 body="Stopped;CheckFiles 'after';Start-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'Node';@{ok=$true;state=(State)}"
elif a.step=='verify':
 body=r'''CheckFiles 'after';$a=Invoke-RestMethod -TimeoutSec 8 http://127.0.0.1:9600/availability;$h=Invoke-RestMethod -TimeoutSec 8 http://127.0.0.1:9600/v1/host/state;$v=Invoke-RestMethod -TimeoutSec 8 http://127.0.0.1:8091/vms;@{ok=$true;state=(State);availability=$a|Select-Object nodeRamGb,ramGbFree,ramMbFree,cpuShareFree,maxShare;deployments=@($h.deployments|Select-Object id,status,reason,cpuShare,memMb);vms=@($v.vms|Select-Object id,name,status,memory)}'''
else:
 body=r'''Stopped;foreach($r in $rows){$h=FileSha $r.live;if($h -ne $r.before -and $h -ne $r.after){throw ('Unexpected source; rollback refused '+$r.rel)};$b=$r.live+'.pre-coupled-'+$r.before.Substring(0,12);if((FileSha $b) -ne $r.before){throw 'Missing exact backup'}};foreach($r in $rows){$b=$r.live+'.pre-coupled-'+$r.before.Substring(0,12);Copy-Item -LiteralPath $b -Destination ($r.live+'.coupled-restore') -Force;Move-Item -LiteralPath ($r.live+'.coupled-restore') -Destination $r.live -Force};CheckFiles 'before';Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node';@{ok=$true;state=(State)}'''
script=common+'try {'+body+'|ConvertTo-Json -Depth 7 -Compress}catch{@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress}'
script_path=HERE/('step-'+a.step+'.ps1');script_path.write_text(script+'\n')
script_sha=hashlib.sha256(script_path.read_bytes()).hexdigest()
remote_script=stage+'\\step-'+a.step+'.ps1'
subprocess.run(['scp','-o','BatchMode=yes','-o','ConnectTimeout=15',str(script_path),'minipc:'+remote_script.replace('\\','/')],check=True,timeout=45)
r=m.ps("$p='"+remote_script+"';if((FileSha $p) -ne '"+script_sha+"'){throw 'Step script hash changed'};& ([ScriptBlock]::Create([IO.File]::ReadAllText($p)))",45)
rec={'step':a.step,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'commit':manifest['commit'],'result':r}
(HERE/('activation-'+a.step+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')).write_text(json.dumps(rec,indent=2)+'\n')
if r.get('ok'):last.write_text(json.dumps(rec,indent=2)+'\n')
if a.step=='preflight' and r.get('ok'):preflight_receipt.write_text(json.dumps(rec,indent=2)+'\n')
print(json.dumps(rec));raise SystemExit(0 if r.get('ok') else 1)
