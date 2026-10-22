$ErrorActionPreference='Stop'
# READ-ONLY: the full text (<=700 chars) of node.log certificate lines for sia-s3 today (last 6), and today's count of
# sia-s3 "isolation spawned" / "retired" events (each relaunch orders a certificate).
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$p=Join-Path $env:ProgramData 'Enclave\logs\node.log'
$fs=[IO.File]::Open($p,'Open','Read','ReadWrite'); try{ [void]$fs.Seek([Math]::Max(0,$fs.Length-12MB),'Begin'); $text=(New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
$all=@($text -split "`n")
"WINDOW first=$($all[1].Substring(0,[Math]::Min(8,$all[1].Length))) lines=$($all.Count)"
@($all | Where-Object { $_ -match 'ef514ed3' -and $_ -match '(?i)certificate' } | Select-Object -Last 6) | ForEach-Object { $t=$_.TrimEnd(); if($t.Length -gt 700){$t=$t.Substring(0,700)}; "  $t" }
"== sia-s3 spawn/retire events in window"
@($all | Where-Object { $_ -match '0xef514ed3 (isolation spawned|isolated domain retired)' }) | ForEach-Object { $t=$_.TrimEnd(); if($t.Length -gt 160){$t=$t.Substring(0,160)}; "  $t" }
