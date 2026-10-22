$ErrorActionPreference='Stop'
$r='C:\ProgramData\Enclave\host-services\hs2\upgrades'
$l=Join-Path $r 'active.lock'
$run='';if(Test-Path $l){$run=[IO.File]::ReadAllText($l).Trim()}
$j=$null;if($run -match '^\d{14}-[0-9a-f]{8}$'){$p=Join-Path (Join-Path $r $run) 'journal.json';if(Test-Path $p){$x=[IO.File]::ReadAllText($p)|ConvertFrom-Json;$j=@{phase=$x.phase;manifest=$x.manifest}}}
$t=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'enclave-host-services-hs2'
@{at=[DateTime]::UtcNow.ToString('o');run=$run;task=[string]$t.State;journal=$j}|ConvertTo-Json -Compress -Depth 4
