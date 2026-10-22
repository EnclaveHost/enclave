$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(90);while(-not $t.WaitForExit(2000)){$t.Refresh();if($t.PrivateMemorySize64 -gt 512MB -or (Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
Add-Type -AssemblyName System.Net.Http
$h=New-Object System.Net.Http.HttpClient;$h.Timeout=[TimeSpan]::FromSeconds(15)
$id='0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a'
$o=[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o')}
try{$v=$h.GetStringAsync('http://127.0.0.1:8091/vms').GetAwaiter().GetResult()|ConvertFrom-Json;$all=@($v.vms);$o.vmsCount=$all.Count
$r=@($all|Where-Object{[string]$_.name -eq $id});$o.ourRecords=@($r|ForEach-Object{"$([string]$_.id) $([string]$_.status) $([string]$_.startedAt)"})}catch{$o.vmsErr=[string]$_.Exception.Message}
try{$s=$h.GetStringAsync('https://d9798e4c.app.enclave.host/api/status').GetAwaiter().GetResult()|ConvertFrom-Json
$o.pub=[ordered]@{sequence=[string]$s.sequence;value=[string]$s.value;recovered=[string]($s.recovered|ConvertTo-Json -Compress);delegates=[string]($s.delegates|ConvertTo-Json -Compress);mode=[string]$s.mode;uptime=[string]$s.uptimeSecs;lastError=[string]$s.lastError}}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};$o.pubErr=[string]$e.Message}
$o|ConvertTo-Json -Depth 3 -Compress
