from pathlib import Path
p=Path(__file__).parent/'helper/node-hold-cutover.ps1'; s=p.read_text()
def change(a,b):
 global s
 assert s.count(a)==1,(a[:90],s.count(a)); s=s.replace(a,b)
change('function Lim($limitSec) { $l = [math]::Min($limitSec, (Left)); if ($Fwd) { $l = [math]::Min($l, (LeaseLeft)) }; return $l }', '''function ForwardLeft { [math]::Min(((Left) - [int]$PRM.lease.revertSec), (LeaseLeft)) }
function Lim($limitSec) { $l = [math]::Min($limitSec, (Left)); if ($Fwd) { $l = [math]::Min($l, (ForwardLeft)) }; return [math]::Max(0, $l) }
function NeedForward { if ($Fwd -and (ForwardLeft) -le 0) { throw 'forward deadline reached; reserved recovery time must not be consumed' } }
# Re-read AFTER identity checks, immediately before Stop-ScheduledTask. No mutation on unknown/short leases.
function BeforeStop {
  try {
    $h = Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Uri 'http://127.0.0.1:9600/v1/host/state'
    $ids = @($PRM.expectedIds); if (-not $ids.Count) { return 'no expected deployments' }
    $ends = @()
    foreach ($id in $ids) {
      $rows = @($h.deployments | Where-Object { [string]$_.id -eq [string]$id })
      if ($rows.Count -ne 1 -or [string]$rows[0].status -ne 'running') { return 'a deployment is missing, duplicated, or not running' }
      $v = $rows[0].leaseUntil
      if (-not ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) -or
          [double]::IsNaN([double]$v) -or [double]::IsInfinity([double]$v) -or [double]$v -le 0 -or [math]::Floor([double]$v) -ne [double]$v) { return 'a lease deadline is invalid' }
      $ends += [int64]$v
    }
    $script:LeaseEnd = ($ends | Measure-Object -Minimum).Minimum
    if ((ForwardLeft) -lt [int]$PRM.lease.forwardMinSec) { return 'lease/global forward budget insufficient immediately before stop' }
    return $null
  } catch { return 'fresh lease read unavailable immediately before stop' }
}''')
change("  Stop-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'Node'", """  if ($Fwd -and $phase -eq 'pins') { $refusal = BeforeStop; if ($refusal) { return ('REFUSED: ' + $refusal) } }
  # A task API may stop the task and then throw. Mark the mutation boundary BEFORE invoking it.
  if ($phase -eq 'pins') { $script:phase = 'stopping' }
  Stop-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'Node'""")
start=s.index('function StartNode($limitSec)'); end=s.index('# the NEW agent',start)
s=s[:start]+'''function StartNode($limitSec) {   # -> new process identities AND API response observed inside the available budget
  $budget = Lim $limitSec; if ($budget -le 0) { return $null }
  $lim = (Get-Date).AddSeconds($budget); $n = $null
  Start-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'Node'
  while (-not $n -and (Get-Date) -lt $lim) {
    $q = NodeProcs; if ((Get-Date) -ge $lim) { return $null }
    if ($q.cmd.Count -eq 1 -and $q.agent.Count -eq 1 -and $q.agent[0].parent -eq $q.cmd[0].pid) { $n = $q } else { Start-Sleep -Milliseconds 500 }
  }
  while ($n -and (Get-Date) -lt $lim) {
    $up = AgentUp
    if ((Get-Date) -ge $lim) { return $null }
    if ($up) { return [ordered]@{ cmd = $n.cmd[0]; agent = $n.agent[0] } }
    Start-Sleep -Seconds 1
  }
  return $null
}
function RestartPrivacy($pin, $limitSec) {
  $budget = Lim $limitSec; if ($budget -le 0) { return $null }
  $lim = (Get-Date).AddSeconds($budget)
  $pa = @(Privacy)
  # The identity query consumes this same budget; do not kill anything after it expired.
  if ((Get-Date) -ge $lim -or ($Fwd -and (ForwardLeft) -le 0) -or $pa.Count -ne 1 -or $pa[0].pid -ne $pin.pid -or $pa[0].start -ne $pin.start) { return $null }
  Stop-Process -Id $pin.pid -Force
  while ((Get-Date) -lt $lim) {
    Start-Sleep -Seconds 2; if ((Get-Date) -ge $lim) { break }
    $n = @(Privacy | Where-Object { $_.pid -ne $pin.pid -or $_.start -ne $pin.start })
    if ((Get-Date) -ge $lim) { return $null }
    if ($n.Count -eq 1) { return $n[0] }
  }
  return $null
}
''' + s[end:]
change("if ($Mode -eq 'cutover') {\n  if ((Sha $LOCAL)", """if ($Mode -eq 'cutover') {
  # This is only a NECESSARY floor: 90+90+150 are the explicit recovery waits alone.
  # Native stop/query/file overhead and renewal readiness STILL require separate proof before activation.
  if ($lp -and [int]$lp.revertSec -lt (90 + 90 + 150)) { $why += 'revert budget is shorter than its explicit 330-second waits (before native overhead)' }
  if ($lp -and ((Left) - [int]$lp.revertSec) -lt [int]$lp.forwardMinSec) { $why += 'global deadline leaves insufficient forward time after reserving recovery' }
  if ((Sha $LOCAL)""")
change('# ---------------------------------------------------------------- stop the node (both modes)\n$st =', '# ---------------------------------------------------------------- stop the node (both modes)\n$Fwd = ($Mode -eq \'cutover\')\n$st =')
change("if ($st -eq 'identity changed; nothing stopped')", "if ($st -like 'REFUSED:*') { Final $st ([ordered]@{ leaseFirstEnd = $LeaseEnd; forwardLeft = (ForwardLeft) }) }\nif ($st -eq 'identity changed; nothing stopped')")
change("$phase = 'configs'\nPrivDir", "$phase = 'configs'\nNeedForward\nPrivDir")
change("function CasWrite($path, $expect, [byte[]]$bytes) {\n", "function CasWrite($path, $expect, [byte[]]$bytes) {\n  NeedForward\n")
change("if ((LeaseLeft) -lt [int]$PRM.lease.startNodeSec) {", "if ((ForwardLeft) -lt [int]$PRM.lease.startNodeSec) {")
change('$r = Revert "LEASE: $([math]::Floor((LeaseLeft))) s', '$r = Revert "LEASE/GLOBAL: $([math]::Floor((ForwardLeft))) s')
change("$phase = 'enforcing'; $Fwd = $true", "$phase = 'enforcing'   # forward budgeting has been active since before the initial stop")
s=s.replace("# RestartPrivacy is NOT capped: the revert itself needs exactly one privacy agent (lease.forwardMinSec covers it).", "# Forward paths reserve recovery against BOTH deadlines. In recovery, Lim uses the remaining global budget.\n# The 330-second parameter floor is necessary, not a native timing proof. DO NOT ACTIVATE this revision on mocks alone.")
s=s.replace("# read every expected id's leaseUntil from the running node;", "# read every expected id's leaseUntil from the running node, again immediately before stopping it;")
p.write_text(s)
