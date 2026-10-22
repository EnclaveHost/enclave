from pathlib import Path
import shutil
r=Path(__file__).resolve().parent;src=r.parent/'node-bounded-queries-20261022'
for name in ['tools/cutover-mock.ps1','tools/cutover-mock-test.py','tools/preparation-test.py','run-tests.sh']:
 shutil.copy2(src/name,r/name)
s=(src/'helper/node-hold-cutover.ps1').read_text()
a=s.index('function Vms {');b=s.index('function HyperV ',a)
s=s[:a]+r'''# Project only the fields needed by the cutover. No app configuration enters the query result.
function HostState([double]$limitSec = 10) {
  if ($TR) { return (Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:9600/v1/host/state') }
  Query {
    $h = Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:9600/v1/host/state'
    [ordered]@{ deployments = @($h.deployments | ForEach-Object { [ordered]@{id=$_.id;status=$_.status;leaseUntil=$_.leaseUntil} }); leaseReadiness=$h.leaseReadiness }
  } $limitSec
}
function Vms {
  try {
    if ($TR) { $rows = @((Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:8091/vms').vms) }
    else { $rows = @(Query { (Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:8091/vms').vms | ForEach-Object { [ordered]@{id=$_.id;name=$_.name;status=$_.status} } } 10) }
    @($rows | ForEach-Object { "$($_.id)|$($_.name)|$($_.status)" } | Sort-Object) -join ','
  } catch { if ($script:QueryCleanupFailed) { throw }; 'unavailable' }
}
''' + s[b:]
s=s.replace("$h = Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:9600/v1/host/state'", "$h = HostState 10",1)
s=s.replace("$hs = Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:9600/v1/host/state'", "$hs = HostState 10",1)
a=s.index('function AgentUp(');b=s.index('function Status ',a)
s=s[:a]+r'''function AgentUp($agent, [double]$limitSec = 15) {
  # Listener ownership and HTTP response share ONE phase deadline; neither gets a fresh budget after the other.
  $lim = (Get-Date).AddSeconds((Lim $limitSec))
  try {
    $listeners = @(Listeners 9600 (($lim - (Get-Date)).TotalSeconds))
    if ((Get-Date) -ge $lim -or $listeners.Count -ne 1 -or [int]$listeners[0].OwningProcess -ne [int]$agent.pid) { return $false }
    $h = HostState (($lim - (Get-Date)).TotalSeconds)
    if ((Get-Date) -ge $lim) { return $false }
    return (LeaseReady $h (IsoMs $agent.start))
  } catch { if ($script:QueryCleanupFailed) { throw }; return $false }
}
''' + s[b:]
(r/'helper/node-hold-cutover.ps1').write_text(s)
print('Composed shared listener/HTTP deadline with projected host state.')
