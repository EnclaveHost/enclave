#!/usr/bin/env python3
"""Activate the saved 96 GiB setting, ONLY after the human releases the restart.
Default: print the exact proposed steps without contacting the machine.
--execute --step NAME: execute ONE reviewed step, then inspect its receipt.
Run preflight, stop, start-shield, start-node in that order after human release.
It never reboots the host, stops VMs, deploys code or changes private config.
"""
import argparse, importlib.util, json, pathlib, sys, datetime
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parent.parent
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--execute',action='store_true')
p.add_argument('--step',choices=['preflight','stop','start-shield','start-node'])
a=p.parse_args()
expected=json.loads((HERE/'configured.json').read_text())
if 'configured' not in expected: raise SystemExit('No verified saved configuration receipt')
checks=';'.join("if((FileSha '%s') -ne '%s'){throw 'Saved configuration changed; review before restart'}"%(x['file'],x['afterSha']) for x in expected['configured'])
COMMON=r'''
$ErrorActionPreference='Stop';
function CheckTasks {
 foreach($n in @('Node','Shield')) {
  $t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $n;
  $acts=@($t.Actions);$want='/c "C:\ProgramData\Enclave\run-'+$n.ToLower()+'.cmd"';
  if($acts.Count -ne 1 -or $acts[0].Execute -ne 'cmd.exe' -or $acts[0].Arguments -ne $want){throw "Unexpected scheduled task action for $n"}
 }
}
function State {
 $ts=@(foreach($n in @('Node','Shield')){$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $n;@{name=$n;state=$t.State.ToString()}});
 $ls=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object {$_.LocalPort -in @(8091,9600)}|Select-Object LocalAddress,LocalPort,OwningProcess);
 @{tasks=$ts;listeners=$ls;at=(Get-Date).ToUniversalTime().ToString('o')}
}
'''
preflight=COMMON+checks+r''';try {CheckTasks;$v=@(Get-VM|ForEach-Object {@{name=$_.Name;state=$_.State.ToString();memory=$_.MemoryAssigned}});$os=Get-CimInstance Win32_OperatingSystem;$free=[int64]$os.FreePhysicalMemory*1024;
# A conservative bound for resizing existing cpu-share app VMs: the 2 GiB floor may hide shares.
$growth=0L;foreach($x in $v){if($x.name -like 'enclave-app-*' -and $x.memory -gt 512MB){$m=[long]($x.memory/1MB);$next=[math]::Max(2048,[math]::Ceiling(($m-640)*1.5)+640);$growth+=[long][math]::Max(0,$next-$m)*1MB}}
if($free -lt ($growth+8GB)){throw 'Insufficient free physical memory for conservative app regrowth plus 8 GiB headroom'};
@{ok=$true;state=(State);freeBytes=$free;estimatedGrowthUpperBoundBytes=$growth;vms=$v}|ConvertTo-Json -Depth 6 -Compress}catch{@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress}'''
# Stop scheduled wrappers, not only child processes: config loads BEFORE their :loop labels.
stop=COMMON+checks+r''';try {CheckTasks;foreach($n in @('Node','Shield')){Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName $n};@{ok=$true;action='stop requested';state=(State)}|ConvertTo-Json -Depth 6 -Compress}catch{@{ok=$false;error=$_.Exception.Message;state=(State)}|ConvertTo-Json -Depth 6 -Compress}'''
# A separately invoked step refuses to start a second instance while either task/listener survives.
start_shield=COMMON+checks+r''';try {CheckTasks;$s=State;if(@($s.listeners).Count -ne 0 -or @($s.tasks|Where-Object {$_.state -eq 'Running'}).Count -ne 0){throw 'Old task or listener still present; no duplicate instance started'};Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Shield';@{ok=$true;action='Shield start requested';state=(State)}|ConvertTo-Json -Depth 6 -Compress}catch{@{ok=$false;error=$_.Exception.Message;state=(State)}|ConvertTo-Json -Depth 6 -Compress}'''
start_node=COMMON+checks+r''';try {CheckTasks;$s=State;$ls=@($s.listeners|Where-Object {$_.LocalPort -eq 8091});if($ls.Count -ne 1 -or @($s.listeners|Where-Object {$_.LocalPort -eq 9600}).Count -ne 0){throw 'Expected one Shield listener and no Node listener'};if((Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node').State -eq 'Running'){throw 'Node wrapper already running; no duplicate started'};$h=Invoke-RestMethod 'http://127.0.0.1:8091/health' -TimeoutSec 5;if($h.memory.poolMiB -ne 98304){throw 'Shield has not loaded the 96 GiB pool'};Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node';@{ok=$true;action='Node start requested';state=(State)}|ConvertTo-Json -Depth 6 -Compress}catch{@{ok=$false;error=$_.Exception.Message;state=(State)}|ConvertTo-Json -Depth 6 -Compress}'''
steps={'preflight':preflight,'stop':stop,'start-shield':start_shield,'start-node':start_node}
if not a.execute:
 print(json.dumps({'status':'prepared only; human restart decision still required','steps':steps,'verification':'After each step inspect task/listener state. Before starting Node, require Shield /health.memory.poolMiB=98304. After start require /availability.nodeRamGb=96 and manager pool98304; inspect all app recovery before declaring complete.'},indent=2))
 sys.exit(0)
if not a.step: raise SystemExit('--execute requires one explicit --step; no action taken')
last_path=HERE/'activation-last.json'
prior={'stop':'preflight','start-shield':'stop','start-node':'start-shield'}
if a.step in prior:
 last=json.loads(last_path.read_text()) if last_path.exists() else {}
 if last.get('step') != prior[a.step] or last.get('result',{}).get('ok') is not True:
  raise SystemExit('Missing successful preceding step; no action taken')
 if (datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(last['checkedAt'])).total_seconds()>300:
  raise SystemExit('Preceding receipt is stale; inspect state before continuing; no action taken')
spec=importlib.util.spec_from_file_location('nucbox_ps',ROOT/'work/nucbox-tls-20261021/root-activate-reviewed.py')
helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
result=helper.ps(steps[a.step],35)
receipt={'step':a.step,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'result':result}
# Preserve failures separately: a failed start check must not erase the last successful step.
name='activation-'+a.step+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json'
(HERE/name).write_text(json.dumps(receipt,indent=2)+'\n')
if result.get('ok') is True: last_path.write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
raise SystemExit(0 if result.get('ok') is True else 1)
