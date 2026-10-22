$ErrorActionPreference='Stop'
$id='0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238'
$v=Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:8091/vms'
$mine=@($v.vms|Where-Object{$_.name -eq $id}|ForEach-Object{@{id=$_.id;status=$_.status;reason=$_.reason}})
$s=Invoke-RestMethod -TimeoutSec 10 'http://127.0.0.1:9600/v1/host/state'
$d=@($s.deployments|Where-Object{$_.id -eq $id}|ForEach-Object{@{status=$_.status;version=$_.version;cid=$_.cid;leaseUntil=$_.leaseUntil;reason=$_.reason}})
$p='C:\ProgramData\Enclave\logs\network.log';$f=[IO.File]::Open($p,'Open','Read','ReadWrite');try{[void]$f.Seek([Math]::Max(0,$f.Length-256KB),'Begin');$t=(New-Object IO.StreamReader($f)).ReadToEnd()}finally{$f.Close()}
$l=@($t -split "`n"|Where-Object{$_ -match '0xef514ed3' -and $_ -match 'guest proof|egress|policy|certificate'}|Select-Object -Last 12|ForEach-Object{$_.Substring(0,[Math]::Min(250,$_.Length))})
@{at=[DateTime]::UtcNow.ToString('o');vm=$mine;deployment=$d;network=$l}|ConvertTo-Json -Depth 5 -Compress
