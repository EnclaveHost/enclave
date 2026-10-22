$ErrorActionPreference='Stop'
# READ-ONLY (host-queue, 2026-10-21): sia-s3 0xef514ed3 live deployment facts, its egress-route entry, network.log near
# the 18:30:08-18:30:45Z direct-r2 upload, and the partition console. Secret-looking keys/values are redacted; env = names.
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(100);while(-not $t.WaitForExit(2000)){if((Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
$sec='(?i)key|secret|token|psk|priv|pass|cred|seed|sig|auth|cookie|mnemonic|phrase'
function Show($o,$p,$d){ if($d -gt 5){return}
  if($o -is [Management.Automation.PSCustomObject]){ foreach($n in $o.PSObject.Properties.Name){ $v=$o.$n
      if($n -match $sec){ Write-Output "$p.$n=<redacted>"; continue }
      if($n -match '^(?i)env$|environment'){ $names=@(); if($v -is [Management.Automation.PSCustomObject]){$names=@($v.PSObject.Properties.Name)} elseif($v){$names=@($v|ForEach-Object{ "$_" -replace '=.*$','' })}; Write-Output "$p.$n NAMES=$($names -join ',')"; continue }
      Show $v "$p.$n" ($d+1) } }
  elseif($o -is [Array]){ Write-Output "$p count=$($o.Count)"; $i=0; foreach($x in ($o|Select-Object -First 12)){ Show $x "$p[$i]" ($d+1); $i++ } }
  else { $s="$o"; if($s.Length -gt 120){$s=$s.Substring(0,120)+'...'}; Write-Output "$p=$s" } }
Write-Output "NOW $((Get-Date).ToUniversalTime().ToString('o'))"
$h=Invoke-RestMethod http://127.0.0.1:9600/v1/host/state -TimeoutSec 20
$d=@($h.deployments | Where-Object { "$($_.id)$($_.deploymentId)" -match '0xef514ed3' })
Write-Output "== DEPLOYMENT (count $($d.Count))"; foreach($x in $d){ Show $x 'dep' 0 }
$rp=Join-Path $env:ProgramData 'Enclave\network\state\egress-routes.json'
Write-Output "== EGRESS-ROUTES $((Get-Item $rp).LastWriteTimeUtc.ToString('o'))"
$r=[IO.File]::ReadAllText($rp)|ConvertFrom-Json
foreach($n in $r.PSObject.Properties.Name){ if($n -match 'ef514ed3'){ Show $r.$n "routes.$n" 0 } elseif($r.$n -is [Management.Automation.PSCustomObject]){ foreach($m in $r.$n.PSObject.Properties.Name){ if($m -match 'ef514ed3'){ Show $r.$n.$m "routes.$n.$m" 0 } } } }
Write-Output ("routes top keys: "+((@($r.PSObject.Properties.Name) -join ",") -replace "^(.{0,400}).*$",'$1'))
