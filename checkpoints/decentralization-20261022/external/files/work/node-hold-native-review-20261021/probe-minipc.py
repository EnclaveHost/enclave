#!/usr/bin/env python3
# Read-only, bounded (100 s remote watchdog). minipc:
#   1. sha256 + version of the deployed circuit binaries and node.exe;
#   2. names/sizes of the network logs;
#   3. ONLY log lines matching cleanup/panic patterns (each cut to 300 chars), with line numbers.
# Writes nothing remotely. No config, key or other log content.
import base64, subprocess, sys
script = r'''
$ErrorActionPreference='Continue'
foreach($p in @('C:\Program Files\Enclave\network\enclave-circuit-firewall.exe','C:\Program Files\Enclave\network\enclave-wg.exe','C:\Program Files\nodejs\node.exe')){
  if(Test-Path -LiteralPath $p){$i=Get-Item -LiteralPath $p;'HASH '+(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()+' '+$i.Length+' '+$i.LastWriteTimeUtc.ToString('o')+' '+$p}else{'MISSING '+$p}}
'NODEVERSION '+(& 'C:\Program Files\nodejs\node.exe' --version)
Get-ChildItem -LiteralPath 'C:\ProgramData\Enclave\logs' -Filter 'network*' | ForEach-Object { 'LOG '+$_.Name+' '+$_.Length+' '+$_.LastWriteTimeUtc.ToString('o') }
'SANDBOXPROCS '+@(Get-Process -Name 'enclave-circuit-firewall' -ErrorAction SilentlyContinue).Count
foreach($f in @(Get-ChildItem -LiteralPath 'C:\ProgramData\Enclave\logs' -Filter 'network*.log*' | Sort-Object LastWriteTimeUtc)){
  'FILE '+$f.Name
  Select-String -LiteralPath $f.FullName -Pattern '(circuit cleanup:|^panic: |^main\.noCircuitProcesses|^main\.removeCircuit|stop circuit processes|could not verify matching process|sandboxed worker exited)' |
    Select-Object -Last 120 | ForEach-Object { $t=$_.Line; if($t.Length -gt 300){$t=$t.Substring(0,300)}; 'L'+$_.LineNumber+' '+$t }
}
'''
watch = r'''$ownerPid=$PID;$watchCode='$p=[Diagnostics.Process]::GetProcessById('+[string]$ownerPid+');$p.WaitForExit(100000)|Out-Null;if(!$p.HasExited){$p.Kill()}';$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watchCode));$watcher=Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -WindowStyle Hidden -PassThru;try {'''
enc = base64.b64encode((watch + script + '} finally {if(!$watcher.HasExited){$watcher.Kill()}}').encode('utf-16le')).decode()
r = subprocess.run(['ssh', '-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', enc], capture_output=True, text=True, timeout=130)
print(r.stdout); print('EXIT', r.returncode, r.stderr[-400:], file=sys.stderr)
