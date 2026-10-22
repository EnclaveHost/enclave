#!/usr/bin/env python3
# READ-ONLY verification of the minipc hs2 host-services installation (the installer already ran: install-host-services.py;
# its postcheck falsely failed on @($null).Count = 1). Nothing is installed, started, changed or re-run:
#   - the receipt C:\ProgramData\Enclave\host-services\hs2\config\install-receipt.txt read with [IO.File]::ReadAllText;
#     its last line must be 'complete'; EVERY 'file <sha256> <path>' entry is hashed now (Get-FileHash) and compared;
#   - the scheduled task \Enclave\enclave-host-services-hs2: State, REAL trigger count
#     (@($t.Triggers | Where-Object {$null -ne $_}).Count), actions, principal, and Get-ScheduledTaskInfo run history
#     (never run = LastTaskResult 267011 / 0x41303 and a LastRunTime before 2000);
#   - no node.exe process whose command line names host-services\hs2.
# Output: primitive values only (no PSProvider objects). A watchdog kills the remote shell after 90 s or above 1 GiB.
# Writes host-services-install-result.json. Run through the queue (256).
import subprocess, base64, pathlib, json, datetime
P = pathlib.Path(__file__).resolve().parent
script = r'''$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$rcptPath='C:\ProgramData\Enclave\host-services\hs2\config\install-receipt.txt'
$rcptText=[IO.File]::ReadAllText($rcptPath)
$rcptSha=(Get-FileHash -LiteralPath $rcptPath -Algorithm SHA256).Hash.ToLower()
$rcptLines=@($rcptText -split "`r?`n" | Where-Object {$_ -ne ''})
$lastLine=[string]$rcptLines[$rcptLines.Count-1]
$kinds=@{};$fileEntries=0;$hashOk=0;$mism=New-Object System.Collections.Generic.List[string];$absent=New-Object System.Collections.Generic.List[string]
foreach($ln in $rcptLines){
  $kind=[string](($ln -split ' ')[0]);if($kinds.ContainsKey($kind)){$kinds[$kind]=$kinds[$kind]+1}else{$kinds[$kind]=1}
  if($ln -match '^file ([0-9a-f]{64}) (.+)$'){
    $wantSha=[string]$Matches[1];$filePath=[string]$Matches[2];$fileEntries++
    if(-not [IO.File]::Exists($filePath)){$absent.Add($filePath)}
    else{$gotSha=(Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLower();if($gotSha -eq $wantSha){$hashOk++}else{$mism.Add($filePath)}}
  }
}
$tk=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2'
$realTriggers=@($tk.Triggers | Where-Object {$null -ne $_}).Count
$naiveTriggers=@($tk.Triggers).Count
$ti=Get-ScheduledTaskInfo -InputObject $tk
$acts=@($tk.Actions | Where-Object {$null -ne $_} | ForEach-Object {([string]$_.Execute)+' '+([string]$_.Arguments)})
$hs2Procs=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$null -ne $_.CommandLine -and $_.CommandLine -like '*host-services\hs2*'}).Count
$kindText=(@($kinds.Keys | Sort-Object | ForEach-Object {$_+'='+[string]$kinds[$_]}) -join ',')
$res=@{receiptPath=[string]$rcptPath;receiptSha256=[string]$rcptSha;receiptLines=[int]$rcptLines.Count;receiptLast=[string]$lastLine;receiptLineKinds=[string]$kindText;
  fileEntries=[int]$fileEntries;fileHashesMatch=[int]$hashOk;fileMismatches=[string]($mism -join '|');fileAbsent=[string]($absent -join '|');
  task=[string]$tk.TaskName;taskPath=[string]$tk.TaskPath;state=[string]$tk.State;realTriggers=[int]$realTriggers;naiveTriggerCount=[int]$naiveTriggers;
  actions=[string]($acts -join ' || ');principal=[string]$tk.Principal.UserId;runLevel=[string]$tk.Principal.RunLevel;
  lastRunTime=[string]$ti.LastRunTime.ToUniversalTime().ToString('o');lastRunYear=[int]$ti.LastRunTime.Year;lastTaskResult=[int64]$ti.LastTaskResult;
  nextRunTime=[string]$(if($ti.NextRunTime){$ti.NextRunTime.ToUniversalTime().ToString('o')}else{''});missedRuns=[int]$ti.NumberOfMissedRuns;
  hs2NodeProcesses=[int]$hs2Procs;at=[string][DateTime]::UtcNow.ToString('o')}
'RESULT '+($res|ConvertTo-Json -Compress)
'''
watch = r'''$ownerPid=$PID;$watchCode='$p=[Diagnostics.Process]::GetProcessById('+[string]$ownerPid+');$end=[DateTime]::UtcNow.AddSeconds(90);while(!$p.HasExited -and [DateTime]::UtcNow -lt $end){$p.Refresh();if($p.WorkingSet64 -gt 1GB){break};Start-Sleep -Milliseconds 500};if(!$p.HasExited){$p.Kill()}';$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watchCode));$watcher=Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -WindowStyle Hidden -PassThru;try {'''
enc = base64.b64encode((watch + script + '} finally {if(!$watcher.HasExited){$watcher.Kill()}}').encode('utf-16le')).decode()
r = subprocess.run(['ssh', '-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
                   capture_output=True, text=True, timeout=120)
(P / 'host-services-verify.log').write_text(r.stdout + r.stderr)
line = next((x[7:] for x in r.stdout.splitlines() if x.startswith('RESULT ')), None)
if r.returncode != 0 or not line:
    print(f'verification did not complete: rc={r.returncode}\n{r.stderr[-1500:]}'); raise SystemExit(1)
d = json.loads(line)
never_run = d['lastTaskResult'] == 267011 and d['lastRunYear'] < 2000
ok = (d['receiptLast'] == 'complete' and d['fileEntries'] > 0 and d['fileHashesMatch'] == d['fileEntries'] and not d['fileMismatches'] and not d['fileAbsent']
      and d['state'] == 'Ready' and d['realTriggers'] == 0 and never_run and d['hs2NodeProcesses'] == 0)
d['neverRun'] = never_run
d['status'] = 'INSTALLED_NOT_STARTED' if ok else 'NOT_VERIFIED'
d['note'] = ('the installer completed; its root postcheck failed only because @($t.Triggers).Count counts a $null as 1 '
             f'(naive count {d["naiveTriggerCount"]}, real triggers {d["realTriggers"]}). This verification is read-only: nothing was re-run, started or changed.')
d['verifiedBy'] = {'script': 'work/resume-20261021/verify-host-services-install.py', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
(P / 'host-services-install-result.json').write_text(json.dumps(d, indent=2) + '\n')
print(json.dumps({k: d[k] for k in ['status', 'receiptLast', 'fileEntries', 'fileHashesMatch', 'state', 'realTriggers', 'naiveTriggerCount', 'neverRun', 'lastTaskResult', 'hs2NodeProcesses']}))
