$ErrorActionPreference='Stop'
# READ-ONLY: sia-s3 (0xef514ed3, VM 53b2c83c, partition hv3f742170) lines since 19:38Z in network.log / node.log (truncated,
# key=value secrets masked), shield-egress outcome counts, the published route file's public fields, guest console tail.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$L=Join-Path $env:ProgramData 'Enclave\logs'; $mask='(?i)(token|secret|key|password|signature|sig|auth|cookie)\s*[=:]\s*\S+'
function Tail($n,$kb){ $p=Join-Path $L $n; $fs=[IO.File]::Open($p,'Open','Read','ReadWrite'); try{ [void]$fs.Seek([Math]::Max(0,$fs.Length-$kb*1KB),'Begin'); (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() } }
foreach($n in 'network.log','node.log'){ "== $n"; @((Tail $n 800) -split "`n" | Where-Object { $_ -match '^(19:(3[89]|[4-5]\d)):' -and $_ -match 'ef514ed3|hv3f742170|53b2c83c' } | Select-Object -Last 30) | ForEach-Object { $t=$_.TrimEnd() -replace $mask,'$1=<m>'; if($t.Length -gt 230){$t=$t.Substring(0,230)}; "  $t" } }
"== shield.log 53b2c83c outcomes since 19:38"; $h=@{}; foreach($l in ((Tail 'shield.log' 400) -split "`n")){ if($l -match '^(19:(3[89]|[4-5]\d)):\d\d \[egress\] 53b2c83c .*egress (\S+)'){ $h[$Matches[3]]++ } }; $h.Keys | ForEach-Object { "  $_ x$($h[$_])" }
$r=Join-Path $env:ProgramData 'Enclave\network\state\routes\published-0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238.json'
"== published route mtime $((Get-Item $r).LastWriteTimeUtc.ToString('o'))"
$j=[IO.File]::ReadAllText($r)|ConvertFrom-Json; $b=$j.bundle
foreach($k in 'sequence','issuedAt','expiresAt'){ "  $k=$($b.$k)" }; "  routes=$(@($b.routes).Count) name=$($j.name) keys=$(@($b.PSObject.Properties.Name) -join ',')"
foreach($x in @($b.routes)){ "  route " + (($x | ConvertTo-Json -Depth 4 -Compress) -replace '"[A-Za-z0-9+/=]{40,}"','"<b64>"').Substring(0,[Math]::Min(300,($x|ConvertTo-Json -Depth 4 -Compress).Length)) }
$s=[IO.File]::ReadAllText((Join-Path $env:ProgramData 'Enclave\network\state\status.json'))|ConvertFrom-Json
$a=@($s.apps | Where-Object { $_.deploymentId -match 'ef514ed3' })[0]
"== status ready=$($a.ready) error=$($a.error) degraded=$($a.degraded) ingress=$($a.ingress) egress=$($a.egress) proofUntil=$($a.proofUntil)"
foreach($c in $a.circuits){ "  circuit $($c.id.Substring(0,8)) kind=$($c.kind) healthy=$($c.healthy) ingress=$($c.ingress) egress=$($c.egress) exit=$($c.exit.address) hs=$($c.handshakeAgeMs)" }
$cl=Join-Path $L 'partitions\enclave-app-hv3f742170c66094-ea9d4773.log'
if(Test-Path $cl){ "== console $((Get-Item $cl).Length) bytes"; @(Get-Content $cl -Tail 400 | Where-Object { $_ -match '(?i)listen|ready|serving|error|warn|fail|panic|config|8000|tls|cert' } | Select-Object -Last 25) | ForEach-Object { $t=$_.TrimEnd() -replace $mask,'$1=<m>'; if($t.Length -gt 200){$t=$t.Substring(0,200)}; "  $t" } } else { "== console absent" }
