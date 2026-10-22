$ErrorActionPreference='Stop'
# READ-ONLY: today's (last 3 MB of network.log) per-connection egress summaries (>= 4 MiB, enclave-wg connwatch): time,
# circuit, up/down bytes, ms, upKBps only (no destinations). Plus sia-s3/adapter circuit events, and lines per minute.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
Write-Output "NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$p=Join-Path $env:ProgramData 'Enclave\logs\network.log'
$fs=[IO.File]::Open($p,'Open','Read','ReadWrite'); try{ [void]$fs.Seek([Math]::Max(0,$fs.Length-3MB),'Begin'); $text=(New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
$all=@($text -split "`n" | Select-Object -Skip 1)
Write-Output "WINDOW first=$($all[0].Substring(0,8)) lines=$($all.Count)"
Write-Output "== conn summaries (all circuits) by time"
foreach($l in $all){ if($l -match '^(\d\d:\d\d:\d\d) \[privacy\] circuit ([0-9a-f]{8})[0-9a-f]* conn (\{.*)$'){ $ts=$Matches[1];$c=$Matches[2]; try{ $j=$Matches[3]|ConvertFrom-Json; Write-Output ("  {0} c={1} up={2} down={3} ms={4} upKBps={5} maxRtoMs={6}" -f $ts,$c,$j.up,$j.down,$j.ms,$j.upKBps,$j.maxRtoMs) } catch { Write-Output "  $ts c=$c (unparsed)" } } }
Write-Output "== circuit events naming sia-s3 or the adapter (last 20)"
@($all | Where-Object { $_ -match '(ef514ed3|7ae476a3).*circuit|circuit.*(ef514ed3|7ae476a3)' } | Select-Object -Last 20) | ForEach-Object { $t=$_.TrimEnd(); if($t.Length -gt 180){$t=$t.Substring(0,180)}; Write-Output "  $t" }
Write-Output "== lines per minute 18:00-18:40"
$m=@{}; foreach($l in $all){ if($l -match '^(18:[0-3]\d):'){ $m[$Matches[1]]++ } }; ($m.Keys | Sort-Object | ForEach-Object { "$_=$($m[$_])" }) -join ' '
