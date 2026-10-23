param([Parameter(Mandatory=$true)][string]$Stage,[Parameter(Mandatory=$true)][ValidateSet('prepare','preflight','stop','install','start-shield','start-network','start-node','verify','rollback','rollback-start-shield','rollback-start-network','rollback-start-node')][string]$Step)
$ErrorActionPreference='Stop'
function Hash($f){if(Test-Path -LiteralPath $f){(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()}else{'absent'}}
$m=Get-Content (Join-Path $Stage 'manifest.json') -Raw|ConvertFrom-Json
if($m.stage -ne $Stage){throw 'Unexpected staging directory'}
$backup=Join-Path $Stage 'backup';$prepared=Join-Path $Stage 'prepared';$utf8=New-Object Text.UTF8Encoding($false)
function CheckTask($name){$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $name;$a=@($t.Actions);if($a.Count -ne 1 -or $a[0].Execute -ne 'cmd.exe' -or $a[0].Arguments -ne ('/c "C:\ProgramData\Enclave\run-'+$name.ToLower()+'.cmd"')){throw ('Unexpected task '+$name)}}
function State {$l=@(Get-NetTCPConnection -State Listen -EA SilentlyContinue|Where-Object {$_.LocalPort -in @(8091,9600)});@{at=(Get-Date).ToUniversalTime().ToString('o');tasks=@(foreach($n in @('Node','Shield','Network')){@{name=$n;state=(Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $n).State.ToString()}});listeners=@($l|Select-Object LocalAddress,LocalPort,OwningProcess);infrastructure=@(Get-VM -Name 'enclave-control','enclave-storage'|Select-Object Name,Id,@{n='state';e={$_.State.ToString()}})}}
function OldFiles {foreach($f in $m.files){if((Hash $f.live) -ne $f.before){throw ('Live file changed '+$f.name)}};foreach($f in @($m.config,$m.policy)){if((Hash $f.path) -ne $f.before){throw ('Live config/policy changed '+$f.path)}}}
function Candidate {foreach($f in $m.files){$p=Join-Path $Stage ('payload\'+$f.name);if((Hash $p) -ne $f.after){throw ('Candidate changed '+$f.name)};$null=& 'C:\Program Files\Enclave\runtime\node\node.exe' --check $p 2>&1;if($LASTEXITCODE -ne 0){throw ('Syntax failed '+$f.name)}};foreach($f in @($m.image,$m.loader)){if((Hash $f.source) -ne $f.sha256){throw 'Tested artifact changed'};if((Hash $f.live) -notin @('absent',$f.sha256)){throw 'Versioned destination occupied'}}}
function Stopped {foreach($n in @('Node','Shield','Network')){CheckTask $n;if((Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $n).State -eq 'Running'){throw ('Task still running '+$n)}};if(@((State).listeners).Count){throw 'Node or Shield listener remains'}}
function NewFiles {foreach($f in $m.files){if((Hash $f.live) -ne $f.after){throw ('Installed file mismatch '+$f.name)}};$r=Get-Content (Join-Path $Stage 'prepared.json') -Raw|ConvertFrom-Json;if((Hash $m.config.path) -ne $r.configSha256 -or (Hash $m.policy.path) -ne $r.policySha256){throw 'Installed settings mismatch'};foreach($f in @($m.image,$m.loader)){if((Hash $f.live) -ne $f.sha256){throw 'Installed artifact mismatch'}}}
function CopyExact($src,$dest,$sha){if((Hash $src) -ne $sha){throw ('Source hash mismatch '+$src)};$tmp=$dest+'.cpu-quota.tmp';Copy-Item -LiteralPath $src -Destination $tmp -Force;if((Hash $tmp) -ne $sha){throw 'Temporary copy mismatch'};if(Test-Path $dest){Set-Acl -LiteralPath $tmp -AclObject (Get-Acl -LiteralPath $dest)};Move-Item -LiteralPath $tmp -Destination $dest -Force}
try {
 foreach($n in @('Node','Shield','Network')){CheckTask $n}
 $result=@{step=$Step;ok=$false}
 if($Step -eq 'prepare'){
  OldFiles;Candidate;if(Test-Path (Join-Path $Stage 'prepared.json')){throw 'Already prepared'}
  New-Item -ItemType Directory -Force -Path $backup,$prepared|Out-Null
  foreach($f in $m.files){if($f.before -ne 'absent'){$b=Join-Path $backup $f.name;Copy-Item $f.live $b;Set-Acl $b (Get-Acl $f.live)}}
  foreach($pair in @(@($m.config.path,'shield-config.cmd'),@($m.policy.path,'admitted-shield-policy.json'))){$b=Join-Path $backup $pair[1];Copy-Item $pair[0] $b;Set-Acl $b (Get-Acl $pair[0])}
  $s=[IO.File]::ReadAllText($m.config.path);$replace=@{ENCLAVE_GUEST_IGVM=$m.image.live;ENCLAVE_GUEST_IGVM_SHA256=$m.image.sha256;ENCLAVE_WMISERVE_EXE=$m.loader.live;ENCLAVE_WMISERVE_EXE_SHA256=$m.loader.sha256;ENCLAVE_GUEST_CPU_ALLOWANCE='1'}
  foreach($k in $replace.Keys){$pattern='(?m)^set '+[regex]::Escape($k)+'=[^\r\n]*';$matches=[regex]::Matches($s,$pattern);if($matches.Count -gt 1){throw ('Duplicate config '+$k)};$line='set '+$k+'='+$replace[$k];if($matches.Count -eq 1){$s=[regex]::Replace($s,$pattern,[System.Text.RegularExpressions.MatchEvaluator]{param($match) $line})}elseif($k -eq 'ENCLAVE_GUEST_CPU_ALLOWANCE'){$s=$line+"`r`n"+$s}else{throw ('Missing config '+$k)}}
  $cfg=Join-Path $prepared 'shield-config.cmd';[IO.File]::WriteAllText($cfg,$s,$utf8);Set-Acl $cfg (Get-Acl $m.config.path)
  $j=Get-Content $m.policy.path -Raw|ConvertFrom-Json;$old=@($j.images|Where-Object {$_.measurement -eq $m.policy.oldMeasurement});if($old.Count -ne 1){throw 'Expected one original admitted image'};if(@($j.images|Where-Object {$_.measurement -eq $m.policy.newMeasurement}).Count){throw 'New measurement already exists'}
  $entry=$old[0]|ConvertTo-Json -Depth 12|ConvertFrom-Json;$entry.measurement=$m.policy.newMeasurement;$j.images=@($j.images)+@($entry);$pol=Join-Path $prepared 'admitted-shield-policy.json';[IO.File]::WriteAllText($pol,($j|ConvertTo-Json -Depth 20),$utf8);Set-Acl $pol (Get-Acl $m.policy.path)
  $r=@{configSha256=(Hash $cfg);policySha256=(Hash $pol);at=(Get-Date).ToUniversalTime().ToString('o')};[IO.File]::WriteAllText((Join-Path $Stage 'prepared.json'),($r|ConvertTo-Json),$utf8);$result.prepared=$r
 }elseif($Step -eq 'preflight'){
  OldFiles;Candidate;$r=Get-Content (Join-Path $Stage 'prepared.json') -Raw|ConvertFrom-Json;if((Hash (Join-Path $prepared 'shield-config.cmd')) -ne $r.configSha256 -or (Hash (Join-Path $prepared 'admitted-shield-policy.json')) -ne $r.policySha256){throw 'Prepared configuration changed'}
  if((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 16*1024*1024){throw 'Physical RAM below16GiB'}
  $a=Invoke-RestMethod -TimeoutSec 8 http://127.0.0.1:9600/availability;if($a.nodeRamGb -ne 96){throw 'Unexpected RAM pool'}
  $d=Invoke-RestMethod -TimeoutSec 8 http://127.0.0.1:9600/v1/host/state;$result.deployments=@($d.deployments|Select-Object id,status,reason);$result.native=@(Get-VM|Select-Object Name,Id,@{n='state';e={$_.State.ToString()}})
 }elseif($Step -eq 'stop'){
  OldFiles;Candidate;foreach($n in @('Node','Shield','Network')){Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName $n}
 }elseif($Step -eq 'install'){
  Stopped;OldFiles;Candidate;$r=Get-Content (Join-Path $Stage 'prepared.json') -Raw|ConvertFrom-Json
  foreach($f in @($m.image,$m.loader)){CopyExact $f.source $f.live $f.sha256}
  foreach($f in $m.files){CopyExact (Join-Path $Stage ('payload\'+$f.name)) $f.live $f.after}
  CopyExact (Join-Path $prepared 'admitted-shield-policy.json') $m.policy.path $r.policySha256
  CopyExact (Join-Path $prepared 'shield-config.cmd') $m.config.path $r.configSha256
  NewFiles
 }elseif($Step -like 'start-*' -or $Step -like 'rollback-start-*'){
  if($Step -like 'rollback-*'){OldFiles}else{NewFiles};$which=$Step -replace '^rollback-','';$name=@{'start-shield'='Shield';'start-network'='Network';'start-node'='Node'}[$which];if((Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $name).State -eq 'Running'){throw 'Task already running'}
  if($name -eq 'Shield'){if(@((State).listeners).Count){throw 'Old listener remains'}}
  if($name -eq 'Node'){$h=Invoke-RestMethod -TimeoutSec 8 http://127.0.0.1:8091/health;if($h.memory.poolMiB -ne 98304){throw 'Shield RAM pool wrong'};if(@((State).listeners|Where-Object {$_.LocalPort -eq 9600}).Count){throw 'Node listener remains'}}
  Start-ScheduledTask -TaskPath '\Enclave\' -TaskName $name
 }elseif($Step -eq 'rollback'){
  Stopped
  foreach($f in $m.files){if((Hash $f.live) -notin @($f.before,$f.after)){throw ('Refuse unrelated file '+$f.name)}}
  $r=Get-Content (Join-Path $Stage 'prepared.json') -Raw|ConvertFrom-Json
  if((Hash $m.config.path) -notin @($m.config.before,$r.configSha256) -or (Hash $m.policy.path) -notin @($m.policy.before,$r.policySha256)){throw 'Refuse unrelated configuration'}
  foreach($f in $m.files){if($f.before -eq 'absent'){if(Test-Path $f.live){Remove-Item $f.live}}else{CopyExact (Join-Path $backup $f.name) $f.live $f.before}}
  CopyExact (Join-Path $backup 'shield-config.cmd') $m.config.path $m.config.before;CopyExact (Join-Path $backup 'admitted-shield-policy.json') $m.policy.path $m.policy.before;OldFiles
 }elseif($Step -eq 'verify'){
  NewFiles;$h=Invoke-RestMethod -TimeoutSec 8 http://127.0.0.1:8091/health;$v=Invoke-RestMethod -TimeoutSec 8 http://127.0.0.1:8091/vms;$d=Invoke-RestMethod -TimeoutSec 8 http://127.0.0.1:9600/v1/host/state
  $result.health=$h;$result.vms=@($v.vms|Select-Object id,name,status,memory,cpu,recovered,reason);$result.deployments=@($d.deployments|Select-Object id,status,reason)
 }
 $result.ok=$true;$result.state=State;$result|ConvertTo-Json -Depth 14 -Compress
}catch{@{ok=$false;step=$Step;error=$_.Exception.Message;state=(State)}|ConvertTo-Json -Depth 6 -Compress}
