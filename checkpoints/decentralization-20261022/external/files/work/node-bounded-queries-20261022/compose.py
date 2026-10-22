from pathlib import Path
import shutil
r=Path(__file__).resolve().parent;w=r.parent;src=w/'node-prepared-config-20261022'
for name in ['tools/cutover-mock.ps1','tools/cutover-mock-test.py','tools/preparation-test.py','run-tests.sh']:
 shutil.copy2(src/name,r/name)
s=(src/'helper/node-hold-cutover.ps1').read_text()
start=s.index('function Utc(');end=s.index('function Others ',start)
new=(w/'native-cutover-ops-20261022/bounded-query.ps1').read_text()+r'''
# Only read-only process/listener queries cross this boundary. Lifecycle mutations are never sent to an uncertain child.
function Query([scriptblock]$body, [double]$limitSec = 15) {
  $ms = [int][math]::Floor(1000 * (Lim ([math]::Min(15, $limitSec))))
  if ($ms -lt 2500) { throw 'not enough time for a query and confirmed child cleanup' }
  $r = Invoke-BoundedQuery $body $ms
  if (-not $r.ok) { throw ('read-only native query failed: ' + $r.reason) }
  $r.value
}
function Utc($p) { if ($p.CreationDate -is [datetime]) { $p.CreationDate.ToUniversalTime().ToString('o') } else { Iso $p.CreationDate } }
function ProcessRows([string]$filter, [double]$limitSec = 15) {
  $quoted = "'" + $filter.Replace("'", "''") + "'"
  $code = 'Get-CimInstance Win32_Process -Filter ' + $quoted + ' -OperationTimeoutSec 5 | ForEach-Object { [ordered]@{ProcessId=[int]$_.ProcessId;ParentProcessId=[int]$_.ParentProcessId;Name=[string]$_.Name;CommandLine=[string]$_.CommandLine;CreationDate=$_.CreationDate.ToUniversalTime().ToString("o")} }'
  Query ([scriptblock]::Create($code)) $limitSec
}
function ById($procId, [double]$limitSec = 15) {
  if ($TR) { Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -OperationTimeoutSec 20 }
  else { ProcessRows ("ProcessId=" + [int]$procId) $limitSec }
}
function Same($procId, $start, $name, $pat, $parent, [double]$limitSec = 15) {
  $p = ById $procId $limitSec
  return [bool]($p -and (Utc $p) -eq $start -and [string]$p.Name -eq $name -and [string]$p.CommandLine -like $pat -and ($parent -eq 0 -or [int]$p.ParentProcessId -eq $parent)) }
function NodeProcs([double]$limitSec = 15) {
  if ($TR) {
    $cm = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -like $RUN_PAT })
    $nd = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -like $AGENT_PAT })
  } else {
    $all = @(ProcessRows "Name='cmd.exe' OR Name='node.exe'" $limitSec)
    $cm = @($all | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like $RUN_PAT })
    $nd = @($all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like $AGENT_PAT })
  }
  [ordered]@{ cmd = @($cm | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; start = (Utc $_) } })
              agent = @($nd | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; start = (Utc $_) } }) } }
function Privacy([double]$limitSec = 15) {
  $all = $(if ($TR) { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20) } else { @(ProcessRows "Name='node.exe'" $limitSec) })
  @($all | Where-Object { [string]$_.CommandLine -match 'privacy-agent\.mjs' } | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; start = (Utc $_) } }) }
function Listeners([int]$port, [double]$limitSec = 15) {
  if ($TR) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop }
  else {
    $code = 'Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter "LocalPort=' + $port + ' AND State=2" -OperationTimeoutSec 5 | ForEach-Object { [ordered]@{OwningProcess=[int]$_.OwningProcess} }'
    Query ([scriptblock]::Create($code)) $limitSec
  }
}
function Manager { $c = @(Listeners 8091)
  if ($c.Count -ne 1) { return 'unavailable' }; $p = ById $c[0].OwningProcess; if (-not $p) { return 'unavailable' }; "$($p.ProcessId)@$(Utc $p)" }
'''
s=s[:start]+new+s[end:]
s=s.replace('function AgentUp($agent) {','function AgentUp($agent, [double]$limitSec = 15) {')
s=s.replace('$listeners = @(Get-NetTCPConnection -LocalPort 9600 -State Listen -ErrorAction Stop)', '$listeners = @(Listeners 9600 $limitSec)')
s=s.replace('$same = Same $pin.pid $pin.start $name $pat $parent', '$same = Same $pin.pid $pin.start $name $pat $parent (($lim - (Get-Date)).TotalSeconds)')
s=s.replace('$q = NodeProcs; if ((Get-Date) -ge $lim)', '$q = NodeProcs (($lim - (Get-Date)).TotalSeconds); if ((Get-Date) -ge $lim)')
s=s.replace('$up = AgentUp $n.agent[0]', '$up = AgentUp $n.agent[0] (($lim - (Get-Date)).TotalSeconds)')
s=s.replace('$pa = @(Privacy)\n  # The identity query', '$pa = @(Privacy (($lim - (Get-Date)).TotalSeconds))\n  # The identity query')
s=s.replace('$n = @(Privacy | Where-Object', '$n = @(Privacy (($lim - (Get-Date)).TotalSeconds) | Where-Object')
s=s.replace('function Query([scriptblock]$body, [double]$limitSec = 15) {\n',"function Query([scriptblock]$body, [double]$limitSec = 15) {\n  if ($script:QueryCleanupFailed) { throw 'previous query child exit unconfirmed; no further reader will be launched' }\n")
s=s.replace("  if (-not $r.ok) { throw ('read-only native query failed: ' + $r.reason) }","  if (-not $r.childExited) { $script:QueryCleanupFailed = $true }\n  if (-not $r.ok) { throw ('read-only native query failed: ' + $r.reason) }")
s=s.replace('    return (LeaseReady $h (IsoMs $agent.start))\n  } catch { return $false }','    return (LeaseReady $h (IsoMs $agent.start))\n  } catch { if ($script:QueryCleanupFailed) { throw }; return $false }')
(r/'helper/node-hold-cutover.ps1').write_text(s)
print('Composed cutover with exact native-tested read-only query boundary.')
