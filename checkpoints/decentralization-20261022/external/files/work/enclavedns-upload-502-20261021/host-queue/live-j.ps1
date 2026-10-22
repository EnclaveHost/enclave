$ErrorActionPreference='Stop'
# READ-ONLY: shielded-bridge / shield-egress processes (exe sha, args with any long token masked), each bridge's
# established TCP connections (count only), and shield.log "shielded bridge ready ... slots=" lines (last 12).
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$procs=@(Get-CimInstance Win32_Process -Filter "Name='shielded-bridge.exe' OR Name='shield-egress.exe'" -OperationTimeoutSec 20)
$sh=@{}; foreach($p in $procs){ if($p.ExecutablePath -and -not $sh[$p.ExecutablePath]){ $sh[$p.ExecutablePath]=(Get-FileHash -Algorithm SHA256 -LiteralPath $p.ExecutablePath).Hash.ToLower().Substring(0,16) } }
$sh.Keys | ForEach-Object { "EXE $_ sha256:$($sh[$_])..." }
$conns=@(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue)
foreach($p in ($procs | Sort-Object Name,ProcessId)){
  $args=[string]$p.CommandLine -replace '^"?[^"]*\.exe"?\s*','' -replace '[A-Za-z0-9+/=_-]{40,}','<long>'
  if($args.Length -gt 260){$args=$args.Substring(0,260)+'...'}
  $mine=@($conns | Where-Object { $_.OwningProcess -eq $p.ProcessId })
  "$($p.Name) pid=$($p.ProcessId) started=$(([datetime]$p.CreationDate).ToUniversalTime().ToString('MM-dd HH:mm')) estab=$($mine.Count) args=$args" }
$l=Join-Path $env:ProgramData 'Enclave\logs\shield.log'
$fs=[IO.File]::Open($l,'Open','Read','ReadWrite'); try{ [void]$fs.Seek([Math]::Max(0,$fs.Length-5MB),'Begin'); $text=(New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
"== bridge ready lines (last 12)"; @($text -split "`n" | Where-Object { $_ -match 'shielded bridge ready' } | Select-Object -Last 12) | ForEach-Object { $t=$_.TrimEnd() -replace '[A-Za-z0-9+/=_-]{40,}','<long>'; if($t.Length -gt 220){$t=$t.Substring(0,220)}; "  $t" }
"== bridge connection-ended lines (count, last 5)"; $be=@($text -split "`n" | Where-Object { $_ -match 'shielded bridge connection ended' }); "  count=$($be.Count)"; $be | Select-Object -Last 5 | ForEach-Object { $t=$_.TrimEnd(); if($t.Length -gt 200){$t=$t.Substring(0,200)}; "  $t" }
