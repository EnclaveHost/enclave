$ErrorActionPreference='Stop'
# READ-ONLY (host-queue, 2026-10-21): sia-s3 0xef514ed3 live deployment facts, its egress-route entry, network.log near
# the 18:30:08-18:30:45Z direct-r2 upload, and the partition console. Secret-looking keys/values are redacted; env = names.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
$sec='(?i)key|secret|token|psk|priv|pass|cred|seed|sig|auth|cookie|mnemonic|phrase'
Write-Output "NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$p=Join-Path $env:ProgramData 'Enclave\logs\network.log'
$fs=[IO.File]::Open($p,'Open','Read','ReadWrite'); try{ [void]$fs.Seek([Math]::Max(0,$fs.Length-32MB),'Begin'); $text=(New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
$all=@($text -split "`n")
Write-Output "== NETWORK.LOG sia-s3 lines at/after 16:30 (last 40)"
$sel=@($all | Where-Object { $_ -match 'ef514ed3' -and $_ -match '^(1[6-9]|2[0-3]):' } | Select-Object -Last 40)
foreach($l in $sel){ $t=$l.TrimEnd() -replace "$sec\s*[=:]\s*\S+",'<redacted>'; if($t.Length -gt 220){$t=$t.Substring(0,220)+'...'}; Write-Output "  $t" }
Write-Output "== NETWORK.LOG any line 18:29:00-18:31:59 matching egress|socks|refus|denied|limit|circuit|ef514ed3 (first 60)"
$sel=@($all | Where-Object { $_ -match '^18:(29|30|31):' -and $_ -match '(?i)egress|socks|refus|denied|limit|circuit|ef514ed3|shield' } | Select-Object -First 60)
foreach($l in $sel){ $t=$l.TrimEnd() -replace "$sec\s*[=:]\s*\S+",'<redacted>'; if($t.Length -gt 220){$t=$t.Substring(0,220)+'...'}; Write-Output "  $t" }
Write-Output "== NETWORK.LOG line count 18:29-18:31: $(@($all | Where-Object { $_ -match '^18:(29|30|31):' }).Count)"
Write-Output "== LOG FILES modified in the last 3 h"
Get-ChildItem (Join-Path $env:ProgramData 'Enclave\logs') -Recurse -File | Where-Object { $_.LastWriteTimeUtc -gt (Get-Date).ToUniversalTime().AddHours(-3) } | ForEach-Object { Write-Output ("  {0} {1} {2}" -f $_.FullName.Substring($env:ProgramData.Length), $_.Length, $_.LastWriteTimeUtc.ToString('HH:mm:ss')) }
