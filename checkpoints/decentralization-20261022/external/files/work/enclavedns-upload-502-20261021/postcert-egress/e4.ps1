$ErrorActionPreference='Stop'
# READ-ONLY: egress-routes.json sampled every 200 ms for 45 s across sia-s3's next boot attempt (~19:50:07): only anomalies
# (read error, parse error, sia absent, expiry margin < 2 s) and a summary; then shield.log lines for VM 53b2c83c since 19:49.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"START $((Get-Date).ToUniversalTime().ToString('HH:mm:ss.fff'))"
$f=Join-Path $env:ProgramData 'Enclave\network\state\egress-routes.json'; $n=0;$an=0;$minM=999999;$mt=@{}
$end=(Get-Date).AddSeconds(45)
while((Get-Date) -lt $end){ $n++; $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); $ts=(Get-Date).ToUniversalTime().ToString('HH:mm:ss.fff')
  try{ $raw=[IO.File]::ReadAllText($f) } catch { $an++; "  $ts READ-ERROR $($_.Exception.GetType().Name)"; Start-Sleep -Milliseconds 200; continue }
  try{ $j=$raw|ConvertFrom-Json } catch { $an++; "  $ts PARSE-ERROR len=$($raw.Length)"; Start-Sleep -Milliseconds 200; continue }
  $m=[int64]$j.expiresAt-$now; if($m -lt $minM){$minM=$m}; $mt[(Get-Item $f).LastWriteTimeUtc.ToString('HH:mm:ss.fff')]=1
  $sia=@($j.apps.PSObject.Properties.Name) -contains '0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238'
  if(-not $sia -or $m -lt 2000 -or $raw.TrimEnd().Length -ne $raw.Length){ $an++; "  $ts ANOMALY sia=$sia marginMs=$m trailingSpace=$($raw.TrimEnd().Length -ne $raw.Length) len=$($raw.Length)" }
  Start-Sleep -Milliseconds 200 }
"SUMMARY samples=$n anomalies=$an minMarginMs=$minM distinctWrites=$($mt.Count) END $((Get-Date).ToUniversalTime().ToString('HH:mm:ss.fff'))"
$p=Join-Path $env:ProgramData 'Enclave\logs\shield.log'; $fs=[IO.File]::Open($p,'Open','Read','ReadWrite'); try{[void]$fs.Seek([Math]::Max(0,$fs.Length-200KB),'Begin');$t=(New-Object IO.StreamReader($fs)).ReadToEnd()}finally{$fs.Close()}
"== shield.log 53b2c83c since 19:49"; @($t -split "`n" | Where-Object { $_ -match '^19:(49|5\d):' -and $_ -match '53b2c83c' } | Select-Object -Last 10) | ForEach-Object { "  $($_.TrimEnd().Substring(0,[Math]::Min(200,$_.TrimEnd().Length)))" }
