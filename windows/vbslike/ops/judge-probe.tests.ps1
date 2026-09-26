# judge-probe.tests.ps1 - the probe judge (uefi-dev-boot.ps1 Judge-Probe) against recorded and mutated console lines.
# Generated from the script's own functions; no VM, no host setting. Exit 0 when every expectation holds.
$ErrorActionPreference = 'Stop'
$script:notes = @()
function Note($m) { $script:notes += $m }
# THE JUDGE UNDER TEST is the script's OWN (Classify, Judge-Probe, $ProbeBuilds), read out of uefi-dev-boot.ps1's syntax
# tree, never a copy: a copy had already drifted (it lacked 0891c740 and 49500527) and would have tested itself.
$src = Join-Path $PSScriptRoot 'uefi-dev-boot.ps1'
$tok = $null; $perr = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($src, [ref]$tok, [ref]$perr)
if ($perr.Count) { throw "uefi-dev-boot.ps1 does not parse: $($perr[0].Message)" }
foreach ($fn in 'Classify','Judge-Probe') {
  $f = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $fn }, $true))
  if ($f.Count -ne 1) { throw "uefi-dev-boot.ps1 defines $fn $($f.Count) times" }
  Invoke-Expression $f[0].Extent.Text
}
$pb = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and "$($n.Left)" -eq '$ProbeBuilds' }, $true))
if ($pb.Count -ne 1) { throw "uefi-dev-boot.ps1 assigns `$ProbeBuilds $($pb.Count) times" }
Invoke-Expression $pb[0].Extent.Text

$A44 = 'a44bb55a89bb0e6d2757287032070662041a0952eaf3713901cedc92404717e4'; $B7B = 'b7ba7731240ec9025f8c92651be17ecf8af17764e2c3eb0bd20af60f00923748'
$L49 = '4950052785daf26d9c712a710f118211c853a04e03c01b8d77d8ac44a50327ab'
$REC = @(
  'MON domain 2 loaded label=PROBE app_sha256=25be323556dad377abb57fe7ec8c4b99a6527f488dda28d0c9b686528659c909 port=40002 uid=5002 cpu=50% mem=64MiB mode=serve http=0'
  'MON refused report request from uid 0 (not a domain)'
  'DOM2 report_as_root=refused'
  'DOM2 started adversary probe=2 (no app, no front)'
  'PROBE2 uid=5002 euid=5002'
  'PROBE2 other_app_absolute=No such file or directory'
  'PROBE2 other_app_relative=No such file or directory'
  'PROBE2 other_app_escape=No such file or directory'
  'PROBE2 other_front_socket=No such file or directory'
  'PROBE2 own_app=READABLE (6 bytes)'
  'PROBE2 configfs_tsm=No such file or directory'
  'PROBE2 sysfs=No such file or directory'
  'PROBE2 create_tsm_entry=No such file or directory'
  'PROBE2 visible_pids=2'
  'PROBE2 signalable_pids=1'
  'PROBE2 report=refused'
  'PROBE2 vsock_local_domain1=Network is unreachable'
  'PROBE2 vsock_local_domain2=Network is unreachable'
  'PROBE2 vsock_own_control=Network is unreachable'
  'DOM2 probe workload_uid=5002 sys=0 configfs=0 domains_dir=0 own_app=1 visible_pids=2'
  'PROBE2 vsock_host_control=timed out (no answer)'
  'PROBE2 own_loopback_8080=Connection refused'
  'PROBE2 host_gateway=Network is unreachable'
  'PROBE2 done'
  'PROBE2 eating memory: cap 64 MiB, will try 256 MiB'
  'PROBE2 memory_touched=16 MiB'
  'PROBE2 memory_touched=32 MiB'
  'PROBE2 memory_touched=48 MiB'
  'DOM2 ERROR runtime exited status=137'
  'DOM2 end'
  'MON domain 2 ended: its process tree exited'
)
function Pr($console) { @{ id = 2; boot = 'x'; console = @($console); lines = @($console | Where-Object { $_ -match '^PROBE2 ' }); answer = @{ appSha256 = '25be323556dad377abb57fe7ec8c4b99a6527f488dda28d0c9b686528659c909' } } }
function Sub($from, $to) { @($REC | ForEach-Object { if ($_ -eq $from) { $to } else { $_ } }) }
$bad = 0
function Expect($name, $console, $build, [bool]$nbr, $verdict, $pattern) {
  $script:notes = @()
  $j = Judge-Probe (Pr $console) $ProbeBuilds[$build] $nbr
  $all = ($j.fail + $j.inc + $script:notes) -join ' | '
  $ok = ($j.verdict -eq $verdict) -and (-not $pattern -or $all -match $pattern)
  if (-not $ok) { $script:bad++ }
  "{0} {1}: {2}{3}" -f $(if ($ok) { 'ok  ' } else { 'FAIL' }), $name, $j.verdict, $(if ($ok) { '' } else { "  (wanted $verdict /$pattern/) :: $all" })
}
Expect 'run 093326 as recorded, with a neighbour (a44bb55a)' $REC $A44 $true 'INCONCLUSIVE' 'target''s existence in the root namespace is not stated'
Expect 'run 093326 lines judged own-view only (a44bb55a)' $REC $A44 $false 'PASS' 'CONTAINED'
Expect 'the same lines on the b7ba7731 build: TPM lines required' $REC $B7B $false 'FAIL' 'dev_tpm0 MISSING'
Expect 'a neighbour file READABLE' (Sub 'PROBE2 other_app_absolute=No such file or directory' 'PROBE2 other_app_absolute=READABLE (73228 bytes)') $A44 $true 'FAIL' 'REACHED'
Expect 'the neighbour socket visible (ENXIO)' (Sub 'PROBE2 other_front_socket=No such file or directory' 'PROBE2 other_front_socket=No such device or address') $A44 $true 'FAIL' 'REACHED'
Expect 'vsock CONNECTED' (Sub 'PROBE2 vsock_local_domain1=Network is unreachable' 'PROBE2 vsock_local_domain1=CONNECTED') $A44 $false 'FAIL' 'REACHED'
Expect 'own_app not readable: the view is not the assumed one' (Sub 'PROBE2 own_app=READABLE (6 bytes)' 'PROBE2 own_app=No such file or directory') $A44 $false 'INCONCLUSIVE' 'view is not the one assumed'
Expect 'too many visible pids' (Sub 'PROBE2 visible_pids=2' 'PROBE2 visible_pids=7') $A44 $false 'FAIL' 'visible_pids=7'
Expect 'a root uid' (Sub 'PROBE2 uid=5002 euid=5002' 'PROBE2 uid=0 euid=0') $A44 $false 'FAIL' 'root'
Expect 'memory not killed: not shown' @($REC | Where-Object { $_ -notmatch 'status=137' }) $A44 $false 'INCONCLUSIVE' 'memory containment not shown'
Expect 'memory UNCONTAINED' ($REC + 'PROBE2 memory_UNCONTAINED=256 MiB touched without being stopped') $A44 $false 'FAIL' 'memory_UNCONTAINED'
Expect 'a missing line' @($REC | Where-Object { $_ -notmatch 'vsock_host_control' }) $A44 $false 'FAIL' 'vsock_host_control MISSING'
Expect 'no done' @($REC | Where-Object { $_ -ne 'PROBE2 done' }) $A44 $false 'FAIL' 'done MISSING'
$other = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"doc":{"domain":{"appSha256":"9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45"}}}'))
$own = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"doc":{"domain":{"appSha256":"25be323556dad377abb57fe7ec8c4b99a6527f488dda28d0c9b686528659c909"}}}'))
Expect 'a report naming the NEIGHBOUR app' ((Sub 'PROBE2 report=refused' 'PROBE2 report=granted-for-this-domain') + "PROBE2 report_b64=$other") $A44 $false 'FAIL' 'report names app'
Expect 'a report naming its own app' ((Sub 'PROBE2 report=refused' 'PROBE2 report=granted-for-this-domain') + "PROBE2 report_b64=$own") $A44 $false 'PASS' 'names THIS domain'
# THE TWO-LAYER BUILD (49500527: domprobe 650caedea6d2fe3d from 0c087de8, front-uid layout). Its lines are 093326's with
# the TPM opens, the report REFUSED by /run's mode, and the same vsock reaches again under the runtime's seccomp filter;
# the values are the ones isolation/m3/test-domprobe-layers.sh reads on this layout, and Hyper-V's own for the base lines.
$LREC = @($REC | ForEach-Object {
  if ($_ -eq 'PROBE2 report=refused') { 'PROBE2 dev_tpm0=No such file or directory'; 'PROBE2 dev_tpmrm0=No such file or directory'; 'PROBE2 report=Permission denied' }
  elseif ($_ -eq 'PROBE2 host_gateway=Network is unreachable') {
    $_; 'PROBE2 seccomp=2'
    'PROBE2 filtered_vsock_local_domain1=Operation not permitted'; 'PROBE2 filtered_vsock_local_domain2=Operation not permitted'
    'PROBE2 filtered_vsock_own_control=Operation not permitted'; 'PROBE2 filtered_vsock_host_control=Operation not permitted'
    'PROBE2 filtered_report=Permission denied'
  } else { $_ } })
function LSub($from, $to) { @($LREC | ForEach-Object { if ($_ -eq $from) { $to } else { $_ } }) }
Expect 'two layers: the expected lines, own view' $LREC $L49 $false 'PASS' 'filtered_vsock_host_control: Operation not permitted - refused by the runtime.s seccomp filter \(unfiltered: timed out'
Expect 'two layers: the expected lines, with a neighbour' $LREC $L49 $true 'INCONCLUSIVE' 'target''s existence in the root namespace is not stated'
Expect 'two layers: the report GRANTED naming its own app FAILS (the runtime must be refused)' ((LSub 'PROBE2 report=Permission denied' 'PROBE2 report=granted-for-this-domain') + "PROBE2 report_b64=$own") $L49 $false 'FAIL' 'report=granted: the RUNTIME obtained a report'
Expect 'two layers: filtered_report GRANTED fails' (LSub 'PROBE2 filtered_report=Permission denied' 'PROBE2 filtered_report=granted-for-this-domain') $L49 $false 'FAIL' 'filtered_report=granted'
Expect 'two layers: a report_b64 line alone fails' ($LREC + "PROBE2 report_b64=$own") $L49 $false 'FAIL' 'report_b64 printed'
Expect 'two layers: report refused by the monitor (reached it)' (LSub 'PROBE2 report=Permission denied' 'PROBE2 report=refused') $L49 $false 'PASS' 'report: refused - the runtime is REFUSED'
Expect 'two layers: report no-answer does not show the refusal' (LSub 'PROBE2 report=Permission denied' 'PROBE2 report=no-answer') $L49 $false 'INCONCLUSIVE' 'report=no-answer \(the runtime.s refusal is not shown\)'
Expect 'two layers: seccomp not installed' (LSub 'PROBE2 seccomp=2' 'PROBE2 seccomp=Invalid argument') $L49 $false 'FAIL' 'seccomp=Invalid argument: the runtime.s filter was not installed'
Expect 'two layers: seccomp mode 0' (LSub 'PROBE2 seccomp=2' 'PROBE2 seccomp=0') $L49 $false 'FAIL' 'seccomp=0'
Expect 'two layers: the filter let the host vsock connect out' (LSub 'PROBE2 filtered_vsock_host_control=Operation not permitted' 'PROBE2 filtered_vsock_host_control=timed out (no answer)') $L49 $false 'FAIL' 'filtered_vsock_host_control=timed out \(no answer\): the runtime.s filter did not refuse it'
Expect 'two layers: a filtered vsock CONNECTED' (LSub 'PROBE2 filtered_vsock_local_domain1=Operation not permitted' 'PROBE2 filtered_vsock_local_domain1=CONNECTED') $L49 $false 'FAIL' 'filtered_vsock_local_domain1=CONNECTED REACHED'
Expect 'two layers: the base line already EPERM (layers not told apart)' (LSub 'PROBE2 vsock_host_control=timed out (no answer)' 'PROBE2 vsock_host_control=Operation not permitted') $L49 $false 'INCONCLUSIVE' 'vsock_host_control=Operation not permitted UNFILTERED'
Expect 'two layers: a filtered line missing' @($LREC | Where-Object { $_ -notmatch 'filtered_vsock_own_control' }) $L49 $false 'FAIL' 'filtered_vsock_own_control MISSING'
Expect 'two layers: the seccomp line missing' @($LREC | Where-Object { $_ -ne 'PROBE2 seccomp=2' }) $L49 $false 'FAIL' 'seccomp MISSING'
Expect 'two layers: the one-layer output (093326 + TPM) on this build fails' (@($REC | ForEach-Object { if ($_ -eq 'PROBE2 report=refused') { 'PROBE2 dev_tpm0=No such file or directory'; 'PROBE2 dev_tpmrm0=No such file or directory'; $_ } else { $_ } })) $L49 $false 'FAIL' 'filtered_report MISSING'
Expect 'one-layer build unchanged: two-layer lines on a44bb55a are judged by the old report rule' ((Sub 'PROBE2 report=refused' 'PROBE2 report=granted-for-this-domain') + "PROBE2 report_b64=$own") $A44 $false 'PASS' 'names THIS domain'
"judge tests: $(if ($bad) { "$bad FAILED" } else { 'ALL OK' })"
exit $bad
