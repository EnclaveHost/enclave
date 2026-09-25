# manager-launcher-canary.ps1 - run the manager's REAL WmiHyperVLauncher once on this host (launcher-canary.mjs),
# under a TEMPORARY AllowFirmwareLoadFromFile opt-in that is restored to its exact prior state afterwards.
#
# The launcher never touches the setting (a production decision that stays open); this harness applies it for
# one bounded run, the same way uefi-dev-boot.ps1 does, with the same guarantees:
#   - ONE RUN AT A TIME: the shared lock C:\Users\claude\uefi-probe.lock, taken first.
#   - a stale sentinel from another run means the current setting is not this host's resting state: refused.
#   - a detached WATCHDOG waits for THIS process (pid + start time) and, if it ends without cleaning up (or hangs
#     past the ceiling), removes this run's VMs (prefix + ownership marker) and restores the setting.
# Exit: 0 every launcher step held and cleanup verified; 2 a launcher step failed but cleanup verified; 1 cleanup failed.
param(
  [Parameter(Mandatory = $true)][string] $ImagePath,
  [Parameter(Mandatory = $true)][string] $ImageSha256,
  [ValidateSet('linux-direct')][string] $Boot = 'linux-direct',
  [string] $GuestStateMaster = 'C:\Users\claude\vbs-like\type1.vmgs',
  [string] $GuestStateMasterSha256 = '4f051697a74dc72d60e7b36d7cc80554493d64038ea6e146d72b454585ae930d',
  [string] $HypervModule = 'C:\Users\claude\hyperv.psm1',
  [string] $Tree = 'C:\Users\claude\d1-mgrcanary\tree',
  [string] $Prefix = 'enclave-mgrcanary-',
  [int] $CeilingSeconds = 900,
  # the APP's policy memMiB, as a catalog version pins it (hello-world: 128). The launcher sizes the VM from it
  # (type1VmMemMiB: max(2048, policy + 640)); it is not the VM's RAM.
  [int] $PolicyMemMiB = 128
)
$ErrorActionPreference = 'Stop'
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$log = "C:\Users\claude\vbs-evidence\mgrcanary-$stamp.log"
function Note($m) { $l = "$((Get-Date).ToUniversalTime().ToString('HH:mm:ss')) $m"; Write-Host $l; Add-Content -Path $log -Value $l }
$RegPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization'; $RegName = 'AllowFirmwareLoadFromFile'
function Read-Setting { try { $i = Get-ItemProperty $RegPath -Name $RegName -EA Stop; @{ S='Present'; V=$i.$RegName; K="$((Get-Item $RegPath).GetValueKind($RegName))" } } catch { @{ S='Absent' } } }
$MARKER = 'enclave-vbslike-app-domain'; $MGR = $MARKER + '/manager|'

try { $script:lock = [System.IO.File]::Open('C:\Users\claude\uefi-probe.lock', 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw "another bounded run holds C:\Users\claude\uefi-probe.lock; refusing to start" }
$stale = @(Get-ChildItem "C:\Users\claude\uefi-probe-active-*.txt" -EA SilentlyContinue)
if ($stale.Count) { throw "a stale sentinel exists ($($stale.Name -join ', ')): the setting may not be at its resting state; refusing" }
if (@(Get-VM | Where-Object { $_.Name.StartsWith($Prefix) }).Count) { throw "VMs under $Prefix already exist; refusing rather than guessing whose they are" }

$before = Read-Setting
Note "=== MANAGER LAUNCHER CANARY. Not an isolation or attestation result; host_excluded=no. ==="
Note "setting before: $($before.S)"
$sentinel = "C:\Users\claude\uefi-probe-active-$stamp.txt"
$fired = "C:\Users\claude\uefi-watchdog-fired-$stamp.txt"
$myStart = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
Set-Content -Path $sentinel -Force -Value "run=mgrcanary`npid=$PID`npidStartTicks=$myStart`nbefore.S=$($before.S)`nbefore.V=$($before.V)`nbefore.K=$($before.K)"
$wd = @"
`$deadline = (Get-Date).AddSeconds($CeilingSeconds)
while ((Get-Date) -lt `$deadline) { `$p = Get-Process -Id $PID -EA SilentlyContinue; if (-not `$p -or `$p.StartTime.ToUniversalTime().Ticks -ne $myStart) { break }; Start-Sleep -Seconds 5 }
if (Test-Path '$sentinel') {
  Set-Content -Path '$fired' -Force -Value "fired=`$((Get-Date).ToUniversalTime().ToString('s'))"
  foreach (`$v in @(Get-VM -EA SilentlyContinue | Where-Object { `$_.Name.StartsWith('$Prefix') -and ([string]`$_.Notes -eq '$MARKER' -or ([string]`$_.Notes).StartsWith('$MGR')) })) {
    Stop-VM -VM `$v -TurnOff -Force -EA SilentlyContinue; Start-Sleep -Seconds 3; Remove-VM -VM `$v -Force -EA SilentlyContinue }
  if ('$($before.S)' -eq 'Present') { Set-ItemProperty '$RegPath' -Name '$RegName' -Value $($before.V) -Type '$($before.K)' } else { Remove-ItemProperty '$RegPath' -Name '$RegName' -EA SilentlyContinue }
  Add-Content -Path '$log' -Value "WATCHDOG fired: VMs under $Prefix removed, setting restored to $($before.S)"
  Remove-Item '$sentinel' -Force -EA SilentlyContinue
}
"@
$wdFile = "C:\Users\claude\uefi-watchdog-$stamp.ps1"; Set-Content -Path $wdFile -Value $wd -Force
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wdFile" } | Out-Null
Note "watchdog armed (pid $PID, ceiling ${CeilingSeconds}s)"

$fail = @(); $launcherExit = $null
try {
  Set-ItemProperty -Path $RegPath -Name $RegName -Value 1 -Type DWORD
  Note "SETTING APPLIED for this run"
  $cfg = @{ imagePath = $ImagePath; imageSha256 = $ImageSha256.ToLower(); boot = $Boot; guestStateMaster = $GuestStateMaster;
            guestStateMasterSha256 = $GuestStateMasterSha256; guestStateArchiveDir = 'C:\Users\claude\vbs-evidence';
            hypervModule = $HypervModule; prefix = $Prefix; memMiB = $PolicyMemMiB; vcpus = 1 } | ConvertTo-Json -Compress
  $out = "C:\Users\claude\vbs-evidence\mgrcanary-$stamp.out"
  $cfgFile = "C:\Users\claude\vbs-evidence\mgrcanary-$stamp.json"
  [System.IO.File]::WriteAllText($cfgFile, $cfg)   # no BOM; a file, because Windows re-quotes native arguments
  Note "config: $cfg"
  $p = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList @("$Tree\windows\vbslike\manager\ops\launcher-canary.mjs", $cfgFile) `
         -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError "$out.err"
  # READ THE HANDLE NOW. Windows PowerShell's Start-Process -PassThru object reports an EMPTY ExitCode after
  # WaitForExit(ms) unless its Handle was taken while the process lived (measured: run 20260925-070935 held every
  # step and still read exit '').
  $null = $p.Handle
  if (-not $p.WaitForExit(600000)) { try { $p.Kill() } catch {}; $fail += "the launcher canary did not finish in 600 s (killed)" }
  $launcherExit = $p.ExitCode
  if ($null -eq $launcherExit -or "$launcherExit" -eq '') { $fail += "the launcher's exit code could not be read" }
  foreach ($l in (Get-Content $out -EA SilentlyContinue)) { Note "  LAUNCHER: $l" }
  foreach ($l in (Get-Content "$out.err" -EA SilentlyContinue | Select-Object -First 20)) { Note "  LAUNCHER-ERR: $l" }
} catch { $fail += "harness: $($_.Exception.Message)" }
finally {
  # Anything of ours still here is removed (the launcher's own stop is the thing under test; this is the net).
  foreach ($v in @(Get-VM -EA SilentlyContinue | Where-Object { $_.Name.StartsWith($Prefix) })) {
    $fail += "VM $($v.Name) ($($v.State)) was still present after the launcher finished"
    if ([string]$v.Notes -eq $MARKER -or ([string]$v.Notes).StartsWith($MGR)) { Stop-VM -VM $v -TurnOff -Force -EA SilentlyContinue; Start-Sleep -Seconds 3; Remove-VM -VM $v -Force -EA SilentlyContinue }
  }
  if (@(Get-VM -EA SilentlyContinue | Where-Object { $_.Name.StartsWith($Prefix) }).Count) { $fail += "a VM under $Prefix is STILL present" }
  if ($before.S -eq 'Present') { Set-ItemProperty $RegPath -Name $RegName -Value $before.V -Type $before.K } else { Remove-ItemProperty $RegPath -Name $RegName -EA SilentlyContinue }
  $after = Read-Setting
  if ($after.S -eq $before.S -and "$($after.V)" -eq "$($before.V)") { Note "SETTING RESTORED to $($before.S) (verified)" } else { $fail += "SETTING NOT RESTORED: now $($after.S)" }
  if (Test-Path $fired) { $fail += "the watchdog acted under this run" }
  Remove-Item $sentinel -Force -EA SilentlyContinue; Remove-Item $wdFile -Force -EA SilentlyContinue
  foreach ($f in $fail) { Note "FAILURE: $f" }
  $code = if ($fail.Count) { 1 } elseif ($launcherExit -ne 0) { 2 } else { 0 }
  Note "=== RESULT: launcher exit $launcherExit, harness exit $code (0 all held; 2 a launcher step failed, cleanup clean; 1 cleanup failed) ==="
  try { $script:lock.Dispose() } catch { }
}
exit $code
