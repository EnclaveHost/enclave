#!/usr/bin/env python3
"""READ-ONLY preflight on minipc for the per-cron respawn correction. Never prints a config file or a command line:
  - respawn settings ONLY: lines of node-config.cmd / node-config.local.cmd matching
    ^\\s*set\\s+ENCLAVE_ISOLATION_RESPAWN(_IDS|_DELAY_MS)?=, each value returned only if it is strictly a list of public
    deployment ids, a decimal delay or "0"/"1"; anything else is reported as malformed WITHOUT its value
  - files: sha256 (+ SDDL owner/ACL summary for the local file and its directory), line counts by class
  - task \\Enclave\\Node: state, action Execute, and only WHETHER its Arguments are exactly /c "<PD>\\run-node.cmd"
  - processes: the run-node cmd.exe and its agent.mjs node.exe (PID, start), the 8091 manager (PID, start); booleans for
    command-line matches, never the lines
  - manager VM inventory (id, name, status) and the node agent's deployment statuses (public ids, status, leaseUntil)
Transport: ../probe.py ps() (watchdog, -EncodedCommand, JSON only). Prints one JSON document."""
import json, sys, importlib.util, os, time
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, '..', 'probe.py')).read().split("LOGS = r")[0]
ns = {}; exec(compile(src, 'probe.py', 'exec'), ns); ps = ns['ps']
PD, PF = r"C:\ProgramData\Enclave", r"C:\Program Files\Enclave"
SHA = "function Sha($f){if(Test-Path -LiteralPath $f){(Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower()}else{'absent'}};"
out = {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
# 1. respawn settings (strictly parsed), line classes, hashes
out['config'] = ps(SHA + r"""
$o=[ordered]@{};foreach($n in @('node-config.cmd','node-config.local.cmd')){$p=Join-Path 'PDX' $n;$r=[ordered]@{sha=(Sha $p)};
if(Test-Path -LiteralPath $p){$ls=@(Get-Content -LiteralPath $p);$r.lines=$ls.Count;$s=@();$oth=0;$cm=0;
foreach($l in $ls){if($l -match '^\s*set\s+ENCLAVE_ISOLATION_RESPAWN(_IDS|_DELAY_MS)?=(.*)$'){$k='ENCLAVE_ISOLATION_RESPAWN'+$matches[1];$v=$matches[2].Trim();
$ok=switch($matches[1]){'_IDS'{$v -match '^(0x[0-9a-fA-F]{64})(,0x[0-9a-fA-F]{64})*$'}'_DELAY_MS'{$v -match '^[0-9]{1,7}$'}default{$v -match '^[01]?$'}};
$s+=,([ordered]@{key=$k;value=$(if($ok){$v}else{$null});malformed=(-not $ok)})}elseif($l -match '^\s*(@echo off|rem\b|$)'){$cm++}else{$oth++}};
$r.respawn=$s;$r.otherSettingLines=$oth;$r.commentLines=$cm;$r.callsLocal=[bool]($ls -match 'node-config\.local\.cmd')};$o[$n]=$r};
$o.runNodeSha=(Sha (Join-Path 'PDX' 'run-node.cmd'));$o.runShieldSha=(Sha (Join-Path 'PDX' 'run-shield.cmd'));
$o.localAcl=$(if(Test-Path -LiteralPath (Join-Path 'PDX' 'node-config.local.cmd')){(Get-Acl -LiteralPath (Join-Path 'PDX' 'node-config.local.cmd')).Sddl}else{$null});
$o.dirAcl=(Get-Acl -LiteralPath 'PDX').Sddl;$o|ConvertTo-Json -Compress -Depth 5""".replace('PDX', PD).replace('\n', ''), 120)
# 2. pinned live code hashes
out['code'] = ps(SHA + ("$m='%s\\control\\windows';$o=[ordered]@{};foreach($f in @('node\\agent.mjs','node\\host.mjs','node\\shield-secrets.mjs','node\\host-admission-runtime.mjs',"
    "'vbslike\\manager\\wmiserve-run.mjs','vbslike\\manager\\server.mjs','vbslike\\manager\\main.mjs')){$o[$f]=(Sha (Join-Path $m $f))};$o|ConvertTo-Json -Compress") % PF, 120)
# 3. task + processes (booleans for command lines)
out['processes'] = ps(r"""
$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node';$a=$t.Actions[0];$want='/c "PDX\run-node.cmd"';
$cm=@(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -OperationTimeoutSec 20|Where-Object{[string]$_.CommandLine -like '*\Enclave\run-node.cmd*'});
$nd=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20|Where-Object{[string]$_.CommandLine -like '*\control\windows\node\agent.mjs*'});
$c=@(Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue);$mg=$(if($c.Count -eq 1){Get-CimInstance Win32_Process -Filter "ProcessId=$($c[0].OwningProcess)" -OperationTimeoutSec 20}else{$null});
$ts=@(Get-ScheduledTask -TaskPath '\Enclave\'|ForEach-Object{[ordered]@{name=$_.TaskName;state=[string]$_.State}});
[ordered]@{nodeTask=[ordered]@{state=[string]$t.State;execute=[string]$a.Execute;argumentsExact=([string]$a.Arguments -eq $want);triggers=@($t.Triggers|ForEach-Object{$_.CimClass.CimClassName})};
runNodeCmd=@($cm|ForEach-Object{[ordered]@{pid=$_.ProcessId;start=$_.CreationDate.ToUniversalTime().ToString('o');parent=$_.ParentProcessId}});
agent=@($nd|ForEach-Object{[ordered]@{pid=$_.ProcessId;start=$_.CreationDate.ToUniversalTime().ToString('o');parent=$_.ParentProcessId;parentIsRunNode=(@($cm.ProcessId) -contains $_.ParentProcessId)}});
manager=$(if($mg){[ordered]@{pid=$mg.ProcessId;start=$mg.CreationDate.ToUniversalTime().ToString('o');isManagerMain=([string]$mg.CommandLine -like '*\vbslike\manager\main.mjs*')}}else{[ordered]@{listeners=$c.Count}});
tasks=$ts}|ConvertTo-Json -Compress -Depth 4""".replace('PDX', PD).replace('\n', ''), 120)
# 4. VM inventory + node deployment statuses (public)
out['inventory'] = ps(r"""
$v=(Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:8091/vms').vms;$d=Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:9600/v1/deployments';
$all=@($d.deployments);if(-not $all){$all=@($d)};
[ordered]@{vms=@($v|ForEach-Object{[ordered]@{id=[string]$_.id;name=[string]$_.name;status=[string]$_.status;recovered=[bool]$_.recovered}});
deployments=@($all|ForEach-Object{[ordered]@{id=[string]$_.id;status=[string]$_.status;leaseUntil=$_.leaseUntil;held=[string]$_.reason -like '*held*'}})}|ConvertTo-Json -Compress -Depth 4""".replace('\n', ''), 120)
print(json.dumps(out, indent=1))
