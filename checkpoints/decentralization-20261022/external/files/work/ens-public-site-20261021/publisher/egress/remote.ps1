$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(150);while(-not $t.WaitForExit(2000)){$t.Refresh();if($t.PrivateMemorySize64 -gt 512MB -or (Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o')}
Add-Type -AssemblyName System.Net.Http
$h=New-Object System.Net.Http.HttpClient;$h.Timeout=[TimeSpan]::FromSeconds(20)
function G([string]$u,[string]$acc){$r=[ordered]@{url=$u};$sw=[Diagnostics.Stopwatch]::StartNew();try{$m=New-Object System.Net.Http.HttpRequestMessage('GET',$u);if($acc){$m.Headers.Add('Accept',$acc)};$x=$h.SendAsync($m).GetAwaiter().GetResult();$r.status=[int]$x.StatusCode;$b=$x.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();$r.bytes=$b.Length;$r.body=[string]$(if($b.Length -lt 120){[Text.Encoding]::ASCII.GetString($b).Trim()})}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};$r.error=[string]($e.GetType().Name+': '+$e.Message)};$r.ms=[int]$sw.ElapsedMilliseconds;$r}
$hl=G 'http://127.0.0.1:9600/v1/health' $null
$o.agentHealth=[ordered]@{status=$hl.status;error=$hl.error}
if($hl.status -eq 200){$x=$h.GetStringAsync('http://127.0.0.1:9600/v1/health').GetAwaiter().GetResult()|ConvertFrom-Json;$o.agentRole=[string]$x.role;$o.agentOk=[string]$x.ok}
$id='0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a'
try{$t=$h.GetStringAsync("http://127.0.0.1:9600/v1/deployments/$id/logs").GetAwaiter().GetResult();$j=$t|ConvertFrom-Json;$ls=@($j.lines|ForEach-Object{[string]$_})
$o.logLinesTotal=$ls.Count
$pat='GET |aborted|sequence|no record|verification|accepted|publishing as|value: |IPNI|egress|resolve|connect|UNCONFIGURED|state file|enclave|serving|stop|error|fail'
$allow='^(delegated-ipfs\.dev|ipfs\.enclave\.host|cid\.contact|d9798e4c\.app\.enclave\.host|127\.0\.0\.1)$'
$sel=@($ls|Where-Object{$_ -match $pat}|Select-Object -Last 60|ForEach-Object{$s=$_ -replace '\?[^\s"'']*','?<q>'
$s=[regex]::Replace($s,'https?://([^/\s"'':]+)[^\s"'']*',{param($m) if($m.Groups[1].Value -match $allow){$m.Value}else{'<url>'}})
$s=$s -replace '(?i)(key|token|secret|password|authorization|bearer)([=: ]+)\S+','$1$2<redacted>'
$s=$s -replace '\b[0-9a-fA-F]{40,}\b','<hex>' -replace '\b[A-Za-z0-9+/_-]{43,}={0,2}','<b64>'
$s})
$o.filtered=$sel;$o.filteredCount=$sel.Count}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};$o.logsError=[string]($e.GetType().Name+': '+$e.Message)}
$o.publicDelegate=G 'https://delegated-ipfs.dev/routing/v1/ipns/k51qzi5uqu5dma8l0w05o02gkz7l80f3r3mb536qh8fuhrr2qj4nsa2afe9b52' 'application/vnd.ipfs.ipns-record'
$o.publicDelegate.Remove('body')
$o.publicSiteRoot=G 'https://ipfs.enclave.host/site-root' $null
$o|ConvertTo-Json -Depth 4 -Compress
