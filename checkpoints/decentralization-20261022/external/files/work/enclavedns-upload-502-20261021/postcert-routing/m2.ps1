$ErrorActionPreference='Stop'
# READ-ONLY: sia-s3 published route record (public, signed; base64 blobs elided), runtime status circuits, guest console tail.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(90);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$mask='(?i)(token|secret|key|password|signature|sig|auth|cookie)\s*[=:]\s*\S+'
$r=Join-Path $env:ProgramData 'Enclave\network\state\routes\published-0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238.json'
$j=[IO.File]::ReadAllText($r)|ConvertFrom-Json; $rec=$j.bundle.record
$t=($rec | ConvertTo-Json -Depth 6 -Compress) -replace '"[A-Za-z0-9+/=_-]{60,}"','"<blob>"'
"== route record (mtime $((Get-Item $r).LastWriteTimeUtc.ToString('HH:mm:ss'))): $($t.Substring(0,[Math]::Min(1400,$t.Length)))"
$s=[IO.File]::ReadAllText((Join-Path $env:ProgramData 'Enclave\network\state\status.json'))|ConvertFrom-Json
$a=@($s.apps | Where-Object { $_.deploymentId -match 'ef514ed3' })[0]
"== status ready=$($a.ready) error=$($a.error) degraded=$($a.degraded) ingress=$($a.ingress) egress=$($a.egress) proofUntil=$($a.proofUntil) leaseUntil=$($a.leaseUntil)"
foreach($c in @($a.circuits)){ "  circuit $($c.id.Substring(0,8)) kind=$($c.kind) healthy=$($c.healthy) ingress=$($c.ingress) egress=$($c.egress) exit=$($c.exit.address) guard=$($c.guard.address) hs=$($c.handshakeAgeMs)" }
$cl=Join-Path $env:ProgramData 'Enclave\logs\partitions\enclave-app-hv3f742170c66094-ea9d4773.log'
if(Test-Path $cl){ "== console $((Get-Item $cl).Length) bytes, mtime $((Get-Item $cl).LastWriteTimeUtc.ToString('HH:mm:ss'))"; @(Get-Content $cl -Tail 600 | Where-Object { $_ -match '(?i)listen|ready|serving|error|warn|fail|panic|config|8000|tls|cert|sia-s3|boot' } | Select-Object -Last 30) | ForEach-Object { $x=$_.TrimEnd() -replace $mask,'$1=<m>'; if($x.Length -gt 200){$x=$x.Substring(0,200)}; "  $x" } } else { "== console absent" }
