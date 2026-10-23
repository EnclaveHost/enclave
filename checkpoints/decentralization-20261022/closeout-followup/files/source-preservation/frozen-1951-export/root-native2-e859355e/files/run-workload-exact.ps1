param([Parameter(Mandatory=$true)][string]$Kit)
$ErrorActionPreference='Stop'
$prefix='enclave-cpuwl-exact-20261023-'
$PD='C:\ProgramData\Enclave';$PF='C:\Program Files\Enclave'
$cfgText=Get-Content -LiteralPath (Join-Path $PD 'shield-config.cmd')
function V($k){$m=$cfgText|Select-String -Pattern ('^set '+[regex]::Escape($k)+'=(.*)$')|Select-Object -Last 1;if(-not $m){throw ('Missing '+$k)};$m.Matches[0].Groups[1].Value.Trim()}
function Hash($p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower()}
$manifest=Get-Content (Join-Path $Kit 'manifest.json') -Raw|ConvertFrom-Json
foreach($f in $manifest.files){if((Hash (Join-Path $Kit $f.path)) -ne $f.sha256){throw ('Pin changed '+$f.path)}}
if((V 'ENCLAVE_BOOT_FORM') -ne 'linux-direct'){throw 'Unexpected boot form'}
if(@(Get-VM|Where-Object {$_.Name.StartsWith($prefix)}).Count){throw 'Canary already exists'}
$before=@(Get-VM|Select-Object @{n='id';e={$_.Id.ToString()}},Name,@{n='state';e={$_.State.ToString()}})
$shield=@(Get-NetTCPConnection -LocalPort 8091 -State Listen);if($shield.Count -ne 1){throw 'Unexpected Shield listener'}
$os=Get-CimInstance Win32_OperatingSystem;if($os.FreePhysicalMemory -lt 16*1024*1024){throw 'Less than 16 GiB available'}
$out=Join-Path $Kit 'results';New-Item -ItemType Directory -Force -Path $out|Out-Null
if(Test-Path (Join-Path $out 'started.json')){throw 'This canary already started'}
$master=V 'ENCLAVE_GUEST_STATE_MASTER';$masterPin=(V 'ENCLAVE_GUEST_STATE_MASTER_SHA256').ToLower();if((Hash $master) -ne $masterPin){throw 'Guest state master changed'}
$pool=[int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors;if($pool -ne 16 -or [int](Get-VMHost).LogicalProcessorCount -lt $pool){throw 'Unexpected CPU pool'}
$cfg=[ordered]@{imagePath=(Join-Path $Kit 'runtime.bin');imageSha256='c1619eec104bf955b4d2540635c9e3b4d340528666f60a05c526083d45997591';boot='linux-direct';guestStateMaster=$master;guestStateMasterSha256=$masterPin;guestStateArchiveDir=(Join-Path $Kit 'vmgs-archive');hypervModule=(V 'ENCLAVE_HYPERV_MODULE');prefix=$prefix;wmiserveExe=(Join-Path $Kit 'shield-host.exe');wmiserveSha256='e4eeb994292dcd71653243da1e64d23988ec8a7f45f2b3742a517dda3d46feb2';bundleDir=(Join-Path $Kit 'bundles');componentPath=(Join-Path $Kit 'cpu-probe.wasm');componentSha256='5d8f8d195709fcc5320f49291b94d16ea5dc48c895ed44e7478ca076fed31d38';cpuPoolVcpus=$pool;burnMillions=4000;requestTimeoutMs=120000;guestReadySec=40;cases=@(@{share=0.0625;concurrency=1},@{share=0.01;concurrency=1},@{share=0.21;concurrency=4;expect=@{minSpeedup=2.2;maxSpeedup=5.5}})}
$cfgPath=Join-Path $Kit 'workload.json';[IO.File]::WriteAllText($cfgPath,($cfg|ConvertTo-Json -Depth 6 -Compress))
$receipt=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');shieldPid=$shield[0].OwningProcess;before=$before;initialFreeKiB=$os.FreePhysicalMemory;ok=$false}
$receipt|ConvertTo-Json -Depth 6|Set-Content (Join-Path $out 'started.json')
$child=$null;$reason=$null
try {
 $node=Join-Path $PF 'runtime\node\node.exe';$entry=Join-Path $Kit 'windows\vbslike\manager\ops\workload-canary.mjs'
 $child=Start-Process -FilePath $node -ArgumentList @($entry,$cfgPath) -WorkingDirectory $Kit -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $out 'workload.jsonl') -RedirectStandardError (Join-Path $out 'stderr.txt')
 $receipt.childPid=$child.Id;$start=[DateTime]::UtcNow;$minFree=[int64]$os.FreePhysicalMemory
 while(-not $child.WaitForExit(2000)){
  $free=[int64](Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory;$minFree=[Math]::Min($free,$minFree)
  if($free -lt 16*1024*1024){$reason='Physical RAM floor reached';break}
  if(([DateTime]::UtcNow-$start).TotalSeconds -gt 480){$reason='Canary deadline reached';break}
 }
 if($reason){& taskkill.exe /PID $child.Id /T /F|Out-Null;throw $reason}
 $child.Refresh();$receipt.exit=$child.ExitCode;$receipt.minFreeKiB=$minFree
 $steps=@(Get-Content (Join-Path $out 'workload.jsonl')|ForEach-Object {try{$_|ConvertFrom-Json}catch{}})
 $receipt.cases=@($steps|Where-Object {$_.step -eq 'case'})
 $one=@($receipt.cases|Where-Object {$_.share -eq 0.0625});$small=@($receipt.cases|Where-Object {$_.share -eq 0.01})
 $ratio=0;if($one.Count -eq 1 -and $small.Count -eq 1 -and $one[0].t1Ms -gt 0){$ratio=$small[0].t1Ms/$one[0].t1Ms}
 $receipt.onePercentSlowdown=$ratio
 $receipt.ok=($receipt.cases.Count -eq 3 -and @($receipt.cases|Where-Object {-not $_.ok}).Count -eq 0 -and $ratio -gt 3.5 -and $ratio -lt 12 -and @($steps|Where-Object {$_.step -eq 'result' -and $_.ok}).Count -eq 1)
}catch{$receipt.error=$_.Exception.Message;$receipt.ok=$false}
finally{
 if($child -and -not $child.HasExited){& taskkill.exe /PID $child.Id /T /F|Out-Null}
 $left=@(Get-VM|Where-Object {$_.Name.StartsWith($prefix)});$receipt.leftBeforeCleanup=$left.Count
 foreach($vm in $left){if(([string]$vm.Notes).StartsWith('enclave-vbslike-app-domain/manager|')){Stop-VM -VM $vm -TurnOff -Force -EA SilentlyContinue;Remove-VM -VM $vm -Force}}
 $after=@(Get-VM|Select-Object @{n='id';e={$_.Id.ToString()}},Name,@{n='state';e={$_.State.ToString()}})
 $receipt.after=$after;$receipt.leftAfter=@(Get-VM|Where-Object {$_.Name.StartsWith($prefix)}).Count
 $receipt.originalVmsUnchanged=(@(Compare-Object ($before|ForEach-Object {$_.id+':'+$_.state}) ($after|ForEach-Object {$_.id+':'+$_.state})).Count -eq 0)
 $current=@(Get-NetTCPConnection -LocalPort 8091 -State Listen);$receipt.shieldUnchanged=($current.Count -eq 1 -and $current[0].OwningProcess -eq $receipt.shieldPid)
 $receipt.ok=$receipt.ok -and $receipt.originalVmsUnchanged -and $receipt.shieldUnchanged -and ($receipt.leftAfter -eq 0)
 $receipt.finishedAt=(Get-Date).ToUniversalTime().ToString('o');$receipt|ConvertTo-Json -Depth 8|Set-Content (Join-Path $out 'result.json');$receipt|ConvertTo-Json -Depth 8 -Compress
}
