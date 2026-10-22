$ErrorActionPreference='Stop'
# READ-ONLY: shield.log egress outcome lines (fixed codes, no destinations): last 25 egress lines verbatim (truncated),
# per-hour histogram of outcome codes, and every refused line naming concurrency/rate (last 20).
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$p=Join-Path $env:ProgramData 'Enclave\logs\shield.log'
$fs=[IO.File]::Open($p,'Open','Read','ReadWrite'); try{ [void]$fs.Seek([Math]::Max(0,$fs.Length-4MB),'Begin'); $text=(New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
$all=@($text -split "`n" | Select-Object -Skip 1)
"WINDOW first=$($all[0].Substring(0,[Math]::Min(30,$all[0].Length))) lines=$($all.Count)"
$eg=@($all | Where-Object { $_ -match 'egress (open|refused:)' })
"== last 25 egress lines"; $eg | Select-Object -Last 25 | ForEach-Object { $t=$_.TrimEnd(); if($t.Length -gt 160){$t=$t.Substring(0,160)}; "  $t" }
"== per-hour outcome histogram"
$h=@{}; foreach($l in $eg){ if($l -match '(\d\d):\d\d:\d\d' ){ $hr=$Matches[1] } else { $hr='??' }; if($l -match 'egress (open|refused:[a-z-]+)'){ $k="$hr $($Matches[1])"; $h[$k]++ } }
$h.Keys | Sort-Object | ForEach-Object { "  $_ x$($h[$_])" }
"== concurrency/rate refusals (last 20)"; @($eg | Where-Object { $_ -match 'refused:(concurrency|rate)' } | Select-Object -Last 20) | ForEach-Object { "  $($_.TrimEnd())" }
"== last 8 non-egress lines"; @($all | Where-Object { $_ -notmatch 'egress (open|refused:)' -and $_.Trim() } | Select-Object -Last 8) | ForEach-Object { $t=$_.TrimEnd(); if($t.Length -gt 200){$t=$t.Substring(0,200)}; "  $t" }
