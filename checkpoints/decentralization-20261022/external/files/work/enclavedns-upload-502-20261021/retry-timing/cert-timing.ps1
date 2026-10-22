$ErrorActionPreference='Stop'
# READ-ONLY: live hvcert.mjs / agent.mjs sha256 and the cert-pass timer line; node.log "0xef514ed3 certificate:" lines
# since the 18:49 relaunch (metadata only, truncated to 260 chars; no CSR/keys exist in these lines).
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$n=Join-Path $env:ProgramFiles 'Enclave\control\windows\node'
foreach($f in 'hvcert.mjs','agent.mjs','apptls.mjs'){ $p=Join-Path $n $f; if(Test-Path $p){ "SRC $f $((Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower()) $((Get-Item $p).LastWriteTimeUtc.ToString('o'))" } }
"TIMER " + (@(Select-String -LiteralPath (Join-Path $n 'agent.mjs') -Pattern 'setInterval\(tick, *60_000\)|setTimeout\(tick, *15_000\)' | ForEach-Object { $_.LineNumber }) -join ',')
$proc=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -like '*\windows\node\agent.mjs*' })
foreach($p in $proc){ "NODEPROC pid=$($p.ProcessId) started=$(([datetime]$p.CreationDate).ToUniversalTime().ToString('o'))" }
$l=Join-Path $env:ProgramData 'Enclave\logs\node.log'
$fs=[IO.File]::Open($l,'Open','Read','ReadWrite'); try{ [void]$fs.Seek([Math]::Max(0,$fs.Length-3MB),'Begin'); $text=(New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
$all=@($text -split "`n"); $i0=0; for($i=0;$i -lt $all.Count;$i++){ if($all[$i] -match '0xef514ed3 isolation spawned: hv3f742170'){ $i0=$i } }
"== since relaunch line index $i0 of $($all.Count)"
@($all[$i0..($all.Count-1)] | Where-Object { $_ -match '0xef514ed3 certificate:' -or $_ -match 'certificates: pass failed' }) | ForEach-Object { $t=$_.TrimEnd(); if($t.Length -gt 260){$t=$t.Substring(0,260)}; "  $t" }
