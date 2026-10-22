$ErrorActionPreference='Stop'
# READ-ONLY: network.log since 19:40 for sia-s3 + any "egress OFF/back" or route-writer lines (truncated); status.json
# authorization margins for sia-s3 now.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(80);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
$now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); "NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$p=Join-Path $env:ProgramData 'Enclave\logs\network.log'; $fs=[IO.File]::Open($p,'Open','Read','ReadWrite'); try{[void]$fs.Seek([Math]::Max(0,$fs.Length-400KB),'Begin');$t=(New-Object IO.StreamReader($fs)).ReadToEnd()}finally{$fs.Close()}
"== network.log 19:40+ (sia-s3, egress OFF/back any app, route/egress-routes/local route)"
@($t -split "`n" | Where-Object { $_ -match '^19:(4\d|5\d):' -and $_ -match 'ef514ed3|egress OFF|egress back|egress-routes|local route|authorization' } | Select-Object -Last 30) | ForEach-Object { $x=$_.TrimEnd(); if($x.Length -gt 220){$x=$x.Substring(0,220)}; "  $x" }
$s=[IO.File]::ReadAllText((Join-Path $env:ProgramData 'Enclave\network\state\status.json'))|ConvertFrom-Json
$a=@($s.apps | Where-Object { $_.deploymentId -match 'ef514ed3' })[0]
"== status now: proofUntil-now=$([int64]$a.proofUntil-$now)ms leaseUntil-now=$([int64]$a.leaseUntil-$now)ms ready=$($a.ready) egress=$($a.egress) authRefresh=$(($s.authorizationRefresh | ConvertTo-Json -Compress).Substring(0,[Math]::Min(300,($s.authorizationRefresh | ConvertTo-Json -Compress).Length)))"
