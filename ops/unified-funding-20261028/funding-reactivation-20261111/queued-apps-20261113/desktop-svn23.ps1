# The NucBox side of svn23.sh. Run with $mode set by the caller (svn23.sh prepends it); every run ends with a line
# starting DONE or STOP. Modes: status, verify, apply, revert, launch.
#
# Where this box keeps the native desktop release since host release 2026.11.18
# (docs/operations/windows-release-2026.11.18.md): the two local hooks, which an install never writes, each call the
# release folder's native-desktop-env.cmd, and the node's hook names the box's own admitted-image policy.
$ErrorActionPreference = 'Stop'
$root   = 'C:\ProgramData\Enclave'
$rel    = "$root\native-desktop\releases"
$old    = '5022c649a295aa10ac4708eea601a771ce81d8f4eb399955335314eed56b6d4b'
$new    = '097affc33f87fc4603e273aee2ffc1e5571da9f2fd454222855ff1ac9e6bfede'
$hooks  = @("$root\node-config.local.cmd", "$root\shield-config.local.cmd")
$pol    = "$root\native-desktop\admitted-shield-policy.json"
$polOld = 'd202746f943486a7239f5180a0811dd35fbaab35fa11c1fbdf56f8e756349e62'
$polNew = '8b61bcb1d6d891a6fad840f9a617789337b8ccd43db299d160818805732480da'
$stamp  = 'before-native-svn23-20261120'
$W      = 'C:\Users\claude\bundle-build'
$bundles = @{ new = @{ dir = "$W\out50"; version = '2026.11.20';   zip = '01c7255d9a2c88624155320ee5b9050738de6bb7c6604e10e169f782fbf240f7'; log = "$W\install50.log" }
              old = @{ dir = "$W\out49"; version = '2026.11.18.1'; zip = 'e50b163e59b62c4ab759335e334c5253c9bd8ff304b5fdd6dec63046ce4adbca'; log = "$W\install49-again.log" } }
$kvm    = '0xf9bb979a'
$staged = [ordered]@{
  'native-igvm.bin'        = '097affc33f87fc4603e273aee2ffc1e5571da9f2fd454222855ff1ac9e6bfede'
  'profile.json'           = '38ccf65dc0aef83b66ee9815e067b061eb6073f04525b7446b9bf81f4f2e45e2'
  'desktop-config.json'    = '00fb23081ce6079e4835d6a85396c7f60c9aea20bea389e42c9d2f0400129544'
  'desktop-release.json'   = '06d18c6bb624c15325d90ffe2f8500ee1409a62c6a06ccb8ecd0e50136727e6e'
  'shield-policy.json'     = $polNew
}

function Sha($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
function Cut($s,$n) { $s=[string]$s; $s.Substring(0,[Math]::Min($n,$s.Length)) }
function Health { try { (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8091/health' -TimeoutSec 5).Content | ConvertFrom-Json } catch { $null } }
function HealthLine($h) { if ($h) { "canStart=$($h.canStart) desktop.ready=$($h.desktop.ready) igvm=$(Cut $h.desktop.igvmSha256 12)" } else { 'no answer' } }
function Names($f) {
  $t = Get-Content -LiteralPath $f -Raw
  $o = $t.Contains("releases\$old\native-desktop-env.cmd"); $n = $t.Contains("releases\$new\native-desktop-env.cmd")
  if ($o -and -not $n) { 'old' } elseif ($n -and -not $o) { 'new' } else { 'neither or both' }
}
function Installed { try { (Get-Content 'C:\Program Files\Enclave\manifest.json' -Raw | ConvertFrom-Json).version } catch { 'unknown' } }
function Keep($f) { $b = "$f.$stamp"; if (-not (Test-Path -LiteralPath $b)) { Copy-Item -LiteralPath $f -Destination $b } }
function Verify {
  $bad = 0
  foreach ($n in $staged.Keys) { $p = "$rel\$new\$n"; if (-not (Test-Path -LiteralPath $p) -or (Sha $p) -ne $staged[$n]) { "MISMATCH $n"; $bad++ } }
  foreach ($n in 'root.iso','hashes.iso','native-desktop-env.cmd','shielded-bridge.exe') { if (-not (Test-Path -LiteralPath "$rel\$new\$n")) { "MISSING $n"; $bad++ } }
  $bad -eq 0
}
function NodeLines($since) {
  $day = (Get-Date).ToUniversalTime().ToString('HH:mm:ss')
  @(Get-Content "$root\logs\node.log" -Tail 4000 | Where-Object { $_ -match $kvm -and ($_.Substring(0,8) -ge $since -or $since -gt $day) } | Select-Object -Last 8) | ForEach-Object { '  ' + (Cut $_ 300) }
}
# A full install of one of the two bundles, as SYSTEM, the way 2026.11.18.1 was installed (doinstall49.ps1).
function Install($which) {
  $b = $bundles[$which]; $zip = "$($b.dir)\enclave-host-$($b.version).zip"
  $script:installed = $false
  if (-not (Test-Path -LiteralPath $zip) -or (Sha $zip) -ne $b.zip) { "$zip is not the built bundle; nothing installed"; return }
  $script = "$W\doinstall-$($b.version).ps1"
  @"
`$log = '$($b.log)'
"start `$((Get-Date).ToUniversalTime().ToString('o'))" | Set-Content `$log
Get-VM | ForEach-Object { "vm-before `$(`$_.Name) `$(`$_.State)" } | Add-Content `$log
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File '$($b.dir)\work\enclave-host\install-host.ps1' -Name nucbox-k11-4 -Owner 'NUCBOX_K11\srbat' -SetupExe '$($b.dir)\EnclaveSetup.exe' -ManageWindowsUpdate off *>> `$log
"exit `$LASTEXITCODE `$((Get-Date).ToUniversalTime().ToString('o'))" | Add-Content `$log
"@ | Set-Content -LiteralPath $script
  $task = 'EnclaveInstallSvn23'
  $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
  Register-ScheduledTask -TaskName $task -Action $a -Principal (New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest) -Force | Out-Null
  if (Test-Path -LiteralPath $b.log) { Remove-Item -LiteralPath $b.log }
  Start-ScheduledTask -TaskName $task
  "install of $($b.version) started as SYSTEM; its log is $($b.log)"
  $done = $null
  for ($i = 0; $i -lt 120 -and -not $done; $i++) {
    Start-Sleep -Seconds 10
    if (Test-Path -LiteralPath $b.log) { $done = Get-Content -LiteralPath $b.log -Tail 1 | Where-Object { $_ -match '^exit ' } }
  }
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $b.log) { Get-Content -LiteralPath $b.log -Tail 12 | ForEach-Object { '  ' + (Cut $_ 220) } }
  if (-not $done) { 'the install did not finish within twenty minutes; its log is above'; return }
  if ($done -notmatch '^exit 0 ') { "the install ended with: $done"; return }
  if ((Installed) -ne $b.version) { "the install says it finished but the box reports $(Installed)"; return }
  $script:installed = $true
}
function Point($from,$to) {
  foreach ($f in $hooks) {
    $t = Get-Content -LiteralPath $f -Raw
    Set-Content -LiteralPath $f -Value ($t.Replace("releases\$from\native-desktop-env.cmd", "releases\$to\native-desktop-env.cmd")) -NoNewline
  }
}
# apply: hooks and policy to the new release, then the new bundle. revert: the same back. If the install fails, the
# hooks and the policy are put back as they were, so the running bundle and what it reads still agree.
function Switch-Box($which) {
  $from, $to, $pFrom, $pTo = if ($which -eq 'new') { $old, $new, $polOld, $polNew } else { $new, $old, $polNew, $polOld }
  $state = @($hooks | ForEach-Object { Names $_ }); $ps = Sha $pol
  $want = if ($which -eq 'new') { 'new' } else { 'old' }
  if (($state | Where-Object { $_ -ne $want }).Count -eq 0 -and $ps -eq $pTo -and (Installed) -eq $bundles[$which].version) {
    $h = Health; "DONE box (already on this release: bundle $(Installed), manager $(HealthLine $h))"; return
  }
  $have = if ($which -eq 'new') { 'old' } else { 'new' }
  if (($state | Where-Object { $_ -ne $have }).Count -ne 0 -or $ps -ne $pFrom) { "STOP: the hooks name [$($state -join ', ')] and the policy is $(Cut $ps 16): not the state this step starts from; nothing changed"; return }
  if ($which -eq 'new' -and -not (Verify)) { 'STOP: the staged release folder does not verify; nothing changed'; return }
  $source = if ($which -eq 'new') { "$rel\$new\shield-policy.json" } else { "$pol.$stamp" }
  if (-not (Test-Path -LiteralPath $source) -or (Sha $source) -ne $pTo) { "STOP: $source is not the policy this step installs; nothing changed"; return }
  foreach ($f in $hooks + $pol) { Keep $f }
  Point $from $to; Copy-Item -LiteralPath $source -Destination $pol -Force
  "hooks now call releases\$(Cut $to 12)...; the box's policy is $(Cut (Sha $pol) 16)"
  Install $which
  if (-not $script:installed) {
    Point $to $from; Copy-Item -LiteralPath $(if ($which -eq 'new') { "$pol.$stamp" } else { "$rel\$new\shield-policy.json" }) -Destination $pol -Force
    "STOP: hooks and policy are back as they were (policy $(Cut (Sha $pol) 16)); the bundle reported is $(Installed). Roles the installer stopped may need '$($bundles[$have].version)' installed again"
    return
  }
  $h = $null; for ($i = 0; $i -lt 60; $i++) { $h = Health; if ($h -and $h.desktop.igvmSha256 -eq $to) { break }; Start-Sleep -Seconds 5 }
  "manager: $(HealthLine $h)"
  if (-not $h -or $h.desktop.igvmSha256 -ne $to) { "STOP: bundle $(Installed) is installed and the hooks and policy name this release, but the manager does not report it" ; return }
  "DONE box (bundle $(Installed); previous hooks and policy kept as *.$stamp)"
}

switch ($mode) {
  'verify' { if (Verify) { 'DONE staged' } else { 'STOP: staged files differ' } }
  'status' {
    "bundle: $(Installed)"
    foreach ($f in $hooks) { "$(Split-Path $f -Leaf) names: $(Names $f)" }
    $ps = Sha $pol; "box policy: $(if ($ps -eq $polNew) { 'SVN23' } elseif ($ps -eq $polOld) { 'SVN22 (previous)' } else { 'another file ' + (Cut $ps 16) })"
    "staged: $(if (Verify) { 'yes' } else { 'no' })"
    "manager: $(HealthLine (Health))"
    Get-ScheduledTask -TaskPath '\Enclave\' | Where-Object { $_.TaskName -in 'Shield','Node','Network','Card','Relay' } | ForEach-Object { "task $($_.TaskName): $($_.State)" }
    "node on ${kvm}:"; NodeLines '00:00:00'
    'DONE status'
  }
  'apply'  { Switch-Box 'new' }
  'revert' { Switch-Box 'old' }
  'launch' {
    $vm = @(Get-VM | Where-Object { $_.Name -match 'enclave-app' } | ForEach-Object { "$($_.Name) $($_.State) $([Math]::Round($_.MemoryAssigned/1GB,1))GB up=$($_.Uptime.ToString('hh\:mm\:ss'))" })
    "manager: $(HealthLine (Health)); app VMs: $($vm.Count)"
    $lines = NodeLines $since; $lines
    $text = $lines -join "`n"
    if ($text -match 'not claimed|giving up|refused') { 'DONE launch refused' }
    elseif ($text -match "$kvm isolation adopted|claimed $kvm") { 'DONE launch running' }
    else { 'DONE launch waiting' }
  }
  default { "STOP: no such mode: $mode" }
}
