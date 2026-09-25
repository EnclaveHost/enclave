# reboot-accept.ps1 - recovery after a HOST reboot (enclave-d1's READINESS.md U4), in two phases around ONE reboot:
#   -Phase Arm     records the exact prior host state; installs a ONE-SHOT boot task that restores it on the next boot
#                  and then removes itself (its script holds the prior values as LITERALS and lives, with its log, in a
#                  directory ACL'd to SYSTEM and Administrators only; enclave-63's review F1); applies the temporary firmware opt-in and the 9001 key exactly as
#                  manager-accept.ps1 does; runs reboot-accept.mjs arm (two lab domains serving, the manager left running);
#                  restores the setting and the key BEFORE the reboot and re-checks that both domains still answer;
#                  disables the host's own node boot task for this one boot only (-NodeTaskName; the one-shot task
#                  re-enables it after its boot trigger has passed, without running it); then `shutdown /r`.
#   -Phase Verify  after the reboot:
#                  B1 a new boot;
#                  B2 Secure Boot and the BCD test-signing lines unchanged;
#                  B3 the one-shot task ran and removed itself;
#                  B4 the setting and the 9001 key are at their prior state;
#                  B5 the node task's definition is byte-identical to before and enabled as before;
#                  B6 it did not run;
#                  B7 both armed VMs present and Off;
#                  B8 the tree unchanged.
#                  Then reboot-accept.mjs verify (HELD, no respawn, stale routes refused, cleanup); then B9, the end state.
# No permanent autostart, no firmware opt-in left behind, Secure Boot and test signing untouched, no production app data
# touched. Functional recovery only: NOT an isolation or attestation result; host_excluded=no.
param(
  [Parameter(Mandatory = $true)][ValidateSet('Arm', 'Verify')][string] $Phase,
  [Parameter(Mandatory = $true)][string] $Tree,
  [Parameter(Mandatory = $true)][string] $Pkg,
  [Parameter(Mandatory = $true)][string] $Driver,
  [Parameter(Mandatory = $true)][string] $IgvmRel,
  [Parameter(Mandatory = $true)][string] $IgvmSha256,
  [Parameter(Mandatory = $true)][string] $WmiserveRel,
  [Parameter(Mandatory = $true)][string] $WmiserveSha256,
  [string] $Lab = 'C:\Users\claude\d1-u4',
  [string] $GuestStateMaster = 'C:\Users\claude\vbs-like\type1.vmgs',
  [string] $GuestStateMasterSha256 = '4f051697a74dc72d60e7b36d7cc80554493d64038ea6e146d72b454585ae930d',
  [string] $HypervModule = 'C:\Users\claude\hyperv.psm1',
  [string] $Python = 'C:\Python314\python.exe',
  [string] $Gateway = 'https://ipfs.enclave.host',
  [int] $Port = 18091,
  [int] $DataPort = 18092,
  [string] $Name = '0xd1acce55d1acce55d1acce55d1acce55d1acce55d1acce55d1acce55d1acce55',
  [int] $LivenessMs = 15000,
  [int] $AnswerCheckMs = 30000,
  [string] $NodeTaskName = 'EnclaveWindowsNode',
  [int] $RebootDelaySeconds = 60,
  [int] $OneShotWaitSeconds = 300,
  [string] $RestoreDir = 'C:\ProgramData\d1-u4-restore'
)
$ErrorActionPreference = 'Stop'
if ($WmiserveSha256 -notmatch '^[0-9a-fA-F]{64}$' -or $IgvmSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'the launcher and IGVM pins must be 64 hex' }
New-Item -ItemType Directory $Lab -Force | Out-Null
$log = "$Lab\$($Phase.ToLower()).log"
function Note($m) { $l = "$((Get-Date).ToUniversalTime().ToString('HH:mm:ss'))Z $m"; Write-Host $l; Add-Content -Path $log -Value $l }
$RegPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization'; $RegName = 'AllowFirmwareLoadFromFile'
$SvcPath = "$RegPath\GuestCommunicationServices"; $ReportSvcGuid = '00002329-facb-11e6-bd58-64006a7986d3'; $SvcKey = "$SvcPath\$ReportSvcGuid"
function Read-Setting { try { $i = Get-ItemProperty $RegPath -Name $RegName -EA Stop; @{ S = 'Present'; V = $i.$RegName; K = "$((Get-Item $RegPath).GetValueKind($RegName))" } } catch { @{ S = 'Absent'; V = $null; K = $null } } }
$MARKER = 'enclave-vbslike-app-domain'; $MGR = $MARKER + '/manager|'
function Owned($v) { $n = [string]$v.Notes; ($n -eq $MARKER) -or $n.StartsWith($MGR) }
function Bcd { ((bcdedit /enum '{current}' | Select-String -Pattern 'testsigning|nointegritychecks|hypervisorlaunchtype' | ForEach-Object { ($_.Line -replace '\s+', ' ').Trim() }) -join ' ; ') }
function LastBoot { (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
function Sha($s) { $b = [System.Text.Encoding]::UTF8.GetBytes([string]$s); ([BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($b)) -replace '-', '').ToLower() }
function TaskXml { try { Export-ScheduledTask -TaskName $NodeTaskName -EA Stop } catch { $null } }
function TaskXmlNorm($x) { if ($null -eq $x) { return $null }; ([string]$x) -replace '<Enabled>(true|false)</Enabled>', '<Enabled>?</Enabled>' }
function TreeLines($root) { foreach ($f in @(Get-ChildItem $root -Recurse -File | Sort-Object FullName)) { "$((Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower())  $($f.FullName.Substring($root.Length + 1))" } }
$OneShot = 'd1-u4-restore-once'
$priorFile = "$Lab\prior-state.json"; $stateFile = "$Lab\state.json"; $cfgFile = "$Lab\cfg.json"
$treeFull = (Resolve-Path $Tree).Path
$driverFull = if ([System.IO.Path]::IsPathRooted($Driver)) { $Driver } else { Join-Path $treeFull $Driver }
if (-not (Test-Path $driverFull)) { throw "the driver is not at $driverFull" }
$igvm = Join-Path $Pkg $IgvmRel
$wmiserveExe = if ([System.IO.Path]::IsPathRooted($WmiserveRel)) { $WmiserveRel } else { Join-Path $Pkg $WmiserveRel }
foreach ($pin in @(@($igvm, $IgvmSha256), @($wmiserveExe, $WmiserveSha256))) {
  $h = (Get-FileHash $pin[0] -Algorithm SHA256).Hash.ToLower(); if ($h -ne $pin[1].ToLower()) { throw "$($pin[0]) hashes $h, not the pinned $($pin[1])" } }
try { $script:lock = [System.IO.File]::Open('C:\Users\claude\uefi-probe.lock', 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw "another bounded run holds C:\Users\claude\uefi-probe.lock; refusing to start" }
$treeEsc = [regex]::Escape($treeFull)
function RunDriver($mode) {
  $out = "$Lab\driver-$mode.out"
  $p = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList @($driverFull, $cfgFile, $mode, $stateFile) -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError "$out.err"
  $null = $p.Handle
  if (-not $p.WaitForExit(1500 * 1000)) { try { $p.Kill() } catch {}; Note "the $mode driver did not finish in time (killed)"; return 1 }
  foreach ($l in (Get-Content $out -EA SilentlyContinue)) { Note "  DRIVER($mode): $l" }
  foreach ($l in (Get-Content "$out.err" -EA SilentlyContinue | Select-Object -First 30)) { Note "  DRIVER-ERR($mode): $l" }
  return $p.ExitCode
}
function Restore-Prior($prior) {
  if ($prior.setting.S -eq 'Present') { Set-ItemProperty $RegPath -Name $RegName -Value $prior.setting.V -Type $prior.setting.K } else { Remove-ItemProperty $RegPath -Name $RegName -EA SilentlyContinue }
  if ($prior.svcAddedByUs -and (Test-Path $SvcKey)) { Remove-Item -Path $SvcKey -Recurse -Force -EA SilentlyContinue }
  $a = Read-Setting
  $ok = ($a.S -eq $prior.setting.S) -and ("$($a.V)" -eq "$($prior.setting.V)") -and ((Test-Path $SvcKey) -eq [bool]$prior.svc9001Present)
  Note "RESTORE: setting now $($a.S) (prior $($prior.setting.S)); 9001 key now $(Test-Path $SvcKey) (prior $($prior.svc9001Present)): $(if ($ok) { 'VERIFIED' } else { 'NOT RESTORED' })"
  return $ok
}

if ($Phase -eq 'Arm') {
  Note "=== REBOOT ACCEPTANCE, ARM. Functional recovery only: NOT an isolation or attestation result; host_excluded=no. ==="
  if (Test-Path $priorFile) { throw "$priorFile exists: an earlier arm was not verified; run -Phase Verify first" }
  if (@(Get-ChildItem 'C:\Users\claude\uefi-probe-active-*.txt' -EA SilentlyContinue).Count) { throw 'a stale sentinel exists; refusing' }
  $pre = @(Get-VM | Where-Object { (Owned $_) -or $_.Name.StartsWith('enclave-app-') })
  if ($pre.Count) { throw "manager-owned or enclave-app- VMs already exist ($($pre.Name -join ', ')); refusing" }
  if (Get-ScheduledTask -TaskName $OneShot -EA SilentlyContinue) { throw "the one-shot task $OneShot already exists; refusing" }
  $before = Read-Setting; $xml = TaskXml
  # F3: the run must not leave a RUNNING production node stopped, and a re-enabled task must not fire by a non-boot trigger
  $legacyNow = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'vbs\\node' })
  if ($legacyNow.Count) { throw "the legacy node is RUNNING (pid $($legacyNow.ProcessId -join ',')): a reboot would leave it stopped; refusing" }
  if ($xml) {
    $trig = @((Get-ScheduledTask -TaskName $NodeTaskName).Triggers | ForEach-Object { $_.CimClass.CimClassName })
    if (@($trig | Where-Object { $_ -ne 'MSFT_TaskBootTrigger' }).Count) { throw "the node task has a non-boot trigger ($($trig -join ', ')): re-enabling it could fire it; refusing" }
  }
  $prior = [ordered]@{ armedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); lastBoot = (LastBoot); secureBoot = [bool](Confirm-SecureBootUEFI);
    bcd = (Bcd); setting = $before; svc9001Present = (Test-Path $SvcKey); svcAddedByUs = $false;
    nodeTask = [ordered]@{ name = $NodeTaskName; exists = ($null -ne $xml); enabled = $(if ($xml) { [bool](Get-ScheduledTask -TaskName $NodeTaskName).Settings.Enabled } else { $null });
                           xmlSha256 = $(if ($xml) { Sha $xml }); xmlNormSha256 = $(if ($xml) { Sha (TaskXmlNorm $xml) });
                           lastRun = $(if ($xml) { $i = Get-ScheduledTaskInfo -TaskName $NodeTaskName; if ($i.LastRunTime) { $i.LastRunTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } }); disabledByUs = $false };
    tree = $treeFull; treeDigest = $null; oneShot = $OneShot; restoreDir = $RestoreDir; legacyNodeRunning = $false }
  $prior.svcAddedByUs = -not $prior.svc9001Present                      # the arm registers the 9001 key only if absent
  $prior.nodeTask.disabledByUs = [bool]($prior.nodeTask.exists -and $prior.nodeTask.enabled)   # decided now: a literal for the one-shot
  if ($xml) { [System.IO.File]::WriteAllText("$Lab\nodetask-before.xml", [string]$xml) }
  $lines = @(TreeLines $treeFull); [System.IO.File]::WriteAllLines("$Lab\tree-hashes-arm.txt", [string[]]$lines)
  $prior.treeDigest = (Get-FileHash "$Lab\tree-hashes-arm.txt" -Algorithm SHA256).Hash.ToLower()
  ($prior | ConvertTo-Json -Depth 5) | Set-Content -Path $priorFile
  Note "PRIOR STATE: $((Get-Content $priorFile -Raw) -replace '\s+', ' ')"
  # the ONE-SHOT boot restore (F1): runs as SYSTEM on the next boot. Every value it acts on is a LITERAL written here,
  # nothing is read from a file at boot, and the script and its log live in a directory only SYSTEM and Administrators
  # can write. It restores the recorded prior state, re-enables the node task only after its boot trigger (a 1-minute
  # delay) can no longer fire, logs, and unregisters itself.
  New-Item -ItemType Directory $RestoreDir -Force | Out-Null
  & icacls.exe $RestoreDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
  $aclIds = @((Get-Acl $RestoreDir).Access | ForEach-Object { [string]$_.IdentityReference })
  if (@($aclIds | Where-Object { $_ -notmatch '^(NT AUTHORITY\\SYSTEM|BUILTIN\\Administrators)$' }).Count) { throw "the restore directory ACL is not SYSTEM/Administrators only: $($aclIds -join ', ')" }
  $pS = $before.S; $pV = if ($before.S -eq 'Present') { [string]$before.V } else { '' }; $pK = if ($before.S -eq 'Present') { [string]$before.K } else { '' }
  $rsLog = "$RestoreDir\restore-at-boot.log"
  $rs = @"
`$ErrorActionPreference = 'Continue'
`$log = '$rsLog'
function L(`$m) { Add-Content -Path `$log -Value "`$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss'))Z `$m" }
L 'START one-shot boot restore (SYSTEM; literals from the arm of $($prior.armedAt))'
`$rp = '$RegPath'; `$rn = '$RegName'; `$sk = '$SvcKey'
`$cur = try { (Get-ItemProperty `$rp -Name `$rn -EA Stop).`$rn } catch { `$null }
if ('$pS' -eq 'Absent') { if (`$null -ne `$cur) { Remove-ItemProperty `$rp -Name `$rn -EA SilentlyContinue; L 'setting was Present: REMOVED (prior Absent)' } else { L 'setting already Absent (prior Absent)' } }
else { Set-ItemProperty `$rp -Name `$rn -Value '$pV' -Type '$pK'; L 'setting set to the prior $pV ($pK)' }
if (`$$($prior.svcAddedByUs) -and (Test-Path `$sk)) { Remove-Item -Path `$sk -Recurse -Force -EA SilentlyContinue; L '9001 key was present: REMOVED (added by the run)' } else { L "9001 key present=`$(Test-Path `$sk) (prior $($prior.svc9001Present))" }
Start-Sleep -Seconds $OneShotWaitSeconds
if (`$$($prior.nodeTask.disabledByUs)) { try { Enable-ScheduledTask -TaskName '$NodeTaskName' | Out-Null; L 'node task $NodeTaskName RE-ENABLED (not run)' } catch { L "node task re-enable FAILED: `$(`$_.Exception.Message)" } }
else { L 'node task was not disabled by the run: left alone' }
try { Unregister-ScheduledTask -TaskName '$OneShot' -Confirm:`$false; L 'DONE; one-shot task unregistered' } catch { L "DONE; unregister FAILED: `$(`$_.Exception.Message)" }
"@
  Set-Content -Path "$RestoreDir\restore-at-boot.ps1" -Value $rs -Force
  $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File $RestoreDir\restore-at-boot.ps1"
  $prn = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable
  Register-ScheduledTask -TaskName $OneShot -Action $act -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $prn -Settings $set | Out-Null
  if (-not (Get-ScheduledTask -TaskName $OneShot -EA SilentlyContinue)) { throw "the one-shot task $OneShot was not registered" }
  Note "one-shot boot restore task $OneShot registered (SYSTEM, at startup; it removes itself)"
  ($prior | ConvertTo-Json -Depth 5) | Set-Content -Path $priorFile
  Note "INTEGRITY: prior-state.json sha256 $((Get-FileHash $priorFile -Algorithm SHA256).Hash.ToLower()); restore-at-boot.ps1 sha256 $((Get-FileHash "$RestoreDir\restore-at-boot.ps1" -Algorithm SHA256).Hash.ToLower())"
  $armed = $false
  try {
    Set-ItemProperty -Path $RegPath -Name $RegName -Value 1 -Type DWORD
    Note 'SETTING APPLIED for the arm'
    if (-not (Test-Path $SvcKey)) {
      New-Item -Path $SvcKey -Force | Out-Null
      New-ItemProperty -Path $SvcKey -Name 'ElementName' -Value 'enclave report signing (acceptance)' -PropertyType String -Force | Out-Null
      Note "hv_sock service $ReportSvcGuid registered for port 9001 (removed again before the reboot)"
    }
    $cfg = @{ tree = $treeFull; port = $Port; igvm = $igvm; igvmSha256 = $IgvmSha256.ToLower(); gsMaster = $GuestStateMaster; gsMasterSha256 = $GuestStateMasterSha256;
              archiveDir = 'C:\Users\claude\vbs-evidence'; hypervModule = $HypervModule; runtimeIdentity = (Join-Path $Pkg 'guest\runtime.json');
              python = $Python; gateway = $Gateway; spawnJson = (Join-Path $Pkg 'apps\hello-world-1.0.4\spawn.json'); name = $Name; logDir = $Lab;
              dataPort = $DataPort; livenessMs = $LivenessMs; answerCheckMs = $AnswerCheckMs;
              wmiserveExe = $wmiserveExe; wmiserveSha256 = $WmiserveSha256.ToLower(); bundleDir = "$Lab\bundles" }
    [System.IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Compress -Depth 4))
    Note "config: $(Get-Content $cfgFile -Raw)"
    $rc = RunDriver 'arm'
    if ($rc -ne 0) { throw "the arm driver exited $rc" }
    $armed = $true
    if (-not (Restore-Prior $prior)) { throw 'the setting or the 9001 key could not be restored before the reboot' }
    $rc2 = RunDriver 'recheck'
    Note "recheck (both domains answer with the setting and the 9001 key restored): exit $rc2"
    if ($rc2 -ne 0) { throw "the recheck exited ${rc2}: the armed domains did not keep serving; not rebooting (F2)" }
    if ($prior.nodeTask.disabledByUs) {
      Disable-ScheduledTask -TaskName $NodeTaskName | Out-Null
      if ((Get-ScheduledTask -TaskName $NodeTaskName).Settings.Enabled) { throw "the node task $NodeTaskName could not be disabled" }
      Note "node task $NodeTaskName DISABLED for this one boot (the one-shot task re-enables it after its boot trigger has passed)"
    }
    Note "before the reboot: VMs $((@(Get-VM | Where-Object { Owned $_ }) | ForEach-Object { "$($_.Name)=$($_.State)" }) -join ', '); lastBoot $(LastBoot)"
    Note "REBOOT: shutdown /r /t $RebootDelaySeconds"
    & shutdown.exe /r /t $RebootDelaySeconds /c 'enclave-d1 U4: host-reboot recovery acceptance (lab)' /d p:0:0
    Note "REBOOT ISSUED (exit $LASTEXITCODE)"
  } catch {
    Note "ARM ABORTED: $($_.Exception.Message). Cleaning up; NO reboot."
    foreach ($q in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $treeEsc })) { Stop-Process -Id $q.ProcessId -Force -EA SilentlyContinue }
    foreach ($q in @(Get-CimInstance Win32_Process -Filter "Name like 'vbslike-host%'" | Where-Object { $_.CommandLine -match [regex]::Escape($Lab) })) { Stop-Process -Id $q.ProcessId -Force -EA SilentlyContinue }
    foreach ($v in @(Get-VM -EA SilentlyContinue | Where-Object { Owned $_ })) { Stop-VM -VM $v -TurnOff -Force -EA SilentlyContinue; Start-Sleep -Seconds 3; Remove-VM -VM $v -Force -EA SilentlyContinue }
    $null = Restore-Prior $prior
    if ($prior.nodeTask.disabledByUs) { Enable-ScheduledTask -TaskName $NodeTaskName | Out-Null; Note "node task re-enabled" }
    Unregister-ScheduledTask -TaskName $OneShot -Confirm:$false -EA SilentlyContinue
    Remove-Item $RestoreDir -Recurse -Force -EA SilentlyContinue
    Move-Item $priorFile "$Lab\prior-state.aborted.json" -Force
    Note "=== ARM RESULT: ABORTED, cleaned up, not rebooted; manager-owned VMs left $(@(Get-VM | Where-Object { Owned $_ }).Count) ==="
    try { $script:lock.Dispose() } catch { }
    exit 1
  }
  try { $script:lock.Dispose() } catch { }
  exit 0
}

# ---- Verify ------------------------------------------------------------------------------------------------------------
Note "=== REBOOT ACCEPTANCE, VERIFY. Functional recovery only: NOT an isolation or attestation result; host_excluded=no. ==="
if (-not (Test-Path $priorFile) -or -not (Test-Path $stateFile)) { throw "no armed state in $Lab" }
$prior = Get-Content $priorFile -Raw | ConvertFrom-Json
$fail = @()
function Check($id, $ok, $detail) { if (-not $ok) { $script:fail += $id }; Note "$(if ($ok) { 'PASS' } else { 'FAIL' }) ${id}: $detail" }
$armLog = @(Get-Content "$Lab\arm.log" -EA SilentlyContinue)
$integ = ($armLog | Where-Object { $_ -match 'INTEGRITY: prior-state.json sha256 ([0-9a-f]{64}); restore-at-boot.ps1 sha256 ([0-9a-f]{64})' } | Select-Object -Last 1)
$m = [regex]::Match([string]$integ, 'prior-state.json sha256 ([0-9a-f]{64}); restore-at-boot.ps1 sha256 ([0-9a-f]{64})')
$ps = (Get-FileHash $priorFile -Algorithm SHA256).Hash.ToLower()
$rsh = if (Test-Path "$RestoreDir\restore-at-boot.ps1") { (Get-FileHash "$RestoreDir\restore-at-boot.ps1" -Algorithm SHA256).Hash.ToLower() } else { 'missing' }
Check 'B0' ($m.Success -and $ps -eq $m.Groups[1].Value -and $rsh -eq $m.Groups[2].Value) "integrity since the arm: prior-state.json $ps (arm $($m.Groups[1].Value)); restore-at-boot.ps1 $rsh (arm $($m.Groups[2].Value))"
$lb = LastBoot
Check 'B1' ([datetime]$lb -gt [datetime]$prior.armedAt) "a new boot: lastBoot $lb, armed $($prior.armedAt)"
Check 'B2' (([bool](Confirm-SecureBootUEFI) -eq [bool]$prior.secureBoot) -and ((Bcd) -eq $prior.bcd)) "Secure Boot $(Confirm-SecureBootUEFI) (prior $($prior.secureBoot)); BCD '$(Bcd)' (prior '$($prior.bcd)')"
$until = (Get-Date).AddSeconds($OneShotWaitSeconds + 300)
while ((Get-Date) -lt $until -and -not ((Get-Content "$RestoreDir\restore-at-boot.log" -EA SilentlyContinue) -match 'DONE')) { Start-Sleep -Seconds 10 }
$osLog = @(Get-Content "$RestoreDir\restore-at-boot.log" -EA SilentlyContinue)
Copy-Item "$RestoreDir\restore-at-boot.log" "$Lab\restore-at-boot.log" -Force -EA SilentlyContinue
Check 'B3' (($osLog -match 'DONE; one-shot task unregistered').Count -gt 0 -and -not (Get-ScheduledTask -TaskName $OneShot -EA SilentlyContinue)) "one-shot log: $($osLog -join ' | ')"
$a = Read-Setting
Check 'B4' (($a.S -eq $prior.setting.S) -and ("$($a.V)" -eq "$($prior.setting.V)") -and ((Test-Path $SvcKey) -eq [bool]$prior.svc9001Present)) "setting $($a.S) (prior $($prior.setting.S)); 9001 key $(Test-Path $SvcKey) (prior $($prior.svc9001Present))"
if ($prior.nodeTask.exists) {
  $x = TaskXml; $en = [bool](Get-ScheduledTask -TaskName $NodeTaskName).Settings.Enabled
  $i = Get-ScheduledTaskInfo -TaskName $NodeTaskName; $lr = if ($i.LastRunTime) { $i.LastRunTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
  Check 'B5' (((Sha $x) -eq $prior.nodeTask.xmlSha256) -and ($en -eq [bool]$prior.nodeTask.enabled)) "node task $NodeTaskName enabled $en (prior $($prior.nodeTask.enabled)); definition sha256 $(Sha $x) (prior $($prior.nodeTask.xmlSha256))"
  $legacy = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'vbs\\node' })
  Check 'B6' (($lr -eq $prior.nodeTask.lastRun) -and $legacy.Count -eq 0) "node task last run $lr (prior $($prior.nodeTask.lastRun)); legacy node processes $($legacy.Count)"
}
$state = Get-Content $stateFile -Raw | ConvertFrom-Json
$armedVms = @($state.deployments | ForEach-Object { $_.vmId })
$now = @(Get-VM | Where-Object { Owned $_ })
Check 'B7' ($now.Count -eq $armedVms.Count -and @($now | Where-Object { $armedVms -contains $_.Id.Guid -and $_.State -eq 'Off' }).Count -eq $armedVms.Count) "manager-owned VMs after the boot: $(($now | ForEach-Object { "$($_.Name) $($_.Id.Guid) $($_.State)" }) -join ', ')"
$lines = @(TreeLines $treeFull); [System.IO.File]::WriteAllLines("$Lab\tree-hashes-verify.txt", [string[]]$lines)
$td = (Get-FileHash "$Lab\tree-hashes-verify.txt" -Algorithm SHA256).Hash.ToLower()
Check 'B8' ($td -eq $prior.treeDigest) "tree listing $td (arm $($prior.treeDigest))"
$rc = RunDriver 'verify'
Check 'DRIVER' ($rc -eq 0) "reboot-accept.mjs verify exit $rc"
foreach ($q in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $treeEsc })) { $fail += 'LEFTOVER'; Note "a manager process from the tree was still running (pid $($q.ProcessId)): killed"; Stop-Process -Id $q.ProcessId -Force -EA SilentlyContinue }
$a2 = Read-Setting; $left = @(Get-VM | Where-Object { Owned $_ })
$lines2 = @(TreeLines $treeFull); [System.IO.File]::WriteAllLines("$Lab\tree-hashes-end.txt", [string[]]$lines2)
$td2 = (Get-FileHash "$Lab\tree-hashes-end.txt" -Algorithm SHA256).Hash.ToLower()
Check 'B9' ($left.Count -eq 0 -and $a2.S -eq $prior.setting.S -and ((Test-Path $SvcKey) -eq [bool]$prior.svc9001Present) -and $td2 -eq $prior.treeDigest -and -not (Get-ScheduledTask -TaskName $OneShot -EA SilentlyContinue)) "end: manager-owned VMs $($left.Count); setting $($a2.S); 9001 key $(Test-Path $SvcKey); tree $td2; one-shot task present $([bool](Get-ScheduledTask -TaskName $OneShot -EA SilentlyContinue))"
Remove-Item $RestoreDir -Recurse -Force -EA SilentlyContinue
Note "restore directory $RestoreDir removed: $(-not (Test-Path $RestoreDir))"
Move-Item $priorFile "$Lab\prior-state.verified.json" -Force
$code = if ($fail.Count) { 1 } else { 0 }
Note "=== VERIFY RESULT: $(if ($code) { "FAILED: $($fail -join ', ')" } else { 'ALL PASS' }) ==="
try { $script:lock.Dispose() } catch { }
exit $code
