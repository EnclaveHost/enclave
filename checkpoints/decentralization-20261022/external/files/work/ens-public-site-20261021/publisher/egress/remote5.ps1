$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(150);while(-not $t.WaitForExit(2000)){$t.Refresh();if($t.PrivateMemorySize64 -gt 768MB -or (Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o')}
$L=Join-Path $env:ProgramData 'Enclave\logs'
$allow='^(delegated-ipfs\.dev|ipfs\.enclave\.host|cid\.contact|d9798e4c\.app\.enclave\.host|127\.[0-9.]+)$'
function Redact([string]$s){$s=$s -replace '[^\x20-\x7e]','' -replace '\?[^\s"'']*','?<q>'
$s=[regex]::Replace($s,'https?://([^/\s"'':]+)[^\s"'']*',{param($m) if($m.Groups[1].Value -match $allow){$m.Value}else{'<url>'}})
$s=$s -replace '(?i)(key|token|secret|password|authorization|bearer|cred)([=: ]+)\S+','$1$2<redacted>' -replace '0xd9798e4c[0-9a-f]{54}','0xd9798e4c<id>' -replace '\b[0-9a-fA-F]{40,}\b','<hex>' -replace '\b[A-Za-z0-9+/_-]{43,}={0,2}','<b64>'
if($s.Length -gt 260){$s.Substring(0,260)}else{$s}}
foreach($n in 'network','shield','node'){$f="$L\$n.log";if(Test-Path -LiteralPath $f){$i=Get-Item -LiteralPath $f
$sel=@(Get-Content -LiteralPath $f -Tail 30000|Where-Object{$_ -match 'd9798e4c'})
$o["$n.log"]=[ordered]@{bytes=[long]$i.Length;mtime=$i.LastWriteTimeUtc.ToString('o');matches=$sel.Count;last=@($sel|Select-Object -Last 40|ForEach-Object{Redact $_})}}else{$o["$n.log"]='absent'}}
$rf=Join-Path $env:ProgramData 'Enclave\network\state\egress-routes.json'
if(Test-Path -LiteralPath $rf){$i=Get-Item -LiteralPath $rf;$j=[IO.File]::ReadAllText($rf)|ConvertFrom-Json;$now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$ids=@($j.apps.PSObject.Properties|ForEach-Object{$_.Name})
$o.routes=[ordered]@{mtime=$i.LastWriteTimeUtc.ToString('o');version=[int]$j.version;expiresInMs=[long]($j.expiresAt-$now);apps=$ids.Count;hasD9798e4c=[bool]($ids -contains '0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a')}}else{$o.routes='absent'}
$o|ConvertTo-Json -Depth 4 -Compress
