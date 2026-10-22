$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(150);while(-not $t.WaitForExit(2000)){$t.Refresh();if($t.PrivateMemorySize64 -gt 512MB -or (Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o')}
Add-Type -AssemblyName System.Net.Http
$h=New-Object System.Net.Http.HttpClient;$h.Timeout=[TimeSpan]::FromSeconds(15)
$id='0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a'
function J($u){try{$h.GetStringAsync($u).GetAwaiter().GetResult()|ConvertFrom-Json}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};[pscustomobject]@{err=[string]$e.Message}}}
$hl=J 'http://127.0.0.1:8091/health'
$o.mgrErr=[string]$hl.err;$o.mgrEgress=[string]($hl.egress|ConvertTo-Json -Compress -Depth 2)
$v=J 'http://127.0.0.1:8091/vms'
$r=@($v.vms|Where-Object{[string]$_.name -eq $id})|Select-Object -First 1
if($r){$o.rec=[ordered]@{id=[string]$r.id;status=[string]$r.status;derivation=[string]$r.record.derivation;vm=[string]$r.handle.name;started=[string]$r.startedAt;hasEgress=[string]($null -ne $r.egress)}}else{$o.rec=[string]$v.err+' none'}
$vm=[string]$r.handle.name
if($vm -match '^[A-Za-z0-9._-]{1,128}$'){
$d=Join-Path $env:ProgramData 'Enclave\logs\partitions'
$pat='ipns-publisher|egress|127\.64|allowlist|GET failed|aborted|sequence|resolve|connect|refus|denied|front'
$sel=@(foreach($f in @("$d\$vm.log.1","$d\$vm.log")){if(Test-Path -LiteralPath $f){Get-Content -LiteralPath $f -Tail 4000|Where-Object{$_ -match $pat}}})|Select-Object -Last 60
$allow='^(delegated-ipfs\.dev|ipfs\.enclave\.host|cid\.contact|d9798e4c\.app\.enclave\.host|127\.[0-9.]+)$'
$o.lines=@($sel|ForEach-Object{$s=[string]$_ -replace '[^\x20-\x7e]','' -replace '\?[^\s"'']*','?<q>'
$s=[regex]::Replace($s,'https?://([^/\s"'':]+)[^\s"'']*',{param($m) if($m.Groups[1].Value -match $allow){$m.Value}else{'<url>'}})
$s=$s -replace '(?i)(key|token|secret|password|authorization|bearer|cred)([=: ]+)\S+','$1$2<redacted>' -replace '\b[0-9a-fA-F]{40,}\b','<hex>' -replace '\b[A-Za-z0-9+/_-]{43,}={0,2}','<b64>'
if($s.Length -gt 300){$s.Substring(0,300)}else{$s}})
$o.logFiles=@(foreach($f in @("$d\$vm.log.1","$d\$vm.log")){if(Test-Path -LiteralPath $f){$i=Get-Item -LiteralPath $f;"$($i.Name) $($i.Length) $($i.LastWriteTimeUtc.ToString('o'))"}})}
$o|ConvertTo-Json -Depth 4 -Compress
