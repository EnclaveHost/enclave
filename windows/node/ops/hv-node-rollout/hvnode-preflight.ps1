# hvnode-preflight.ps1 - READ-ONLY checks before the NucBox hv-node install (ROLLOUT.md step 1). It changes nothing,
# prints PASS / FAIL / INFO lines, and exits 1 if any FAIL. Run elevated (bcdedit and the task queries need it):
#   powershell -ExecutionPolicy Bypass -File hvnode-preflight.ps1 -Pkg C:\Users\claude\vbs-like\pkg\<16 hex> -ManifestSha256 <sha256>
# The package's pins (firmware, launcher, runtime.json, the box files its managerEnv names) come from the package's OWN
# MANIFEST.json, verified against -ManifestSha256, as hvnode-install.ps1 reads them: never from constants here.
# It never prints a key: key files are checked for PRESENCE only.
param(
  [Parameter(Mandatory = $true)][string]$Pkg,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ManifestSha256,
  [string]$PkgProfile = 'vbsLinux',
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

# --- the staged package, and the files and box files its manager env names, pinned by its OWN verified MANIFEST.json ---
$manFile = Join-Path $Pkg 'MANIFEST.json'
Check (Test-Path (Join-Path $Pkg 'staged.json')) "package staged ($Pkg\staged.json)"
if (-not (Test-Path -LiteralPath $manFile)) { Say 'FAIL' "no MANIFEST.json in $Pkg" }
elseif ((Sha256Of $manFile) -ne $ManifestSha256.ToLower()) { Say 'FAIL' "$manFile is not $ManifestSha256" }
else {
  Say 'PASS' "MANIFEST.json = $($ManifestSha256.Substring(0, 16))"
  Check ((Split-Path -Leaf $Pkg).ToLower() -eq $ManifestSha256.Substring(0, 16).ToLower()) "the staged directory is named by the manifest ($(Split-Path -Leaf $Pkg))"
  $man = Get-Content -Raw $manFile | ConvertFrom-Json
  $fileSha = @{}; foreach ($f in @($man.files)) { $fileSha["$($f.path)"] = "$($f.sha256)".ToLower() }
  $prof = $man.profiles.$PkgProfile
  if (-not $prof -or -not $prof.managerEnv) { Say 'FAIL' "the manifest has no profiles.$PkgProfile.managerEnv" }
  else {
    $want = @("$($man.runtime.file)") + @($prof.managerEnv | Where-Object { $_.PSObject.Properties.Name -contains 'file' } | ForEach-Object { "$($_.file)" })
    foreach ($rel in ($want | Sort-Object -Unique)) {
      $p = Join-Path $Pkg ($rel -replace '/', '\')
      if (-not $fileSha.ContainsKey($rel)) { Say 'FAIL' "the manifest lists no file $rel" }
      elseif (-not (Test-Path -LiteralPath $p)) { Say 'FAIL' "package $rel is missing" }
      else { Check ((Sha256Of $p) -eq $fileSha[$rel]) "package $rel = $($fileSha[$rel].Substring(0, 8))" }
    }
    foreach ($b in @($man.hostChecks.$PkgProfile.boxFiles)) {
      if (Test-Path -LiteralPath "$($b.path)") { Check ((Sha256Of "$($b.path)") -eq "$($b.sha256)".ToLower()) "box file $($b.path) = $("$($b.sha256)".Substring(0, 8))" }
      else { Say 'FAIL' "box file $($b.path) is missing" }
    }
    Say 'INFO' ("package {0} v{1}, profile {2}: runtime {3}" -f $man.name, $man.version, $PkgProfile, "$($man.runtime.runtimeId)".Substring(0, 16))
  }
}
Check (Test-Path (Join-Path $Pkg 'control\windows\vbslike\manager\main.mjs')) 'package control\windows\vbslike\manager\main.mjs present (the manager)'

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
