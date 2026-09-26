# hvnode-tray-check.ps1 - READ-ONLY: does the owner's hosting tray (windows/tray, EnclaveTray, main 4ef0e862) survive the
# host reboot (REBOOT-GO-v42.md steps 3a and 9a)? It reads; it never starts, stops, loads or writes anything but its own
# JSON in -OutDir (-OutDir - prints it instead).
#   powershell -ExecutionPolicy Bypass -File hvnode-tray-check.ps1 -Phase pre  -OutDir <the reboot OutDir>
#   powershell -ExecutionPolicy Bypass -File hvnode-tray-check.ps1 -Phase post -OutDir <the same dir>
# What windows/tray/install-tray.cmd set up (read from it, not assumed), and what the node adds:
#   - the exe: %LOCALAPPDATA%\Enclave\Tray\EnclaveTray.exe of the tray user (their profile from ProfileList);
#   - the logon start: HKCU\Software\Microsoft\Windows\CurrentVersion\Run value EnclaveHostingTray = "<that exe>", in the
#     tray user's OWN hive, which Windows loads only while they are signed in. This script reads it only then: it never
#     loads the hive (reg load would lock NTUSER.DAT and could break their next logon);
#   - the caps the sliders write: the node's hosting-caps.json (NODE_DIR, or HOSTING_CAPS_FILE in run-node.cmd);
#   - the node re-mints %ProgramData%\Enclave\hosting\hosting-admin.token at start with a DACL granting HOSTING_TRAY_USER
#     read: the ACL is read, the token never is.
# The box has no AutoAdminLogon (REBOOT.md), so after a reboot the tray runs only once its user signs in: with no session
# that is INFO ("starts at the user's next logon"), never a FAIL. Re-run -Phase post after they sign in to complete it.
param(
  [Parameter(Mandatory = $true)][ValidateSet('pre', 'post')][string]$Phase,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$TrayUser = 'NUCBOX_K11\srbat',
  [string]$Root = 'C:\Users\claude\vbs-like\hvnode',
  # pre: the caps file's sha256 as last read (REBOOT-GO-v42.md 3a); REQUIRED, so a mis-resolved caps path FAILS rather
  # than reading as "no caps" (enclave-bf's S1)
  [string]$ExpectCapsSha256 = ''
)
$ErrorActionPreference = 'Stop'
$script:fails = 0
function Say([string]$k, [string]$m) { Write-Output ("{0,-4} {1}" -f $k, $m); if ($k -eq 'FAIL') { $script:fails++ } }
function Check([bool]$ok, [string]$m) { if ($ok) { Say 'PASS' $m } else { Say 'FAIL' $m } }
function ShaOf([string]$p) { if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() } else { $null } }

$user = ($TrayUser -split '\\')[-1]
$sid = (New-Object System.Security.Principal.NTAccount($TrayUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
$profileDir = [string](Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid").ProfileImagePath
$exe = Join-Path $profileDir 'AppData\Local\Enclave\Tray\EnclaveTray.exe'

# the Run value, from the user's hive only if Windows has it loaded
$hive = "Registry::HKEY_USERS\$sid"
$hiveLoaded = [bool](Test-Path -LiteralPath $hive)
$runValue = $null
if ($hiveLoaded) {
  $rk = Get-ItemProperty -LiteralPath "$hive\Software\Microsoft\Windows\CurrentVersion\Run" -ErrorAction SilentlyContinue
  if ($rk -and ($rk.PSObject.Properties.Name -contains 'EnclaveHostingTray')) { $runValue = [string]$rk.EnclaveHostingTray }
}

# the caps file: HOSTING_CAPS_FILE if the node's config sets it, else NODE_DIR\hosting-caps.json. The config is
# node-config.cmd (which run-node.cmd calls, since -NodeOnly) or run-node.cmd itself (older layouts); NODE_DIR is read
# from it too, defaulting to <Root>\state
$nodeDir = Join-Path $Root 'state'
$capsSet = $null
foreach ($cfg in @((Join-Path $Root 'node-config.cmd'), (Join-Path $Root 'run-node.cmd'))) {
  if (-not (Test-Path -LiteralPath $cfg)) { continue }
  foreach ($line in @(Get-Content -LiteralPath $cfg)) {
    if ($line -match '^\s*set\s+"?NODE_DIR=([^"]+)"?\s*$') { $nodeDir = $matches[1].Trim() }
    if ($line -match '^\s*set\s+"?HOSTING_CAPS_FILE=([^"]+)"?\s*$') { $capsSet = $matches[1].Trim() }
  }
}
$capsFile = if ($capsSet) { $capsSet } else { Join-Path $nodeDir 'hosting-caps.json' }
$caps = $null
if (Test-Path -LiteralPath $capsFile) { $c = Get-Content -Raw -LiteralPath $capsFile | ConvertFrom-Json; $caps = @{ cpuShare = $c.cpuShare; gpuShare = $c.gpuShare; updatedAt = [string]$c.updatedAt } }

# the node's token: its ACL only (does it grant the tray user read?)
$token = Join-Path $env:ProgramData 'Enclave\hosting\hosting-admin.token'
$tokenGrant = $null
if (Test-Path -LiteralPath $token) {
  $tokenGrant = [bool](@((Get-Acl -LiteralPath $token).Access | Where-Object {
    $_.AccessControlType -eq 'Allow' -and ([string]$_.FileSystemRights -match 'Read') -and
    (([string]$_.IdentityReference -ieq $TrayUser) -or ([string]$_.IdentityReference -ieq $sid)) }).Count)
}

# the user's sessions (query user; exit 1 and no output when nobody is signed in) and the tray's processes
$sessions = @()
# a native command's stderr must not trip Stop (PowerShell 5.1): query.exe writes "No User exists" there, exit 1
$e = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try { $q = @(& query.exe user 2>$null); $qExit = $LASTEXITCODE } finally { $ErrorActionPreference = $e }
foreach ($l in $q) { if ($l -match '^\s*>?(\S+)\s+(\S*)\s+(\d+)\s+(Active|Disc)\b') { if ($matches[1] -ieq $user) { $sessions += [int]$matches[3] } } }
# a second source that parses nothing: an explorer.exe owned by the user means an interactive session exists
$explorerSessions = @()
foreach ($x in @(Get-CimInstance Win32_Process -Filter "Name = 'explorer.exe'")) {
  $xo = Invoke-CimMethod -InputObject $x -MethodName GetOwner
  if ("$($xo.Domain)\$($xo.User)" -ieq $TrayUser) { $explorerSessions += [int]$x.SessionId }
}
$procs = @()
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name = 'EnclaveTray.exe'")) {
  $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner
  $procs += @{ pid = [int]$p.ProcessId; session = [int]$p.SessionId; path = [string]$p.ExecutablePath; owner = "$($o.Domain)\$($o.User)" }
}

$now = @{
  phase = $Phase; at = (Get-Date).ToUniversalTime().ToString('o'); bootId = $(try { [int](Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters' -Name BootId -ErrorAction Stop).BootId } catch { $null })
  trayUser = $TrayUser; sid = $sid; exe = $exe; exeSha256 = (ShaOf $exe)
  hiveLoaded = $hiveLoaded; runValue = $runValue
  capsFile = $capsFile; capsSha256 = (ShaOf $capsFile); caps = $caps
  tokenPresent = [bool](Test-Path -LiteralPath $token); tokenGrantsTrayUserRead = $tokenGrant
  tokenWrittenUtc = $(if (Test-Path -LiteralPath $token) { (Get-Item -LiteralPath $token).LastWriteTimeUtc.ToString('o') } else { $null })
  lastBootUtc = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
  sessions = $sessions; queryExit = $qExit; explorerSessions = $explorerSessions; trayProcesses = $procs
  autoAdminLogon = [string](Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction SilentlyContinue).AutoAdminLogon
}
$json = $now | ConvertTo-Json -Depth 5
if ($OutDir -eq '-') { $json } else { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null; Set-Content -Path (Join-Path $OutDir "tray-$Phase.json") -Value $json -Encoding UTF8 }

$wantRun = '"' + $exe + '"'
$mine = @($procs | Where-Object { $_.owner -ieq $TrayUser -and $_.path -ieq $exe -and ($sessions -contains $_.session) })
# THE SESSION PARSE MUST BE TRUSTWORTHY before "no session" can be INFO (enclave-bf's S2): query.exe exits 0 or 1 (over
# ssh it exits 1 even while it lists sessions: measured 2026-09-26 07:4xZ, so the exit code says nothing about "none"),
# and neither a tray nor an explorer owned by the user may run in a session the parse did not find
Check (($qExit -eq 0) -or ($qExit -eq 1)) "query.exe user exited $qExit (0 or 1; anything else FAILS)"
$ownTray = @($procs | Where-Object { $_.owner -ieq $TrayUser })
$unparsed = @(@($ownTray | ForEach-Object { $_.session }) + $explorerSessions | Where-Object { $sessions -notcontains $_ } | Sort-Object -Unique)
Check ($unparsed.Count -eq 0) "every session where $TrayUser runs EnclaveTray or explorer was parsed from query.exe (unparsed: $($unparsed -join ',')$(if (-not $unparsed.Count) { 'none' }))"
if ($Phase -eq 'pre') {
  Check ([bool]$now.exeSha256) "tray exe present: $exe sha256 $($now.exeSha256)"
  if (-not $ExpectCapsSha256) { Say 'FAIL' 'pass -ExpectCapsSha256 <the caps file sha256 as last read>: the caps must be FOUND, not assumed absent' }
  else { Check ($now.capsSha256 -eq $ExpectCapsSha256.ToLower()) "the caps file is found at ${capsFile} with the expected sha256 $ExpectCapsSha256 (read $($now.capsSha256))" }
  if ($hiveLoaded) { Check ($runValue -eq $wantRun) "HKCU Run EnclaveHostingTray = $runValue (the installed exe)" }
  else { Say 'INFO' "$user's hive is not loaded ($user not signed in): the Run value is not read (never loaded by this check)" }
  if ($caps) { Say 'INFO' "caps ${capsFile} sha256 $($now.capsSha256): cpuShare $($caps.cpuShare), gpuShare $($caps.gpuShare) (updatedAt $($caps.updatedAt))" }
  else { Say 'INFO' "no caps file at ${capsFile}: the node runs on its defaults (no caps set)" }
  Check ($tokenGrant -eq $true) "the node's token grants $TrayUser read (HOSTING_TRAY_USER)"
  if ($sessions.Count) { Check ($mine.Count -ge 1) "$user is signed in (session $($sessions -join ',')) and EnclaveTray runs there as $TrayUser from the installed exe" }
  else { Say 'INFO' "$user has no session now" }
  Say 'INFO' "AutoAdminLogon '$($now.autoAdminLogon)'"
} else {
  $pre = Get-Content -Raw -LiteralPath (Join-Path $OutDir 'tray-pre.json') | ConvertFrom-Json
  Check ($now.exeSha256 -and $now.exeSha256 -eq $pre.exeSha256) "tray exe unchanged across the reboot: sha256 $($now.exeSha256) (pre $($pre.exeSha256))"
  if ($hiveLoaded) {
    Check ($runValue -eq $wantRun) "HKCU Run EnclaveHostingTray still registered and points at the installed exe: $runValue"
    if ($pre.hiveLoaded) { Check ($runValue -eq [string]$pre.runValue) 'the Run value is the one read before the reboot' }
  } else { Say 'INFO' "$user's hive is not loaded ($user not signed in since the boot): the Run value is not read here; re-run -Phase post after $user signs in" }
  if ($pre.caps -or $caps) {
    Check (($now.capsSha256 -eq $pre.capsSha256) -and $caps -and ($caps.cpuShare -eq $pre.caps.cpuShare) -and ($caps.gpuShare -eq $pre.caps.gpuShare)) "the hosting caps are unchanged: cpuShare $($caps.cpuShare) gpuShare $($caps.gpuShare) (pre $($pre.caps.cpuShare)/$($pre.caps.gpuShare)); file sha256 $($now.capsSha256)"
  } else { Say 'INFO' 'no caps file before or after: the node runs on its defaults' }
  Check ($tokenGrant -eq $true) "the node's token grants $TrayUser read"
  Check ($now.tokenWrittenUtc -and ([datetime]$now.tokenWrittenUtc -gt [datetime]$now.lastBootUtc)) "the node re-minted its token after this boot: written $($now.tokenWrittenUtc), boot $($now.lastBootUtc)"
  if ($sessions.Count) { Check ($mine.Count -ge 1) "$user is signed in (session $($sessions -join ',')): EnclaveTray runs there as $TrayUser from the installed exe" }
  else { Say 'INFO' "no $user session since the boot: EnclaveTray starts at $user's next logon (HKCU Run), not a failure (no AutoAdminLogon)" }
}
if ($script:fails) { Write-Output "TRAY ($Phase): $($script:fails) FAIL"; exit 1 } else { Write-Output "TRAY ($Phase): no FAIL"; exit 0 }
