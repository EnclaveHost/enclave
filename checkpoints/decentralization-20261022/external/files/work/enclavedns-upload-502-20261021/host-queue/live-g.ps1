$ErrorActionPreference='Stop'
# READ-ONLY: where are shield-egress outcome lines ("guest <cid> egress open|refused:<reason>") written? For each log
# under Enclave\logs (tail 4 MB): count of such lines, last timestamp, and a reason histogram for 18:2x-18:4x lines.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$root=Join-Path $env:ProgramData 'Enclave'
$files=@(Get-ChildItem $root -Recurse -File -Include *.log,*.txt -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -gt (Get-Date).ToUniversalTime().AddHours(-6) -and $_.Length -gt 0 })
foreach($f in $files){
  $fs=[IO.File]::Open($f.FullName,'Open','Read','ReadWrite'); try{ [void]$fs.Seek([Math]::Max(0,$fs.Length-4MB),'Begin'); $text=(New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
  $hits=@($text -split "`n" | Where-Object { $_ -match 'egress (open|refused:[a-z-]+)' })
  if(-not $hits.Count){ continue }
  "== $($f.FullName.Substring($root.Length)) size=$($f.Length) mtime=$($f.LastWriteTimeUtc.ToString('HH:mm:ss')) lines=$($hits.Count) last=$(($hits[-1] -replace '^(.{0,40}).*$','$1'))"
  $h=@{}; foreach($l in $hits){ if($l -match '(\d\d:\d\d):\d\d.*guest (\d+) egress (open|refused:[a-z-]+)'){ if($Matches[1] -match '^18:[2-4]'){ $k="$($Matches[1]) cid=$($Matches[2]) $($Matches[3])"; $h[$k]++ } } }
  $h.Keys | Sort-Object | ForEach-Object { "  $_ x$($h[$_])" } | Select-Object -Last 80 }
"files scanned: $($files.Count)"
