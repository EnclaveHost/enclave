# judge-probe.tests.ps1 - the probe judge (uefi-dev-boot.ps1 Judge-Probe) against recorded and mutated console lines.
# Generated from the script's own functions; no VM, no host setting. Exit 0 when every expectation holds.
$ErrorActionPreference = 'Stop'
$script:notes = @()
function Note($m) { $script:notes += $m }
function Classify([string]$v) {
  if ($v -match 'READABLE|CONNECTED|OPENED|^CREATED$') { return 'BROKEN' }
  if ($v -match 'No such device or address') { return 'BROKEN' }
  if ($v -match '^(No such file or directory|Permission denied|Operation not permitted|Network is unreachable)$') { return 'DENIED' }
  return 'INCONCLUSIVE'
}
$ProbeBuilds = @{
# vsockLoopback: whether an in-guest vsock loopback transport exists. It is $false for both: the kernel 363b3553 IKCONFIG
# has CONFIG_VSOCKETS_LOOPBACK=m, and vsock_loopback.ko is in neither initrd (dominit never loads it), so CID 1 falls to
# hv_sock, which allows only CID 2. A build that ships the transport must say so here, and then a vsock refusal needs a
# positive control before it counts.
# hostSigner9001Probed: whether the build's domprobe tries the host's report signer (CID 2 port 9001). Until it does, no
# neighbour run can PASS (enclave-99's contract, main de2a9f66: the launcher's signature binds the PARTITION, not a domain).
  'a44bb55a89bb0e6d2757287032070662041a0952eaf3713901cedc92404717e4' = @{ initrd = '680d40fa'; domprobe = '0d12e950bd6d93f9'; tpm = $false; vsockLoopback = $false; hostSigner9001Probed = $false }
  'b7ba7731240ec9025f8c92651be17ecf8af17764e2c3eb0bd20af60f00923748' = @{ initrd = '1539d5b2'; domprobe = '2c2600495d07d292'; tpm = $true; vsockLoopback = $false; hostSigner9001Probed = $false }
}
function Judge-Probe($pr, $build, [bool]$neighbour) {
  $id = $pr.id; $fail = @(); $inc = @()
  $val = @{}; foreach ($l in $pr.lines) { if ($l -match "^PROBE$id ([a-z_0-9]+)=(.*)$") { $val[$matches[1]] = $matches[2] } }
  $req = @('other_app_absolute','other_app_relative','other_app_escape','other_front_socket','own_app','configfs_tsm','sysfs','create_tsm_entry','visible_pids','signalable_pids','report','vsock_local_domain1','vsock_local_domain2','vsock_own_control','vsock_host_control','host_gateway')
  if ($build.tpm) { $req += @('dev_tpm0','dev_tpmrm0') }
  foreach ($k in $req) { if (-not $val.ContainsKey($k)) { $fail += "$k MISSING" } }
  if (-not @($pr.lines | Where-Object { $_ -eq "PROBE$id done" }).Count) { $fail += 'done MISSING' }
  $uidl = @($pr.lines | Where-Object { $_ -match "^PROBE$id uid=(\d+) euid=(\d+)$" })
  if (-not $uidl.Count) { $fail += 'uid line MISSING' } elseif ($uidl[0] -match 'uid=0 |euid=0$') { $fail += "root: $($uidl[0])" } else { Note "  JUDGE uid: $($uidl[0]) (unprivileged)" }
  foreach ($k in @($val.Keys)) { if ($k -ne 'own_app' -and $k -ne 'report' -and (Classify $val[$k]) -eq 'BROKEN') { $fail += "$k=$($val[$k]) REACHED" } }
  if ($val.ContainsKey('own_app')) { if ($val['own_app'] -ne 'READABLE (6 bytes)') { $inc += "own_app=$($val['own_app']) (the view is not the one assumed)" } else { Note "  JUDGE own_app: READABLE (6 bytes): the view is the probe's own chroot (positive control)" } }
  foreach ($k in 'other_app_absolute','other_front_socket') {
    if ($val.ContainsKey($k) -and (Classify $val[$k]) -eq 'DENIED') {
      if ($neighbour) { $inc += "$k=$($val[$k]) (absent from the view; the target's existence in the root namespace is not stated)" }
      Note "  JUDGE ${k}: $($val[$k]) - absent from the domain's view$(if ($neighbour) { '; not a neighbour denial: target existence unshown' })"
    }
  }
  foreach ($k in 'other_app_relative','other_app_escape') { if ($val.ContainsKey($k)) { Note "  JUDGE ${k}: $($val[$k]) (inside a chroot this resolves to the absolute route: reported, not counted)" } }
  foreach ($k in 'vsock_local_domain1','vsock_local_domain2','vsock_own_control') {
    if (-not $val.ContainsKey($k) -or $val[$k] -match 'CONNECTED') { continue }
    if ($build.vsockLoopback -eq $false) { Note "  JUDGE ${k}: $($val[$k]) - NO IN-GUEST ROUTE on this build (the pin says no vsock loopback transport): neither denied nor broken, not counted" }
    else { $inc += "${k}=$($val[$k]) (this build has a vsock loopback transport: a refusal needs a positive control from a context allowed to connect)" }
  }
  if ($val.ContainsKey('vsock_host_control')) { Note "  JUDGE vsock_host_control: $($val['vsock_host_control']) - a host connection was ATTEMPTED (not refused inside the guest); nothing listens at host port 9000, so this is no service, not a denial" }
  if ($val.ContainsKey('host_gateway')) { Note "  JUDGE host_gateway: $($val['host_gateway']) - no route in the domain's network namespace (10.0.2.2 has no target on Hyper-V)" }
  foreach ($k in 'configfs_tsm','sysfs','create_tsm_entry','dev_tpm0','dev_tpmrm0') { if ($val.ContainsKey($k) -and (Classify $val[$k]) -ne 'BROKEN') { Note "  JUDGE ${k}: $($val[$k]) - absent from the domain's view; existence in the root namespace not stated" } }
  if ($val.ContainsKey('report')) {
    if ($val['report'] -eq 'granted-for-this-domain') {
      $b64 = @($pr.lines | Where-Object { $_ -match "^PROBE$id report_b64=(.+)$" } | ForEach-Object { $matches[1] }) | Select-Object -First 1
      $named = $null; try { $named = (([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))) | ConvertFrom-Json).doc.domain.appSha256 } catch { }
      $own = if ($pr.answer) { [string]$pr.answer.appSha256 } else { '' }
      if ($named -and $own -and $named -eq $own) { Note "  JUDGE report: granted, and it names THIS domain's app ($($own.Substring(0,16)))" } else { $fail += "report names app '$named', not this domain's '$own'" }
    } else { Note "  JUDGE report: $($val['report']) - refused by the monitor or the signer; not cross-domain evidence, and it never shows signer authorization" }
  }
  foreach ($k in @{ visible_pids = 3; signalable_pids = 2 }.GetEnumerator()) {
    if ($val.ContainsKey($k.Key)) { if ([int]$val[$k.Key] -gt $k.Value) { $fail += "$($k.Key)=$($val[$k.Key]) (over $($k.Value))" } else { Note "  JUDGE $($k.Key)=$($val[$k.Key]) (at most $($k.Value): its own tree)" } }
  }
  if (@($pr.console | Where-Object { $_ -match "^PROBE$id memory_UNCONTAINED" }).Count) { $fail += 'memory_UNCONTAINED' }
  else {
    $touched = @($pr.console | Where-Object { $_ -match "^PROBE$id memory_touched=(\d+) MiB" } | ForEach-Object { [int]$matches[1] }) | Measure-Object -Maximum
    $killed = [bool](@($pr.console | Where-Object { $_ -match "^DOM$id ERROR runtime exited status=137" }).Count)
    if ($touched.Maximum -ge 48 -and $killed) { Note "  JUDGE memory: CONTAINED - touched $($touched.Maximum) MiB of its 64 MiB cap, then killed (137)" }
    else { $inc += "memory containment not shown (max touched $($touched.Maximum), killed=$killed)" }
  }
  # the host's report signer: a launcher-signed report binds the PARTITION, not a domain (99's contract). A neighbour run
  # cannot PASS until the probe tries CID 2 port 9001 and is DENIED, while the monitor's own dial connects in the same run.
  if ($neighbour -and -not $build.hostSigner9001Probed) { $inc += 'host signer 9001: not probed (this domprobe has no route to it)' }
  $verdict = if ($fail.Count) { 'FAIL' } elseif ($inc.Count) { 'INCONCLUSIVE' } else { 'PASS' }
  return @{ verdict = $verdict; fail = $fail; inc = $inc }
}
$A44 = 'a44bb55a89bb0e6d2757287032070662041a0952eaf3713901cedc92404717e4'; $B7B = 'b7ba7731240ec9025f8c92651be17ecf8af17764e2c3eb0bd20af60f00923748'
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
Expect 'a neighbour run names the unprobed host signer' $REC $A44 $true 'INCONCLUSIVE' 'host signer 9001: not probed'
$LB = @{ initrd = 'x'; domprobe = 'x'; tpm = $false; vsockLoopback = $true; hostSigner9001Probed = $false }
$ProbeBuilds['loopback-build'] = $LB
Expect 'a build WITH vsock loopback: ENETUNREACH needs a positive control' $REC 'loopback-build' $false 'INCONCLUSIVE' 'needs a positive control'
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
"judge tests: $(if ($bad) { "$bad FAILED" } else { 'ALL OK' })"
exit $bad
