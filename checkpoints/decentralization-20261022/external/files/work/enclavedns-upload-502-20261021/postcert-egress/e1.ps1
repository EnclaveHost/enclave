$ErrorActionPreference='Stop'
# READ-ONLY: egress-routes.json sampled 20x at 1 s, judged with shield-egress ReadAppRoute's rules (metadata only: app id
# prefixes, proxy counts/dupes, expiry margin, unknown keys, parse ok); admit refusals per VM in shield.log since 19:30.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
$f=Join-Path $env:ProgramData 'Enclave\network\state\egress-routes.json'
for($i=0;$i -lt 20;$i++){
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); $m=(Get-Item $f).LastWriteTimeUtc.ToString('HH:mm:ss.fff')
  try{ $raw=[IO.File]::ReadAllText($f); $j=$raw|ConvertFrom-Json; $ok='parsed' } catch { "S$i mtime=$m PARSE-FAIL len=$($raw.Length)"; Start-Sleep 1; continue }
  $top=@($j.PSObject.Properties.Name); $ids=@($j.apps.PSObject.Properties.Name); $px=@(); $bad=@()
  foreach($id in $ids){ $a=$j.apps.$id; $k=@($a.PSObject.Properties.Name) | Where-Object { $_ -notin 'proxies','dns' }; if($k){$bad+="$($id.Substring(0,10)):extra[$($k -join '+')]"}; $n=@($a.proxies).Count; if($n -lt 1 -or $n -gt 2){$bad+="$($id.Substring(0,10)):proxies=$n"}; $px+=@($a.proxies); foreach($d in @($a.dns)){ $dk=@($d.PSObject.Properties.Name) | Where-Object { $_ -notin 'address','serverName','path' }; if($dk){$bad+="$($id.Substring(0,10)):dnsextra[$($dk -join '+')]"} } }
  $dup=@($px | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name }); if($dup){$bad+="DUP-PROXY x$($dup.Count)"}
  $xt=@($top | Where-Object { $_ -notin 'version','expiresAt','apps' }); if($xt){$bad+="TOP-EXTRA[$($xt -join '+')]"}
  $margin=[int64]$j.expiresAt-$now
  "S$i mtime=$m v=$($j.version) apps=$($ids.Count) sia=$($ids -contains '0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238') marginMs=$margin bad=$($bad -join ',')"
  Start-Sleep -Milliseconds 1000 }
$p=Join-Path $env:ProgramData 'Enclave\logs\shield.log'; $fs=[IO.File]::Open($p,'Open','Read','ReadWrite'); try{[void]$fs.Seek([Math]::Max(0,$fs.Length-600KB),'Begin');$t=(New-Object IO.StreamReader($fs)).ReadToEnd()}finally{$fs.Close()}
"== shield.log egress refusals since 19:30 (time vm reason)"
@($t -split "`n" | Where-Object { $_ -match '^(19:[3-5]\d):\d\d \[egress\] ([0-9a-f]{8}) .*egress (refused:\S+|ended:\S+)' } | ForEach-Object { $_ -match '^(\S+) \[egress\] ([0-9a-f]{8}) .*egress (\S+)' | Out-Null; "  $($Matches[1]) $($Matches[2]) $($Matches[3])" } | Select-Object -Last 40)
