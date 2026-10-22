# READ-ONLY minipc probe for hs2 activation prep: headroom, the five stage ports, task/receipt state, data dir counts and
# the sshd forwarding settings (those lines only). No key, env, DB, secret or private artifact is read; nothing changes.
import subprocess, base64, json, pathlib, datetime
P = pathlib.Path(__file__).resolve().parent
script = r'''$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$o=[ordered]@{}
$os=Get-CimInstance Win32_OperatingSystem;$o.freeRamMiB=[int][math]::Floor($os.FreePhysicalMemory/1024)
$disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'";$o.freeDiskMiB=[int][math]::Floor($disk.FreeSpace/1MB)
$ports=@(18188,18189,18153,18154,18190)
$o.tcpListenOnStagePorts=[int]@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$ports -contains $_.LocalPort}).Count
$o.udpOnStagePorts=[int]@(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object {$ports -contains $_.LocalPort}).Count
$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2' -ErrorAction SilentlyContinue
if($t){$i=$t|Get-ScheduledTaskInfo;$o.taskState=[string]$t.State;$o.taskRealTriggers=[int]@($t.Triggers|Where-Object {$_ -ne $null}).Count;$o.taskLastRun=[string]$i.LastRunTime.ToUniversalTime().ToString('o');$o.taskLastResult=[int]$i.LastTaskResult;$o.taskPrincipal=[string]$t.Principal.UserId}else{$o.taskState='absent'}
$cfg='C:\ProgramData\Enclave\host-services\hs2\config';$data='C:\ProgramData\Enclave\host-services\hs2\data';$state='C:\ProgramData\Enclave\host-services\hs2\state'
$r=Join-Path $cfg 'install-receipt.txt';if(Test-Path -LiteralPath $r){$o.receiptLast=[string](@(Get-Content -LiteralPath $r)[-1]);$o.receiptSha256=(Get-FileHash -LiteralPath $r -Algorithm SHA256).Hash.ToLower()}
foreach($f in 'host-services.json','supervisor.json'){$p=Join-Path $cfg $f;if(Test-Path -LiteralPath $p){$o[$f]=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()}}
$m=Join-Path $data 'bootstrap-manifest.json';if(Test-Path -LiteralPath $m){$o.manifestSha256=(Get-FileHash -LiteralPath $m -Algorithm SHA256).Hash.ToLower()}
foreach($k in @(@('artifacts',(Join-Path $data 'artifacts')),@('policyImport',(Join-Path $data 'policy-import')),@('state',$state))){if(Test-Path -LiteralPath $k[1]){$o[$k[0]+'Files']=[int]@(Get-ChildItem -LiteralPath $k[1] -File -Recurse -ErrorAction SilentlyContinue).Count}else{$o[$k[0]+'Files']=-1}}
$o.hs2NodeProcesses=[int]@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -like '*host-services\hs2*'}).Count
$o.supervisorProcesses=[int]@(Get-Process -Name hostsvc-supervisor -ErrorAction SilentlyContinue).Count
$n='C:\Program Files\nodejs\node.exe';if(Test-Path -LiteralPath $n){$o.node=[string](& $n --version)}
$sc='C:\ProgramData\ssh\sshd_config';if(Test-Path -LiteralPath $sc){$o.sshdForwardingLines=[string]((Get-Content -LiteralPath $sc | Where-Object {$_ -match '^\s*#?\s*(AllowTcpForwarding|DisableForwarding|PermitListen|GatewayPorts)'}) -join ' | ')}else{$o.sshdForwardingLines='no sshd_config'}
$pr=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent());$o.sessionElevated=[bool]$pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$o.at=[DateTime]::UtcNow.ToString('o')
'RESULT '+($o|ConvertTo-Json -Compress)'''
watch = r'''$ownerPid=$PID;$watchCode='$p=[Diagnostics.Process]::GetProcessById('+[string]$ownerPid+');$p.WaitForExit(90000)|Out-Null;if(!$p.HasExited){$p.Kill()}';$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watchCode));$watcher=Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -WindowStyle Hidden -PassThru;try {'''
enc = base64.b64encode((watch + script + '} finally {if(!$watcher.HasExited){$watcher.Kill()}}').encode('utf-16le')).decode()
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', enc], capture_output=True, text=True, timeout=110)
o = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exit': r.returncode, 'stderr': r.stderr[-600:]}
try: o['probe'] = json.loads(next(x[7:] for x in r.stdout.splitlines() if x.startswith('RESULT ')))
except Exception as e: o['parseError'] = str(e)[:200]; o['stdoutTail'] = r.stdout[-600:]
(P / 'probe-minipc.json').write_text(json.dumps(o, indent=1) + '\n'); print(json.dumps(o, indent=1))
