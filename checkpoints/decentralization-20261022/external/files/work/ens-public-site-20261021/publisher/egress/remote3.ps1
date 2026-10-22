$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$null=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',('$t=Get-Process -Id PIDX;$e=(Get-Date).AddSeconds(90);while(-not $t.WaitForExit(2000)){$t.Refresh();if($t.PrivateMemorySize64 -gt 512MB -or (Get-Date) -gt $e){$t.Kill();break}}' -replace 'PIDX',$PID))
Add-Type -AssemblyName System.Net.Http
$h=New-Object System.Net.Http.HttpClient;$h.Timeout=[TimeSpan]::FromSeconds(15)
$id='0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a'
$v=$h.GetStringAsync('http://127.0.0.1:8091/vms').GetAwaiter().GetResult()|ConvertFrom-Json
$r=@($v.vms|Where-Object{[string]$_.name -eq $id})|Select-Object -First 1
$out=New-Object System.Collections.Generic.List[string]
function W($obj,[string]$pre,[int]$depth){if($depth -gt 3 -or $null -eq $obj){return};foreach($p in $obj.PSObject.Properties){$n="$pre$($p.Name)";$x=$p.Value
if($x -is [string] -or $x -is [bool] -or $x -is [int] -or $x -is [long] -or $x -is [double] -or $x -is [decimal]){$s=[string]$x -replace '(?i)^(.{0,0})(.*(key|token|secret|cred|password).*)$','<redacted>' -replace '[0-9a-fA-F]{40,}','<hex>' -replace '[A-Za-z0-9+/_-]{43,}={0,2}','<b64>';if($n -match '(?i)key|token|secret|cred|password|config|env'){$s='<omitted>'};if($s.Length -gt 120){$s=$s.Substring(0,120)};$out.Add("$n=$s")}
elseif($x -is [System.Management.Automation.PSCustomObject]){W $x "$n." ($depth+1)}
elseif($x -is [array]){$out.Add("$n=[array $($x.Count)]")}}}
if($r){W $r '' 0}else{$out.Add('not found')}
@($out)|ConvertTo-Json -Compress
