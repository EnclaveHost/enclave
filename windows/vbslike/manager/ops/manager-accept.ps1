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
  [int] $CeilingSeconds = 1800
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

$before = Read-Setting
Note "=== MANAGER ACCEPTANCE ($Driver). Lifecycle and recovery only: NOT an isolation or attestation result; host_excluded=no. ==="
Note "setting before: $($before.S); IGVM $igvm verified $got; tree $treeFull"
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
  $cfg = @{ tree = $treeFull; port = $Port; igvm = $igvm; igvmSha256 = $got; gsMaster = $GuestStateMaster; gsMasterSha256 = $GuestStateMasterSha256;
            archiveDir = 'C:\Users\claude\vbs-evidence'; hypervModule = $HypervModule; runtimeIdentity = (Join-Path $Pkg 'guest\runtime.json');
            python = $Python; gateway = $Gateway; spawnJson = (Join-Path $Pkg 'apps\hello-world-1.0.4\spawn.json'); name = $Name; logDir = $runDir } | ConvertTo-Json -Compress
  $cfgFile = "$runDir\config.json"; [System.IO.File]::WriteAllText($cfgFile, $cfg)
  Note "config: $cfg"
  $out = "$runDir\driver.out"
  $p = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList @((Join-Path $treeFull $Driver), $cfgFile) `
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
  foreach ($v in @(Get-VM -EA SilentlyContinue | Where-Object { Owned $_ })) {
    $fail += "manager-owned VM $($v.Name) ($($v.State)) was still present after the driver"
    Stop-VM -VM $v -TurnOff -Force -EA SilentlyContinue; Start-Sleep -Seconds 3; Remove-VM -VM $v -Force -EA SilentlyContinue }
  if (@(Get-VM -EA SilentlyContinue | Where-Object { Owned $_ }).Count) { $fail += "a manager-owned VM is STILL present" }
  $leftCopies = @(Get-ChildItem 'C:\Users\claude\vbs-like\enclave-app-*.vmgs' -EA SilentlyContinue)
  if ($leftCopies.Count) { Note "NOTE: per-run guest-state copies left (kept, not deleted): $($leftCopies.Name -join ', ')" }
  if ($before.S -eq 'Present') { Set-ItemProperty $RegPath -Name $RegName -Value $before.V -Type $before.K } else { Remove-ItemProperty $RegPath -Name $RegName -EA SilentlyContinue }
  $after = Read-Setting
  if ($after.S -eq $before.S -and "$($after.V)" -eq "$($before.V)") { Note "SETTING RESTORED to $($before.S) (verified)" } else { $fail += "SETTING NOT RESTORED: now $($after.S)" }
  if (Test-Path $fired) { $fail += "the watchdog acted under this run" }
  Remove-Item $sentinel -Force -EA SilentlyContinue; Remove-Item $wdFile -Force -EA SilentlyContinue
  foreach ($f in $fail) { Note "FAILURE: $f" }
  $code = if ($fail.Count) { 1 } elseif ($driverExit -eq 3) { 3 } elseif ($driverExit -ne 0) { 2 } else { 0 }
  Note "=== RESULT: driver exit $driverExit, harness exit $code (0 passed; 3 refused; 2 driver failed, cleanup clean; 1 cleanup failed). Evidence: $runDir ==="
  try { $script:lock.Dispose() } catch { }
}
exit $code
