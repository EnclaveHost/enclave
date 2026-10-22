# tunnel-receiver.ps1 v2 - minipc end of the control VM's challenge-DNS feed (127.0.0.1:31053). ROOT-RUN ONLY, PS 5.1.
# Staged by tunnel_install.py into a PROTECTED dir (SYSTEM + Administrators only) with params.json beside it. The SYSTEM
# scheduled tasks start it through a launcher that re-checks that dir's ACL and both files' hashes first.
# Modes:
#   preflight  read-only facts
#   apply      CAS -> run backup (a NEW child dir; no existing directory's ACL is ever changed) -> new local user
#              (random password, in memory only) -> keys file -> sshd_config + managed block (sshd -t first) -> ONE sshd
#              restart + health. Every mutation is recorded in state.json BEFORE the next step (receipt ownership).
#   guard      dead-man switch: unless confirm.ok exists, rollback of exactly what state.json records.
#   rollback   reverts ONLY this run's recorded mutations, each by exact hash/SID; anything changed since is left in place
#              and reported as a conflict (decision "rollback-conflict", never "rolled-back").
#   confirm    writes confirm.ok.
# sandbox (params.sandbox=true): every path lives under params.sandboxRoot, accounts are a JSON file there, sshd is never
# restarted, no scheduled task is touched - for native tests of this logic on a real Windows host without side effects.
param([Parameter(Mandatory)][ValidateSet('preflight','apply','guard','rollback','confirm')][string]$Mode, [string]$Dir = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$ADMINS = 'S-1-5-32-544'; $SYSTEM = 'S-1-5-18'
# a directory SYSTEM runs code from: not a reparse point, owner SYSTEM/Administrators, and no write right for anyone else
function TrustProblem($path) {
  $it = Get-Item -LiteralPath $path -Force
  if ($it.Attributes -band [IO.FileAttributes]::ReparsePoint) { return "$path is a reparse point" }
  $acl = Get-Acl -LiteralPath $path; $SIDT = [Security.Principal.SecurityIdentifier]
  $owner = $acl.GetOwner($SIDT).Value
  if ($owner -notin @($SYSTEM, $ADMINS)) { return "$path owner is $owner" }
  # WriteData AppendData WriteEA DeleteChild WriteAttributes Delete WRITE_DAC WRITE_OWNER + GENERIC_WRITE/ALL (as the launcher)
  $W = 0x500D0156
  foreach ($ace in $acl.GetAccessRules($true, $true, $SIDT)) {
    $who = $ace.IdentityReference.Value
    if ($ace.AccessControlType -eq 'Allow' -and ([int]$ace.FileSystemRights -band $W) -and $who -notin @($SYSTEM, $ADMINS)) { return "$path grants write to $who" } }
  return $null
}
if ($Mode -ne 'preflight') {
  foreach ($x in @($Dir) + @(Get-ChildItem -LiteralPath $Dir -Force | ForEach-Object { $_.FullName })) { $t = TrustProblem $x
    if ($t) { [ordered]@{ mode = $Mode; decision = "refused: staging not trusted: $t"; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json |
              Set-Content -Encoding UTF8 -LiteralPath (Join-Path $Dir "receipt-$Mode.json"); exit 0 } }
}

$P = Get-Content -Raw -LiteralPath (Join-Path $Dir 'params.json') | ConvertFrom-Json
$WINUSER = [string]$P.winUser
$SBX = [bool]$P.sandbox
if ($SBX) {
  $ROOTDIR = [IO.Path]::GetFullPath([string]$P.sandboxRoot)
  $CFG = Join-Path $ROOTDIR 'sshd_config'; $KEYS = Join-Path $ROOTDIR "$WINUSER`_authorized_keys"; $BPARENT = Join-Path $ROOTDIR 'backup'
} else {
  $CFG = 'C:\ProgramData\ssh\sshd_config'; $KEYS = "C:\ProgramData\ssh\$WINUSER`_authorized_keys"; $BPARENT = 'C:\ProgramData\Enclave\backup'
}
$SSHD = 'C:\Windows\System32\OpenSSH\sshd.exe'
$BEGIN = "# BEGIN $WINUSER (managed by tunnel-receiver.ps1; do not edit)"
$END = "# END $WINUSER"
$BACKUP = Join-Path $BPARENT ('tunnel-' + $P.runId)
$STATEFILE = Join-Path $Dir 'state.json'
$RECEIPT = Join-Path $Dir ("receipt-$Mode.json")
$CONFIRM = Join-Path $Dir 'confirm.ok'
function Sha($path) { if (Test-Path -LiteralPath $path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower() } else { 'absent' } }
function ShaText($t) { $h = [Security.Cryptography.SHA256]::Create(); (($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($t)) | ForEach-Object { $_.ToString('x2') }) -join '') }
$R = [ordered]@{ mode = $Mode; runId = $P.runId; sandbox = $SBX; at = (Get-Date).ToUniversalTime().ToString('o'); steps = @() }
function Save { $R | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 -LiteralPath $RECEIPT }
function Step($name, $extra = $null) { $R.steps += [ordered]@{ step = $name; at = (Get-Date).ToUniversalTime().ToString('o'); detail = $extra }; Save }
function Done($decision) { $R.decision = $decision; $R.finishedAt = (Get-Date).ToUniversalTime().ToString('o'); Save; exit 0 }
function LoadState { if (Test-Path -LiteralPath $STATEFILE) { Get-Content -Raw -LiteralPath $STATEFILE | ConvertFrom-Json } else { $null } }
function SaveState($s) { $s | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $STATEFILE }

# ---- the guard rails ----
if ($WINUSER -notmatch '^[a-z0-9][a-z0-9-]{0,19}$') { Done 'refused: winUser must be 1-20 of [a-z0-9-] (Windows SAM limit 20)' }
if ($SBX) {
  foreach ($x in @($CFG, $KEYS, $BPARENT, $BACKUP, $Dir)) {
    if (-not ([IO.Path]::GetFullPath($x)).StartsWith($ROOTDIR + '\', [StringComparison]::OrdinalIgnoreCase)) { Done "refused: sandbox path outside the sandbox root: $x" } }
}
# ---- accounts: real local users, or a JSON file in sandbox mode ----
$ACCT = if ($SBX) { Join-Path $ROOTDIR 'accounts.json' } else { $null }
# PS 5.1 ConvertFrom-Json emits a JSON array as ONE object: enumerate it explicitly (one output per account)
function AcctAll { if ($SBX -and (Test-Path -LiteralPath $ACCT)) { $x = Get-Content -Raw -LiteralPath $ACCT | ConvertFrom-Json; foreach ($acc in @($x)) { if ($null -ne $acc) { $acc } } } }
function AcctByName($n) { if ($SBX) { @(AcctAll | Where-Object { $_.name -eq $n })[0] } else { $u = Get-LocalUser -Name $n -ErrorAction SilentlyContinue; if ($u) { [pscustomobject]@{ name = $u.Name; sid = [string]$u.SID } } else { $null } } }
function AcctBySid($s) { if ($SBX) { @(AcctAll | Where-Object { $_.sid -eq $s })[0] } else { $u = Get-LocalUser -SID $s -ErrorAction SilentlyContinue; if ($u) { [pscustomobject]@{ name = $u.Name; sid = [string]$u.SID } } else { $null } } }
function IsAdmin($sid) { if ($SBX) { $false } else { @(Get-LocalGroupMember -SID $ADMINS | ForEach-Object { [string]$_.SID }) -contains $sid } }
function AcctCreate {
  if ($SBX) { $s = 'S-1-5-21-0-0-0-' + (Get-Random -Minimum 1000 -Maximum 99999); ConvertTo-Json -InputObject @(@(AcctAll) + @([pscustomobject]@{ name = $WINUSER; sid = $s })) | Set-Content -LiteralPath $ACCT; return $s }
  $bytes = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $pw = ConvertTo-SecureString ([Convert]::ToBase64String($bytes) + 'aA1!') -AsPlainText -Force; [Array]::Clear($bytes, 0, $bytes.Length)
  New-LocalUser -Name $WINUSER -Password $pw -Description ([string]$P.userDescription) -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires | Out-Null
  $pw.Dispose(); return [string](Get-LocalUser -Name $WINUSER).SID
}
function AcctRemove($sid) {
  if ($SBX) { ConvertTo-Json -InputObject @(AcctAll | Where-Object { $_.sid -ne $sid }) | Set-Content -LiteralPath $ACCT; return }
  Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue | Remove-CimInstance -ErrorAction SilentlyContinue
  Remove-LocalUser -SID $sid
}

$BLOCK = @($BEGIN, "Match User $WINUSER",
  "    AuthorizedKeysFile __PROGRAMDATA__/ssh/$WINUSER`_authorized_keys",
  '    AuthenticationMethods publickey', '    PasswordAuthentication no', '    PubkeyAuthentication yes',
  '    AllowTcpForwarding remote', '    PermitListen 127.0.0.1:31053', '    PermitOpen none', '    GatewayPorts no',
  '    PermitTTY no', '    X11Forwarding no', '    AllowAgentForwarding no', '    AllowStreamLocalForwarding no',
  '    PermitTunnel no', '    ForceCommand cmd.exe /c exit 1', $END) -join "`r`n"

function Facts {
  $text = if (Test-Path -LiteralPath $CFG) { [IO.File]::ReadAllText($CFG) } else { '' }
  $u = AcctByName $WINUSER
  [ordered]@{ sshd = $(if ($SBX) { 'sandbox' } else { [string](Get-Service sshd).Status }); configSha = (Sha $CFG); blockPresent = $text.Contains($BEGIN)
    userPresent = [bool]$u; userSid = $(if ($u) { $u.sid } else { $null }); keysSha = (Sha $KEYS); backupPresent = (Test-Path -LiteralPath $BACKUP)
    listen31053 = @(if (-not $SBX) { Get-NetTCPConnection -LocalPort 31053 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress } })
    confirm = (Test-Path -LiteralPath $CONFIRM); state = (LoadState) }
}
function KeysAcl($f) {
  $acl = New-Object Security.AccessControl.FileSecurity; $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier $ADMINS))
  foreach ($who in $SYSTEM, $ADMINS) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $who), 'FullControl', 'Allow'))) }
  Set-Acl -LiteralPath $f -AclObject $acl
}
function TestConfig($f) { $o = & $SSHD -t -f $f 2>&1; return @{ ok = ($LASTEXITCODE -eq 0); out = (($o | Out-String).Trim()) } }
function RestartHealthy {
  if ($SBX) { Step 'sandbox: sshd NOT restarted'; return $true }
  Restart-Service -Name sshd -Force
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if ((Get-Service sshd).Status -eq 'Running' -and @(Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { return $true }
    Start-Sleep -Seconds 1 }
  return $false
}
function ReplaceFile($tmp) { $acl = Get-Acl -LiteralPath $CFG; [IO.File]::Replace($tmp, $CFG, [NullString]::Value); Set-Acl -LiteralPath $CFG -AclObject $acl }

# ---- rollback: ONLY what state.json says this run did, each by exact hash / SID ----
function Rollback($why) {
  Step 'rollback-start' $why
  $s = LoadState; $conflicts = @(); $changed = $false
  if (-not $s) { Step 'nothing recorded: this run changed nothing'; return @{ conflicts = @(); nothing = $true; healthy = $true } }
  if ($s.configWritten) {
    $cur = Sha $CFG; $orig = Join-Path $BACKUP 'sshd_config.orig'
    if ($cur -eq $s.configWritten -and (Sha $orig) -eq $s.configBefore) {
      $tmp = $CFG + '.rb-' + $P.runId; Copy-Item -LiteralPath $orig -Destination $tmp -Force; ReplaceFile $tmp
      $changed = $true; Step 'config: restored the backup (nothing else had changed it)' (Sha $CFG)
    } else {
      $text = [IO.File]::ReadAllText($CFG); $n = ([regex]::Matches($text, [regex]::Escape($BLOCK))).Count
      if ($n -eq 1) {
        $i = $text.IndexOf($BLOCK); $j = $i + $BLOCK.Length
        while ($j -lt $text.Length -and ($text[$j] -eq "`r" -or $text[$j] -eq "`n")) { $j++ }
        $k = $i; while ($k -gt 0 -and ($text[$k - 1] -eq "`r" -or $text[$k - 1] -eq "`n")) { $k-- }
        $new = $text.Substring(0, $k) + "`r`n" + $text.Substring($j)
        $tmp = $CFG + '.rb-' + $P.runId; [IO.File]::WriteAllText($tmp, $new, (New-Object Text.UTF8Encoding $false))
        $t = TestConfig $tmp
        if ($t.ok) { ReplaceFile $tmp; $changed = $true; Step 'config: removed ONLY this run''s exact block; later changes kept' (Sha $CFG) }
        else { Remove-Item -LiteralPath $tmp -Force; $conflicts += 'config: block removal would fail sshd -t: left in place' }
      } elseif ($n -eq 0) { Step 'config: this run''s block is no longer there' }
      else { $conflicts += "config: the block occurs $n times: left in place" }
    }
  }
  if ($s.keysWritten) {
    $cur = Sha $KEYS
    if ($cur -eq $s.keysWritten) { Remove-Item -LiteralPath $KEYS -Force; Step 'keys: removed (exactly the bytes this run wrote)' }
    elseif ($cur -eq 'absent') { Step 'keys: already absent' }
    else { $conflicts += "keys: changed since apply ($cur): left in place" }
  }
  if ($s.createdSid) {
    $u = AcctBySid $s.createdSid
    if ($u) { AcctRemove $s.createdSid; Step 'user: removed the account this run created' $s.createdSid } else { Step 'user: already absent' $s.createdSid }
  }
  $h = $true
  if ($changed) { $h = RestartHealthy; Step 'sshd-restarted' @{ healthy = $h; configTest = (TestConfig $CFG).ok } }
  else { Step 'sshd not restarted: its configuration did not change' }
  return @{ conflicts = $conflicts; nothing = $false; healthy = $h }
}
function RollbackDecision($res) {
  if (-not $res.healthy) { return 'rollback-UNHEALTHY: sshd did not come back; root inspects at once' }
  if ($res.conflicts.Count) { $R.conflicts = $res.conflicts; return 'rollback-conflict: manual review (later changes were preserved)' }
  if ($res.nothing) { return 'nothing-to-roll-back' }
  return 'rolled-back'
}

if ($Mode -eq 'preflight') { $R.facts = Facts; Done 'facts' }
if ($Mode -eq 'confirm') { Set-Content -LiteralPath $CONFIRM -Value ((Get-Date).ToUniversalTime().ToString('o')); $R.facts = Facts; Done 'confirmed' }
if ($Mode -eq 'guard') {
  if (-not $SBX) { try { Unregister-ScheduledTask -TaskName ('EnclaveTunnelGuard-' + $P.runId) -Confirm:$false -ErrorAction SilentlyContinue } catch {} }
  if (Test-Path -LiteralPath $CONFIRM) { $R.facts = Facts; Done 'confirmed: guard did nothing' }
  $rb = Rollback 'guard: no confirm.ok within the window'; $R.facts = Facts; Done ('guard: ' + (RollbackDecision $rb))
}
if ($Mode -eq 'rollback') { $rb = Rollback 'manual'; $R.facts = Facts; Done (RollbackDecision $rb) }

# ---- apply ----
if (-not $SBX) { try { Unregister-ScheduledTask -TaskName ('EnclaveTunnelApply-' + $P.runId) -Confirm:$false -ErrorAction SilentlyContinue } catch {} }
if (Test-Path -LiteralPath $STATEFILE) { Done 'refused: state.json exists (this run already applied or failed): roll back first' }
$f = Facts; $R.before = $f
$why = @()
if (-not $SBX -and $f.sshd -ne 'Running') { $why += 'sshd is not Running' }
if ($f.configSha -ne [string]$P.expectConfigSha) { $why += 'sshd_config is not the pinned file' }
if ($f.blockPresent) { $why += 'a managed block is already present' }
if ($f.userPresent) { $why += "a user named $WINUSER already exists" }
if ($f.keysSha -ne 'absent') { $why += 'the keys file already exists' }
if ($f.listen31053.Count) { $why += '127.0.0.1:31053 is already in use' }
if (Test-Path -LiteralPath $BACKUP) { $why += 'this run''s backup dir already exists' }
if ([string]$P.publicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/]{68}$') { $why += 'publicKey is not one ssh-ed25519 public key' }
if ([string]$P.userDescription -eq '' -or ([string]$P.userDescription).Length -gt 48) { $why += 'userDescription must be 1-48 characters' }
if ((ShaText $BLOCK) -ne [string]$P.blockSha) { $why += 'the managed block is not the reviewed bytes' }
if (-not $SBX -and -not (Get-ScheduledTask -TaskName ('EnclaveTunnelGuard-' + $P.runId) -ErrorAction SilentlyContinue)) { $why += 'the guard task is not registered' }
if (Test-Path -LiteralPath $BPARENT) { $bp = Get-Item -LiteralPath $BPARENT -Force; if ($bp.Attributes -band [IO.FileAttributes]::ReparsePoint) { $why += 'the backup parent is a reparse point' } }
if ($why.Count) { Done ('refused: ' + ($why -join '; ')) }   # NOTHING was changed: state.json does not exist, the guard does nothing
$state = [ordered]@{ runId = $P.runId; configBefore = $f.configSha; configWritten = $null; backup = $BACKUP; keysWritten = $null; createdSid = $null }
SaveState $state
# the run's OWN backup dir: created new, with its own protected ACL; an existing parent's ACL is never touched
if (-not (Test-Path -LiteralPath $BPARENT)) { [void][IO.Directory]::CreateDirectory($BPARENT); Step 'backup parent created (inherited ACL)' }
$ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetAccessRuleProtection($true, $false)
foreach ($who in $SYSTEM, $ADMINS) { $ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $who), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }
[void][IO.Directory]::CreateDirectory($BACKUP, $ds)
Copy-Item -LiteralPath $CFG -Destination (Join-Path $BACKUP 'sshd_config.orig')
if ((Sha (Join-Path $BACKUP 'sshd_config.orig')) -ne [string]$P.expectConfigSha) { Done 'refused: backup copy is not the pinned config (nothing else changed)' }
Step 'backup' $BACKUP
$text = [IO.File]::ReadAllText($CFG)
$new = $text.TrimEnd("`r", "`n") + "`r`n`r`n" + $BLOCK + "`r`n"
if ((ShaText $new) -ne [string]$P.appliedConfigSha) { Done ('refused: the candidate is not the reviewed bytes (' + (ShaText $new) + ')') }
$tmp = $CFG + '.new-' + $P.runId
[IO.File]::WriteAllText($tmp, $new, (New-Object Text.UTF8Encoding $false))
$t = TestConfig $tmp
if (-not $t.ok) { Remove-Item -LiteralPath $tmp -Force; Done ('refused: candidate fails sshd -t: ' + $t.out) }
Step 'candidate-validated'
$sid = AcctCreate
$state.createdSid = $sid; SaveState $state                      # recorded BEFORE anything else
if (IsAdmin $sid) { Remove-Item -LiteralPath $tmp -Force; $rb = Rollback 'the new user is an administrator'; Done ('refused: the new user is an administrator; ' + (RollbackDecision $rb)) }
Step 'user-created' $sid
[IO.File]::WriteAllText($KEYS, ('restrict,port-forwarding,permitlisten="127.0.0.1:31053",command="cmd.exe /c exit 1" ' + [string]$P.publicKey + "`r`n"), (New-Object Text.UTF8Encoding $false))
$state.keysWritten = (Sha $KEYS); SaveState $state
if (-not $SBX) { KeysAcl $KEYS }
if ($state.keysWritten -ne [string]$P.keysSha) { Remove-Item -LiteralPath $tmp -Force; $rb = Rollback 'keys file is not the reviewed bytes'; Done ('refused: keys bytes; ' + (RollbackDecision $rb)) }
Step 'keys-written' $state.keysWritten
ReplaceFile $tmp
$state.configWritten = (Sha $CFG); SaveState $state
Step 'config-replaced' $state.configWritten
$h = RestartHealthy
$live = TestConfig $CFG
Step 'sshd-restarted' @{ healthy = $h; configTest = $live.ok }
if (-not $h -or -not $live.ok) { $rb = Rollback 'sshd unhealthy after restart'; $R.facts = Facts; Done ('apply-failed: ' + (RollbackDecision $rb)) }
$R.facts = Facts
Done 'applied: waiting for the controller confirm (the guard rolls back otherwise)'
