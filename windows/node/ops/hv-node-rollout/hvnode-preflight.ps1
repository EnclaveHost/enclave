# hvnode-preflight.ps1 - READ-ONLY checks before the NucBox hv-node install (ROLLOUT.md step 1). It changes nothing,
# prints PASS / FAIL / INFO lines, and exits 1 if any FAIL. Run elevated (bcdedit and the task queries need it):
#   powershell -ExecutionPolicy Bypass -File hvnode-preflight.ps1 -Pkg C:\Users\claude\vbs-like\pkg\15f39ae4d1fab954
# It never prints a key: key files are checked for PRESENCE only.
param(
  [Parameter(Mandatory = $true)][string]$Pkg,
  [string]$LegacyDir = 'C:\Users\claude\vbs\node',
  [string]$Root = 'C:\Users\claude\vbs-like\hvnode',
  [string]$Python = 'C:\Python314\python.exe',
  [int]$ManagerPort = 8091, [int]$DataPort = 8092, [int]$LocalPort = 9600
)
$ErrorActionPreference = 'Stop'
$script:fails = 0
function Say([string]$k, [string]$m) { Write-Output ("{0,-4} {1}" -f $k, $m); if ($k -eq 'FAIL') { $script:fails++ } }
function Sha256Of([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }
function Check([bool]$ok, [string]$m) { if ($ok) { Say 'PASS' $m } else { Say 'FAIL' $m } }
# A native command runs under ErrorActionPreference Continue and is judged by its EXIT CODE only: with Stop, PowerShell
# 5.1 turns a native command's stderr line into a terminating NativeCommandError when the host redirects stderr, as an
# ssh session does (enclave-d1's review, item 3).
function Invoke-Native([scriptblock]$b) { $e = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { & $b } finally { $ErrorActionPreference = $e } }

# --- the platform: Secure Boot on, no test signing (Steven's standing rule; the relay refuses otherwise) ---
try { Check ((Confirm-SecureBootUEFI) -eq $true) 'Secure Boot is ON' } catch { Say 'FAIL' "Secure Boot state unreadable: $($_.Exception.Message)" }
$bcd = (Invoke-Native { & bcdedit /enum '{current}' 2>&1 }) -join "`n"
Check (-not ($bcd -match '(?im)^\s*testsigning\s+Yes')) 'test signing is OFF in the current boot entry'

# --- the retired legacy node: its task exists, is DISABLED, and stays that way (never deleted) ---
$legacy = Get-ScheduledTask -TaskName 'EnclaveWindowsNode' -TaskPath '\' -ErrorAction SilentlyContinue
if ($legacy) { Check ($legacy.State -eq 'Disabled') "legacy task \EnclaveWindowsNode exists and is Disabled (state: $($legacy.State))" }
else { Say 'FAIL' 'legacy task \EnclaveWindowsNode is missing (it must exist, disabled, never deleted)' }
$legacyProcs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='ee-host.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($LegacyDir.ToLower()) -or $_.Name -eq 'ee-host.exe' })
Check ($legacyProcs.Count -eq 0) "no legacy node.exe / ee-host.exe is running ($($legacyProcs.Count) found)"

# --- the new tasks: absent on a first install ---
foreach ($t in 'EnclaveHvManager', 'EnclaveHvNode') {
  $x = Get-ScheduledTask -TaskName $t -TaskPath '\' -ErrorAction SilentlyContinue
  if ($x) { Say 'INFO' "task \$t already exists (state $($x.State)): a re-install needs hvnode-install.ps1 -Replace" } else { Say 'PASS' "task \$t is absent" }
}

# --- Hyper-V: the role and the services the manager's own preflight also checks ---
foreach ($f in 'Microsoft-Hyper-V-Hypervisor', 'Microsoft-Hyper-V-Services', 'Microsoft-Hyper-V-Management-PowerShell', 'VirtualMachinePlatform') {
  $s = (Get-WindowsOptionalFeature -Online -FeatureName $f).State
  Check ($s -eq 'Enabled') "feature $f is Enabled ($s)"
}
Check ((Get-Service vmms).Status -eq 'Running') 'service vmms is Running'
try { $null = Get-VM; Say 'PASS' 'Get-VM answers' } catch { Say 'FAIL' "Get-VM: $($_.Exception.Message)" }
$vms = @(Get-VM | Where-Object { $_.Notes -like 'enclave-vbslike-app-domain*' })
Say 'INFO' "$($vms.Count) VM(s) carry the manager's Notes tag (a lab run's leftovers would be adopted by the new manager: d1 decides)"

# --- M3 host prerequisites: reported here; set by enclave-53's host-prereq.ps1 through d1's m3-run.ps1 (ROLLOUT step 2) ---
$virt = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization'
$afl = (Get-ItemProperty -Path $virt -Name AllowFirmwareLoadFromFile -ErrorAction SilentlyContinue).AllowFirmwareLoadFromFile
Say 'INFO' ("AllowFirmwareLoadFromFile = {0} (M3 sets 1)" -f ($(if ($null -eq $afl) { '<absent>' } else { $afl })))
$guid = Join-Path $virt 'GuestCommunicationServices\00002329-facb-11e6-bd58-64006a7986d3'
Say 'INFO' ("hv_sock 9001 service GUID: {0} (M3 registers it)" -f ($(if (Test-Path $guid) { 'present' } else { 'absent' })))

# --- the staged v40 package and the box files its manager env names (pins from nucbox-ownguest-40.json) ---
$pins = [ordered]@{
  'guest\igvm-vbs\vbs-linux-candidate-1539-b7ba7731.bin' = 'b7ba7731240ec9025f8c92651be17ecf8af17764e2c3eb0bd20af60f00923748'
  'control\vbslike-host.exe'                               = '435717def62bb5c9a632f80210b5c3fbcbeb7cb8c1047f9beef4ca578ebe99e7'
  'guest\runtime.json'                                     = 'ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8'
}
Check (Test-Path (Join-Path $Pkg 'staged.json')) "package staged ($Pkg\staged.json)"
foreach ($k in $pins.Keys) {
  $p = Join-Path $Pkg $k
  if (Test-Path $p) { Check ((Sha256Of $p) -eq $pins[$k]) "package $k = $($pins[$k].Substring(0,8))" } else { Say 'FAIL' "package $k is missing" }
}
Check (Test-Path (Join-Path $Pkg 'control\windows\vbslike\manager\main.mjs')) 'package control\windows\vbslike\manager\main.mjs present (the v40 manager)'
$box = [ordered]@{ 'C:\Users\claude\hyperv.psm1' = '17ca4352c500d3498f71be420ddfa418c7ed1d1b5f455856c24e633a4635e49c'
                   'C:\Users\claude\vbs-like\type1.vmgs' = '4f051697a74dc72d60e7b36d7cc80554493d64038ea6e146d72b454585ae930d' }
foreach ($k in $box.Keys) { if (Test-Path $k) { Check ((Sha256Of $k) -eq $box[$k]) "box file $k = $($box[$k].Substring(0,8))" } else { Say 'FAIL' "box file $k is missing" } }

# --- tools ---
$nodeExe = 'C:\Program Files\nodejs\node.exe'
if (Test-Path $nodeExe) { $v = [string](Invoke-Native { & $nodeExe --version 2>&1 }); Check ([int]($v.TrimStart('v').Split('.')[0]) -ge 22) "node.exe $v (>= 22)" } else { Say 'FAIL' "no $nodeExe" }
Check (Test-Path $Python) "python at $Python"
$npm = 'C:\Program Files\nodejs\npm.cmd'; Check (Test-Path $npm) "npm at $npm"

# --- the node's identity: the legacy node's keys, PRESENCE only (install copies them; the legacy dir stays as is) ---
foreach ($f in 'operator.key', 'proof.key') { Check (Test-Path (Join-Path $LegacyDir $f)) "legacy $f present (copied by the install, never printed)" }
Say 'INFO' ("legacy node-transport.key: {0}" -f ($(if (Test-Path (Join-Path $LegacyDir 'node-transport.key')) { 'present (copied)' } else { 'absent (the node mints one)' })))
$tpm = Join-Path $LegacyDir 'tpmattest.exe'
if (Test-Path $tpm) { Say 'PASS' ("legacy tpmattest.exe present, sha256 {0} (the install copies it and pins this hash)" -f (Sha256Of $tpm)) } else { Say 'FAIL' "no $tpm (build-tpmattest.cmd builds it)" }

# --- ports and the install root ---
foreach ($port in $ManagerPort, $DataPort, $LocalPort) {
  $l = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  Check ($l.Count -eq 0) "127.0.0.1:$port is free"
}
if (Test-Path $Root) { Say 'INFO' "$Root exists (a re-run keeps its state\ directory)" } else { Say 'PASS' "$Root is absent (first install)" }
$os = Get-CimInstance Win32_OperatingSystem
Say 'INFO' ("free memory {0:N1} GiB of {1:N1} GiB; free on C: {2:N1} GiB" -f ($os.FreePhysicalMemory / 1MB), ($os.TotalVisibleMemorySize / 1MB), ((Get-PSDrive C).Free / 1GB))

if ($script:fails -gt 0) { Write-Output "PREFLIGHT: $($script:fails) FAIL(s)"; exit 1 }
Write-Output 'PREFLIGHT: all PASS'
