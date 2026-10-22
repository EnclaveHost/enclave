$ErrorActionPreference='Stop'
# READ-ONLY: which live runtime files emit "policy requires the current lease" (path/sha/size), and network.log ordering:
# per-app counts of "app policy" reasons in the last 6000 lines, and the last 25 sia-s3 lines that are not policy lines.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
Write-Output "NOW $((Get-Date).ToUniversalTime().ToString('o')) TZ $((Get-TimeZone).Id)"
foreach($root in 'C:\Program Files\Enclave'){ Get-ChildItem $root -Recurse -File -Include *.mjs,*.js -ErrorAction SilentlyContinue | Where-Object { $_.Length -lt 8MB -and $_.FullName -notmatch 'node_modules' } | Where-Object { Select-String -LiteralPath $_.FullName -SimpleMatch 'policy requires the current lease' -Quiet } | ForEach-Object { Write-Output ("SRC {0} {1} {2} {3}" -f $_.FullName,$_.Length,$_.LastWriteTimeUtc.ToString('o'),(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLower()) } }
$p=Join-Path $env:ProgramData 'Enclave\logs\network.log'
$fs=[IO.File]::Open($p,'Open','Read','ReadWrite'); try{ [void]$fs.Seek([Math]::Max(0,$fs.Length-3MB),'Begin'); $text=(New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
$all=@($text -split "`n" | Select-Object -Last 6000)
Write-Output "WINDOW first=$($all[0].Substring(0,[Math]::Min(9,$all[0].Length))) last=$($all[-1].Substring(0,[Math]::Min(9,$all[-1].Length))) lines=$($all.Count)"
$g=@{}; foreach($l in $all){ if($l -match '\] app policy (0x[0-9a-f]{8}): (.{0,60})'){ $k="$($Matches[1]) $($Matches[2])"; if(-not $g[$k]){$g[$k]=@(0,($l.Substring(0,8)),'')}; $g[$k][0]++; $g[$k][2]=$l.Substring(0,8) } }
foreach($k in $g.Keys){ Write-Output ("POLICY {0} count={1} first={2} last={3}" -f $k,$g[$k][0],$g[$k][1],$g[$k][2]) }
$i=0; @(foreach($l in $all){ $i++; if($l -match 'ef514ed3' -and $l -notmatch 'app policy'){ $t=$l.TrimEnd(); if($t.Length -gt 200){$t=$t.Substring(0,200)}; "L$i $t" } }) | Select-Object -Last 25
$first=0;$last=0;$i=0; foreach($l in $all){ $i++; if($l -match 'app policy 0xef514ed3'){ $last=$i; if(-not $first){$first=$i} } }; Write-Output "sia-s3 policy line numbers first=$first last=$last of $($all.Count)"
Write-Output "OTHER app 0x lines 18:2x-18:3x (not policy, not circuit conn), last 15:"
@($all | Where-Object { $_ -match '^18:[23]' -and $_ -match '\] app 0x[0-9a-f]{8}: ' } | Select-Object -Last 15) | ForEach-Object { $t=$_.TrimEnd(); if($t.Length -gt 200){$t=$t.Substring(0,200)}; Write-Output "  $t" }
