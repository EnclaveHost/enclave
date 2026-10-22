$ErrorActionPreference='Stop'
# READ-ONLY: shield-config.cmd lines naming the bridge or egress caps (numeric values only), sia-s3 certificate lines and
# egress refusals since 18:49, and the current egress-routes entry presence for sia-s3.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$c=Join-Path $env:ProgramData 'Enclave\shield-config.cmd'
"shield-config.cmd mtime $((Get-Item $c).LastWriteTimeUtc.ToString('o'))"
@(Get-Content $c | Where-Object { $_ -match '(?i)BRIDGE|MAX_CONN|EGRESS' }) | ForEach-Object { if($_ -match '(?i)_SHA256=|_EXE=|ROUTES=|SERVICE='){ "CFG " + ($_ -replace '=.*$','=<path/pin>') } else { "CFG $_" } }
foreach($n in 'node.log','shield.log'){ $p=Join-Path $env:ProgramData "Enclave\logs\$n"
  $fs=[IO.File]::Open($p,'Open','Read','ReadWrite'); try{ [void]$fs.Seek([Math]::Max(0,$fs.Length-300KB),'Begin'); $text=(New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
  "== $n"; @($text -split "`n" | Where-Object { $_ -match '^18:(49|5\d)|^19:' -and $_ -match '(ef514ed3.*certificate|53b2c83c.*egress)' } | Select-Object -Last 8) | ForEach-Object { $t=$_.TrimEnd(); if($t.Length -gt 260){$t=$t.Substring(0,260)}; "  $t" } }
$r=[IO.File]::ReadAllText((Join-Path $env:ProgramData 'Enclave\network\state\egress-routes.json'))|ConvertFrom-Json
"sia-s3 in egress-routes: $(@($r.apps.PSObject.Properties.Name) -contains '0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238')"
