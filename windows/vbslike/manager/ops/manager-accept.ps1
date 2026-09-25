# manager-accept.ps1 - run ONE node acceptance driver (default: ops\restart-accept.mjs) against the REAL manager on this
# host, under the same bounds as manager-launcher-canary.ps1:
#   - ONE RUN AT A TIME: the shared lock C:\Users\claude\uefi-probe.lock, taken first; a stale sentinel is refused.
#   - A CLEAN START: refused if any VM carries the manager's marker or Notes identity, or starts with enclave-app-.
#   - AllowFirmwareLoadFromFile TEMPORARY: applied for the run, restored to its exact prior state, verified.
#   - A WATCHDOG (pid + start time): if this process ends without cleaning up, or hangs past the ceiling, it kills
#     node processes running from THIS run's tree (by path, never by a broad name), removes manager-owned VMs, and
#     restores the setting.
# Exit: 0 the driver passed and cleanup verified; 3 the driver refused (nothing touched); 2 the driver failed but
# cleanup verified; 1 cleanup failed. Not an isolation result: host_excluded=no.
param(
  [Parameter(Mandatory = $true)][string] $Tree,
  [Parameter(Mandatory = $true)][string] $Pkg,
  [string] $Driver = 'windows\vbslike\manager\ops\restart-accept.mjs',
  [string] $IgvmRel = 'guest\igvm-vbs\vbs-linux-candidate-g1-a44bb55a.bin',
  [Parameter(Mandatory = $true)][string] $IgvmSha256,
  [string] $GuestStateMaster = 'C:\Users\claude\vbs-like\type1.vmgs',
  [string] $GuestStateMasterSha256 = '4f051697a74dc72d60e7b36d7cc80554493d64038ea6e146d72b454585ae930d',
  [string] $HypervModule = 'C:\Users\claude\hyperv.psm1',
  [string] $Python = 'C:\Python314\python.exe',
  [string] $Gateway = 'https://ipfs.enclave.host',
  [int] $Port = 18091,
  [string] $Name = '0xd1acce55d1acce55d1acce55d1acce55d1acce55d1acce55d1acce55d1acce55',
  [int] $CeilingSeconds = 1800,
  # SERVING: the manager runs wmiserve per domain (ENCLAVE_WMISERVE_EXE, pinned), and the report service's hv_sock GUID
  # (port 9001) is registered for the run only if absent, and removed again only if this run added it.
  [switch] $Serve,
  [string] $WmiserveRel = 'control\candidate-launcher\vbslike-host-15338081.exe',
  [string] $WmiserveSha256 = '15338081b81692a155130ec28e37fa654117a3e769427b621404fff3d6c6bca4',
  # PHASE 1: enclave-5d's hvlab-accept.mjs against the manager (data plane on $DataPort); empty = phase 2 only
  [string] $HvlabScript = '',
  [int] $DataPort = 18092
)
$ErrorActionPreference = 'Stop'
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$runDir = "C:\Users\claude\vbs-evidence\mgraccept-$stamp"; New-Item -ItemType Directory $runDir -Force | Out-Null
$log = "$runDir\harness.log"
function Note($m) { $l = "$((Get-Date).ToUniversalTime().ToString('HH:mm:ss')) $m"; Write-Host $l; Add-Content -Path $log -Value $l }
$RegPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization'; $RegName = 'AllowFirmwareLoadFromFile'
function Read-Setting { try { $i = Get-ItemProperty $RegPath -Name $RegName -EA Stop; @{ S='Present'; V=$i.$RegName; K="$((Get-Item $RegPath).GetValueKind($RegName))" } } catch { @{ S='Absent' } } }
$MARKER = 'enclave-vbslike-app-domain'; $MGR = $MARKER + '/manager|'
function Owned($v) { $n = [string]$v.Notes; ($n -eq $MARKER) -or $n.StartsWith($MGR) }

try { $script:lock = [System.IO.File]::Open('C:\Users\claude\uefi-probe.lock', 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw "another bounded run holds C:\Users\claude\uefi-probe.lock; refusing to start" }
$stale = @(Get-ChildItem "C:\Users\claude\uefi-probe-active-*.txt" -EA SilentlyContinue)
if ($stale.Count) { throw "a stale sentinel exists ($($stale.Name -join ', ')); refusing" }
$pre = @(Get-VM | Where-Object { (Owned $_) -or $_.Name.StartsWith('enclave-app-') })
if ($pre.Count) { throw "manager-owned or enclave-app- VMs already exist ($($pre.Name -join ', ')); refusing rather than guessing whose they are" }
$igvm = Join-Path $Pkg $IgvmRel
$got = (Get-FileHash $igvm -Algorithm SHA256).Hash.ToLower()
if ($got -ne $IgvmSha256.ToLower()) { throw "the IGVM hashes $got, not the pinned $IgvmSha256" }
$treeFull = (Resolve-Path $Tree).Path
# the driver: inside the tree under test, or an absolute path (a harness pinned OUTSIDE a package's own tree)
$driverFull = if ([System.IO.Path]::IsPathRooted($Driver)) { $Driver } else { Join-Path $treeFull $Driver }
if (-not (Test-Path $driverFull)) { throw "the driver is not at $driverFull" }
$SvcPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices'
$ReportSvcGuid = '00002329-facb-11e6-bd58-64006a7986d3'
$wmiserveExe = $null
if ($Serve) {
  # a path inside the package, or an absolute path (a launcher built but not yet packaged, pinned by its hash all the same)
  $wmiserveExe = if ([System.IO.Path]::IsPathRooted($WmiserveRel)) { $WmiserveRel } else { Join-Path $Pkg $WmiserveRel }
  $ws = (Get-FileHash $wmiserveExe -Algorithm SHA256).Hash.ToLower()
  if ($ws -ne $WmiserveSha256.ToLower()) { throw "the wmiserve executable hashes $ws, not the pinned $WmiserveSha256" }
}
if ($HvlabScript -and -not (Test-Path $HvlabScript)) { throw "hvlab-accept not found at $HvlabScript" }

$before = Read-Setting
Note "=== MANAGER ACCEPTANCE ($Driver). Lifecycle and recovery only: NOT an isolation or attestation result; host_excluded=no. ==="
Note "setting before: $($before.S); IGVM $igvm verified $got; tree $treeFull"
# HASHES AT USE: every file of the tree under test, and each input by name, so the record names exactly what ran
$th = "$runDir\tree-hashes.txt"
$treeFiles = @(Get-ChildItem $treeFull -Recurse -File | Sort-Object FullName)
$lines = foreach ($f in $treeFiles) { "$((Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower())  $($f.FullName.Substring($treeFull.Length + 1))" }
[System.IO.File]::WriteAllLines($th, [string[]]$lines)
$treeDigest = (Get-FileHash $th -Algorithm SHA256).Hash.ToLower()
Note "HASHES AT USE: tree $($treeFiles.Count) files, list sha256 $treeDigest ($th)"
foreach ($x in @($driverFull, $(if ($HvlabScript) { $HvlabScript }), (Join-Path $Pkg 'guest\runtime.json'), (Join-Path $Pkg 'apps\hello-world-1.0.4\spawn.json'), (Join-Path $Pkg 'apps\hello-world-1.0.4\app.bundle'), $GuestStateMaster, $HypervModule) | Where-Object { $_ }) {
  Note "HASH AT USE: $((Get-FileHash $x -Algorithm SHA256).Hash.ToLower())  $x"
}
$sentinel = "C:\Users\claude\uefi-probe-active-$stamp.txt"; $fired = "C:\Users\claude\uefi-watchdog-fired-$stamp.txt"
$myStart = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
Set-Content -Path $sentinel -Force -Value "run=mgraccept`npid=$PID`npidStartTicks=$myStart`nbefore.S=$($before.S)`nbefore.V=$($before.V)`nbefore.K=$($before.K)"
$treeEsc = [regex]::Escape($treeFull)
$wd = @"
`$deadline = (Get-Date).AddSeconds($CeilingSeconds)
while ((Get-Date) -lt `$deadline) { `$p = Get-Process -Id $PID -EA SilentlyContinue; if (-not `$p -or `$p.StartTime.ToUniversalTime().Ticks -ne $myStart) { break }; Start-Sleep -Seconds 5 }
if (Test-Path '$sentinel') {
  Set-Content -Path '$fired' -Force -Value "fired=`$((Get-Date).ToUniversalTime().ToString('s'))"
  foreach (`$q in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { `$_.CommandLine -match '$treeEsc' })) { Stop-Process -Id `$q.ProcessId -Force -EA SilentlyContinue }
  foreach (`$q in @(Get-CimInstance Win32_Process -Filter "Name like 'vbslike-host%'" | Where-Object { `$_.CommandLine -match '$([regex]::Escape($runDir))' })) { Stop-Process -Id `$q.ProcessId -Force -EA SilentlyContinue }
  if (@(Get-Content '$sentinel' -EA SilentlyContinue) -contains 'svcAdded=1') { Remove-Item -Path '$SvcPath\$ReportSvcGuid' -Recurse -Force -EA SilentlyContinue }
  foreach (`$v in @(Get-VM -EA SilentlyContinue | Where-Object { [string]`$_.Notes -eq '$MARKER' -or ([string]`$_.Notes).StartsWith('$MGR') })) {
    Stop-VM -VM `$v -TurnOff -Force -EA SilentlyContinue; Start-Sleep -Seconds 3; Remove-VM -VM `$v -Force -EA SilentlyContinue }
  if ('$($before.S)' -eq 'Present') { Set-ItemProperty '$RegPath' -Name '$RegName' -Value $($before.V) -Type '$($before.K)' } else { Remove-ItemProperty '$RegPath' -Name '$RegName' -EA SilentlyContinue }
  Add-Content -Path '$log' -Value "WATCHDOG fired: tree node processes killed, manager-owned VMs removed, setting restored to $($before.S)"
  Remove-Item '$sentinel' -Force -EA SilentlyContinue
}
"@
$wdFile = "C:\Users\claude\uefi-watchdog-$stamp.ps1"; Set-Content -Path $wdFile -Value $wd -Force
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wdFile" } | Out-Null
Note "watchdog armed (pid $PID, ceiling ${CeilingSeconds}s)"

$fail = @(); $driverExit = $null
try {
  Set-ItemProperty -Path $RegPath -Name $RegName -Value 1 -Type DWORD
  Note "SETTING APPLIED for this run"
  $script:svcAdded = $false
  if ($Serve) {
    $svcKey = Join-Path $SvcPath $ReportSvcGuid
    if (-not (Test-Path $svcKey)) {
      New-Item -Path $svcKey -Force | Out-Null
      New-ItemProperty -Path $svcKey -Name 'ElementName' -Value 'enclave report signing (acceptance)' -PropertyType String -Force | Out-Null
      $script:svcAdded = $true
      Add-Content -Path $sentinel -Value 'svcAdded=1'
      Note "hv_sock service $ReportSvcGuid registered for port 9001 (removed again in cleanup)"
    } else { Note "hv_sock service $ReportSvcGuid already registered by somebody else; left alone" }
  }
  $cfg = @{ tree = $treeFull; port = $Port; igvm = $igvm; igvmSha256 = $got; gsMaster = $GuestStateMaster; gsMasterSha256 = $GuestStateMasterSha256;
            archiveDir = 'C:\Users\claude\vbs-evidence'; hypervModule = $HypervModule; runtimeIdentity = (Join-Path $Pkg 'guest\runtime.json');
            python = $Python; gateway = $Gateway; spawnJson = (Join-Path $Pkg 'apps\hello-world-1.0.4\spawn.json'); name = $Name; logDir = $runDir }
  if ($Serve) { $cfg.wmiserveExe = $wmiserveExe; $cfg.wmiserveSha256 = $WmiserveSha256.ToLower(); $cfg.bundleDir = "$runDir\bundles" }
  if ($HvlabScript) { $cfg.hvlab = @{ script = $HvlabScript; nodeTree = $treeFull; dataPort = $DataPort; timeoutS = 300 } }
  $cfg = $cfg | ConvertTo-Json -Compress -Depth 4
  $cfgFile = "$runDir\config.json"; [System.IO.File]::WriteAllText($cfgFile, $cfg)
  Note "config: $cfg"
  $out = "$runDir\driver.out"
  $p = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList @($driverFull, $cfgFile) `
         -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError "$out.err"
  $null = $p.Handle   # Windows PowerShell: without it, ExitCode is empty after WaitForExit(ms)
  if (-not $p.WaitForExit(($CeilingSeconds - 120) * 1000)) { try { $p.Kill() } catch {}; $fail += "the driver did not finish in time (killed)" }
  $driverExit = $p.ExitCode
  if ($null -eq $driverExit -or "$driverExit" -eq '') { $fail += "the driver's exit code could not be read" }
  foreach ($l in (Get-Content $out -EA SilentlyContinue)) { Note "  DRIVER: $l" }
  foreach ($l in (Get-Content "$out.err" -EA SilentlyContinue | Select-Object -First 30)) { Note "  DRIVER-ERR: $l" }
} catch { $fail += "harness: $($_.Exception.Message)" }
finally {
  foreach ($q in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $treeEsc })) {
    $fail += "a node process from this run's tree was still running (pid $($q.ProcessId)): killed"; Stop-Process -Id $q.ProcessId -Force -EA SilentlyContinue }
  foreach ($q in @(Get-CimInstance Win32_Process -Filter "Name like 'vbslike-host%'" | Where-Object { $_.CommandLine -match [regex]::Escape($runDir) })) {
    $fail += "a wmiserve of this run was still running (pid $($q.ProcessId)): killed"; Stop-Process -Id $q.ProcessId -Force -EA SilentlyContinue }
  foreach ($v in @(Get-VM -EA SilentlyContinue | Where-Object { Owned $_ })) {
    $fail += "manager-owned VM $($v.Name) ($($v.State)) was still present after the driver"
    Stop-VM -VM $v -TurnOff -Force -EA SilentlyContinue; Start-Sleep -Seconds 3; Remove-VM -VM $v -Force -EA SilentlyContinue }
  if (@(Get-VM -EA SilentlyContinue | Where-Object { Owned $_ }).Count) { $fail += "a manager-owned VM is STILL present" }
  $leftCopies = @(Get-ChildItem 'C:\Users\claude\vbs-like\enclave-app-*.vmgs' -EA SilentlyContinue)
  if ($leftCopies.Count) { Note "NOTE: per-run guest-state copies left (kept, not deleted): $($leftCopies.Name -join ', ')" }
  if ($before.S -eq 'Present') { Set-ItemProperty $RegPath -Name $RegName -Value $before.V -Type $before.K } else { Remove-ItemProperty $RegPath -Name $RegName -EA SilentlyContinue }
  $after = Read-Setting
  if ($after.S -eq $before.S -and "$($after.V)" -eq "$($before.V)") { Note "SETTING RESTORED to $($before.S) (verified)" } else { $fail += "SETTING NOT RESTORED: now $($after.S)" }
  if ($script:svcAdded) {
    Remove-Item -Path (Join-Path $SvcPath $ReportSvcGuid) -Recurse -Force -EA SilentlyContinue
    if (Test-Path (Join-Path $SvcPath $ReportSvcGuid)) { $fail += "hv_sock service $ReportSvcGuid NOT removed" } else { Note "hv_sock service $ReportSvcGuid removed (verified)" }
  }
  if (Test-Path $fired) { $fail += "the watchdog acted under this run" }
  Remove-Item $sentinel -Force -EA SilentlyContinue; Remove-Item $wdFile -Force -EA SilentlyContinue
  foreach ($f in $fail) { Note "FAILURE: $f" }
  $code = if ($fail.Count) { 1 } elseif ($driverExit -eq 3) { 3 } elseif ($driverExit -ne 0) { 2 } else { 0 }
  Note "=== RESULT: driver exit $driverExit, harness exit $code (0 passed; 3 refused; 2 driver failed, cleanup clean; 1 cleanup failed). Evidence: $runDir ==="
  try { $script:lock.Dispose() } catch { }
}
exit $code
