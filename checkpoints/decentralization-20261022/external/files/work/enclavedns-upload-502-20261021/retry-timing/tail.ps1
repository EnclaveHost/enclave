$ErrorActionPreference='Stop'
# READ-ONLY: only the time and the final "; retry in Ns" of node.log sia-s3 certificate lines since 18:49 (no other text).
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(60);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$l=Join-Path $env:ProgramData 'Enclave\logs\node.log'
$fs=[IO.File]::Open($l,'Open','Read','ReadWrite'); try{ [void]$fs.Seek([Math]::Max(0,$fs.Length-1MB),'Begin'); $text=(New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
@($text -split "`n" | Where-Object { $_ -match '^(18:(49|5\d)|19:\d\d):\d\d \[node\] 0xef514ed3 certificate:' }) | ForEach-Object { $m=[regex]::Match($_,'^(\S+).*?(refused|in flight|installed|already serves).*?(retry in \d+s)?\s*$'); "  $($m.Groups[1].Value) $($m.Groups[2].Value) $($m.Groups[3].Value)" }
