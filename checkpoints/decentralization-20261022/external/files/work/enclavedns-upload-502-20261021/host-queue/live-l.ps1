$ErrorActionPreference='Stop'
# READ-ONLY: node.log / network.log / shield.log lines naming sia-s3 (ef514ed3, hvd5a51d59, hv3f742170, 3676ef7b, 53b2c83c)
# in each file's last 600 KB (last 25 per file, truncated, secret-looking key=value masked); plus the deployment state now.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
"NOW $((Get-Date).ToUniversalTime().ToString('o'))"
foreach($n in 'node.log','network.log','shield.log'){
  $p=Join-Path $env:ProgramData "Enclave\logs\$n"
  $fs=[IO.File]::Open($p,'Open','Read','ReadWrite'); try{ [void]$fs.Seek([Math]::Max(0,$fs.Length-600KB),'Begin'); $text=(New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
  "== $n mtime $((Get-Item $p).LastWriteTimeUtc.ToString('HH:mm:ss'))"
  @($text -split "`n" | Where-Object { $_ -match 'ef514ed3|hvd5a51d59|hv3f742170|3676ef7b|53b2c83c' } | Select-Object -Last 25) | ForEach-Object { $t=$_.TrimEnd() -replace '(?i)(token|secret|key|password|signature)\s*[=:]\s*\S+','$1=<r>'; if($t.Length -gt 230){$t=$t.Substring(0,230)}; "  $t" } }
$h=Invoke-RestMethod http://127.0.0.1:9600/v1/host/state -TimeoutSec 20
$d=@($h.deployments | Where-Object { $_.id -match 'ef514ed3' })[0]
"DEP status=$($d.status) reason=$($d.reason) updatedAt=$($d.updatedAt) instance=$($d.isolation.instance) startedAt=$($d.isolation.startedAt) leaseUntil=$($d.leaseUntil)"
