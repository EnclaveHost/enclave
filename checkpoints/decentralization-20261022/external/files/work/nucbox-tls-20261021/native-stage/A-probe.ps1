$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(120);while(-not $t.WaitForExit(2000)){$t.Refresh();if($t.PrivateMemorySize64 -gt 512MB -or (Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o')}
$os=Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 20;$o.freeMiB=[int]($os.FreePhysicalMemory/1024);$o.commitFreeMiB=[int]($os.FreeVirtualMemory/1024);$o.diskCFreeGiB=[math]::Round((Get-PSDrive C).Free/1GB,1)
function FileSha($f){if(Test-Path -LiteralPath $f){(Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower()}else{'absent'}}
$M='C:\Program Files\Enclave\control\windows\vbslike\manager'
$o.live=[ordered]@{};foreach($n in 'wmiserve-run.mjs','server.mjs','wmi-launcher.mjs','main.mjs','backend.mjs'){$o.live[$n]=FileSha "$M\$n"}
$L='C:\ProgramData\Enclave\hotfix\enclavedns-liveness-20261021'
$o.stagedLiveness=@(if(Test-Path -LiteralPath $L){Get-ChildItem -LiteralPath $L -File|ForEach-Object{$_.Name+' '+(FileSha $_.FullName)}})
$c=@(Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue);$o.listeners8091=$c.Count
if($c.Count){$mp=[int]$c[0].OwningProcess;$p=Get-CimInstance Win32_Process -Filter "ProcessId=$mp" -OperationTimeoutSec 20
$o.mgr=[ordered]@{pid=$mp;exe=[string]$p.ExecutablePath;scriptIsManagerMain=[bool]([string]$p.CommandLine -like "*\control\windows\vbslike\manager\main.mjs*");started=$p.CreationDate.ToUniversalTime().ToString('o');parentPid=[int]$p.ParentProcessId}
$pp=Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -OperationTimeoutSec 20
$o.mgrParent=[ordered]@{name=[string]$pp.Name;isRunShieldLoop=[bool]([string]$pp.CommandLine -like '*run-shield.cmd*')}
$o.nodeVersion=[string](& $p.ExecutablePath --version)}
$rs='C:\ProgramData\Enclave\run-shield.cmd'
$o.runShield=@(if(Test-Path -LiteralPath $rs){Get-Content -LiteralPath $rs|ForEach-Object{if($_ -match '(?i)^\s*call '){'call <config>'}else{$_ -replace '(?i)(key|token|secret|password)=\S+','$1=<redacted>'}}})
$S='C:\ProgramData\Enclave\hotfix\nucbox-stopfix-20261021'
if(Test-Path -LiteralPath $S){$o.staging='REFUSED: exists'}else{foreach($d in '','fixed','fixed\testdata','mut','mut\testdata','tmp','results'){New-Item -ItemType Directory -Path (Join-Path $S $d)|Out-Null};Copy-Item -LiteralPath "$M\wmiserve-run.mjs" -Destination "$S\mut\wmiserve-run.mjs";$o.staging='created';$o.mutCopy=FileSha "$S\mut\wmiserve-run.mjs"}
$o|ConvertTo-Json -Depth 4 -Compress
