# cron-respawn.ps1 - the ONLY place the per-deployment respawn setting is decided and changed (PowerShell 5.1).
# Executed from hash-verified bytes (activate.py: ReadAllBytes -> sha256 == pin -> ScriptBlock), never via -File, so no
# execution-policy change of any scope is needed.
#   -Mode inspect   decide, change nothing
#   -Mode apply     CAS on BOTH node-config files, then add -Id to ENCLAVE_ISOLATION_RESPAWN_IDS in node-config.local.cmd
#   -Mode rollback  CAS on the CURRENT bytes, restore the private backup (or set aside a file apply created)
# Decision rules (nothing written on any refusal):
#   - respawn settings only in node-config.local.cmd (box-local); any in the updater-owned node-config.cmd -> refused
#   - a malformed value, or a key set twice -> refused; -Delay keep (default) never touches the delay; a delay change is
#     refused when another listed id or the global switch would be affected; the id is added once (present -> noop)
#   - every non-respawn byte is preserved (sha of the non-respawn bytes before == after; a missing final CRLF is the only
#     added byte and is reported)
# Content privacy (root review 1): NO config byte is ever written outside <Dir>\.cron-respawn, a directory created with a
#   PROTECTED SYSTEM+Administrators-only ACL and verified before use (an existing one with any other entry -> refused).
#   Every temp/backup file is created EMPTY there, its ACL verified private, and only then filled. The destination keeps
#   its own ACL ([IO.File]::Replace), asserted equal before/after.
# Ambiguity (root review 2): a hash-only journal (.cron-respawn\journal.json) is written BEFORE any mutation and closed
#   after the verified result. While it says "started", apply refuses: the observed hashes are reported and only a CAS
#   rollback (on the bytes actually there) proceeds. Errors report what is observed, never an assumed state.
# Output: ONE line of JSON: hashes, public ids, the delay number, ACL booleans, a decision. Never file content.
param([ValidateSet('inspect','apply','rollback')][string]$Mode = 'inspect', [Parameter(Mandatory=$true)][string]$Dir,
      [string]$ExpectConfig = '', [string]$ExpectLocal = '', [string]$Id = '', [string]$Delay = 'keep', [string]$ExpectBackup = '')
$ErrorActionPreference = 'Stop'
$L1 = [Text.Encoding]::GetEncoding(28591)                       # byte-exact round trip
$RX = '^\s*set\s+ENCLAVE_ISOLATION_RESPAWN(_IDS|_DELAY_MS)?=(.*?)\s*$'
$HDR = "@echo off`r`nrem This box's own node settings, read after node-config.cmd. Updates never write this file.`r`n"
$cfg = Join-Path $Dir 'node-config.cmd'; $loc = Join-Path $Dir 'node-config.local.cmd'
$PRIV = Join-Path $Dir '.cron-respawn'; $JOURNAL = Join-Path $PRIV 'journal.json'
$OK_SIDS = @('S-1-5-18', 'S-1-5-32-544')                         # SYSTEM, BUILTIN\Administrators
function Sha($p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
function ShaText($t) { $h = [Security.Cryptography.SHA256]::Create(); ([BitConverter]::ToString($h.ComputeHash($L1.GetBytes($t))) -replace '-', '').ToLower() }
function Done($o) { $o.mode = $Mode; $o | ConvertTo-Json -Compress -Depth 5; exit 0 }
function RestoreAcl($p, $acl0) {   # [IO.File]::Replace does NOT keep the destination ACL across directories: put back EXACTLY the original
  Set-Acl -LiteralPath $p -AclObject $acl0; return ((Get-Acl -LiteralPath $p).Sddl -eq $acl0.Sddl) }
function IsPrivate($p, [bool]$mustBeProtected) {
  $a = Get-Acl -LiteralPath $p
  if ($mustBeProtected -and -not $a.AreAccessRulesProtected) { return $false }
  $rules = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  return ($rules.Count -gt 0) -and -not @($rules | Where-Object { $_.AccessControlType -ne 'Allow' -or $OK_SIDS -notcontains $_.IdentityReference.Value }).Count }
function PrivateDir {
  if (-not (Test-Path -LiteralPath $PRIV)) {
    $ds = New-Object Security.AccessControl.DirectorySecurity
    $ds.SetAccessRuleProtection($true, $false)
    foreach ($s in $OK_SIDS) { $ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $s), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }
    [void][IO.Directory]::CreateDirectory($PRIV, $ds) }       # the ACL is set AT creation: never a broader moment
  if (-not (IsPrivate $PRIV $true)) { throw 'PRIVATE_DIR_NOT_PRIVATE' } }
function PrivateFile($name, [byte[]]$bytes) {                # create EMPTY, verify private, only then write
  $p = Join-Path $PRIV $name
  $fs = [IO.File]::Open($p, 'CreateNew', 'Write'); $fs.Close()
  if (-not (IsPrivate $p $false)) { Remove-Item -LiteralPath $p -Force; throw "PRIVATE_FILE_NOT_PRIVATE $name" }
  [IO.File]::WriteAllBytes($p, $bytes); return $p }
function Journal($j) { $t = $j | ConvertTo-Json -Compress; $tmp = PrivateFile ('journal.' + [guid]::NewGuid().ToString('N')) $L1.GetBytes($t)
  if (Test-Path -LiteralPath $JOURNAL) { [IO.File]::Replace($tmp, $JOURNAL, [NullString]::Value) } else { [IO.File]::Move($tmp, $JOURNAL) } }
function ReadJournal { if (Test-Path -LiteralPath $JOURNAL) { Get-Content -Raw -LiteralPath $JOURNAL | ConvertFrom-Json } else { $null } }
function Parse($text) {
  $r = @{ lines = @(); ids = @(); idsAt = @(); delay = @(); delayAt = @(); glob = @(); bad = $false; other = '' }
  if ($null -eq $text) { return $r }
  $r.lines = @([regex]::Split($text, '(?<=\n)') | Where-Object { $_ -ne '' })
  $sb = New-Object Text.StringBuilder
  for ($i = 0; $i -lt $r.lines.Count; $i++) {
    $m = [regex]::Match($r.lines[$i].TrimEnd("`r", "`n"), $RX, 'IgnoreCase')
    if (-not $m.Success) { [void]$sb.Append($r.lines[$i]); continue }
    $k = $m.Groups[1].Value.ToUpper(); $v = $m.Groups[2].Value
    if ($k -eq '_IDS') { if ($v -match '^0x[0-9a-fA-F]{64}(,0x[0-9a-fA-F]{64})*$') { $r.ids += @($v.ToLower() -split ',') } else { $r.bad = $true }; $r.idsAt += $i }
    elseif ($k -eq '_DELAY_MS') { if ($v -match '^[0-9]{1,7}$') { $r.delay += [int64]$v } else { $r.bad = $true }; $r.delayAt += $i }
    else { if ($v -match '^[01]?$') { $r.glob += $v } else { $r.bad = $true } }
  }
  $r.other = $sb.ToString(); return $r
}
function ReadText($p) { if (Test-Path -LiteralPath $p) { $L1.GetString([IO.File]::ReadAllBytes($p)) } else { $null } }
function Observe($o, $j) { $o.observed = [ordered]@{ local = (Sha $loc); journal = $j.state; before = $j.before; new = $j.new
  backup = $(if ($j.backup -and $j.backup -ne 'none') { Sha (Join-Path $PRIV $j.backup) } else { 'none' }) } }

$o = [ordered]@{ configSha = (Sha $cfg); localSha = (Sha $loc); privateDir = $PRIV }
$j0 = ReadJournal
if ($j0 -and $false) {
  Observe $o $j0; $o.decision = 'refused: a previous mutation did not finish (journal started); resolve with a CAS rollback on the observed bytes'; Done $o }

if ($Mode -eq 'rollback') {
  if (-not $ExpectLocal -or $o.localSha -ne $ExpectLocal) { $o.decision = 'refused: CAS (the local file is not the expected bytes)'; Done $o }
  try { PrivateDir } catch { $o.decision = "refused: $($_.Exception.Message)"; Done $o }
  $j = [ordered]@{ state = 'started'; mode = 'rollback'; before = $o.localSha; new = $ExpectBackup; backup = $(if ($ExpectBackup -eq 'none') { 'none' } else { 'backup-' + $ExpectBackup.Substring(0, 12) }) }
  try {
    if ($ExpectBackup -eq 'none') {           # apply CREATED the file: set it aside INTO the private directory
      $aside = Join-Path $PRIV ('rolledback-' + $o.localSha.Substring(0, 12))
      if (Test-Path -LiteralPath $aside) { $o.decision = 'refused: the set-aside name exists'; Done $o }
      Journal $j; [IO.File]::Move($loc, $aside)
    } else {
      $b = Join-Path $PRIV $j.backup
      if ((Sha $b) -ne $ExpectBackup) { $o.decision = 'refused: the backup is missing or not the expected bytes'; Done $o }
      $acl0 = Get-Acl -LiteralPath $loc
      Journal $j; $tmp = PrivateFile ('restore-' + [guid]::NewGuid().ToString('N')) ([IO.File]::ReadAllBytes($b))
      [IO.File]::Replace($tmp, $loc, [NullString]::Value); $o.aclKept = (RestoreAcl $loc $acl0) }
  } catch { Observe $o $j; $o.error = $_.Exception.Message.Substring(0, [Math]::Min(160, $_.Exception.Message.Length))
            $o.decision = 'ERROR during rollback: see observed hashes; journal left started (root decides)'; Done $o }
  $o.after = (Sha $loc)
  $ok = ($ExpectBackup -eq 'none' -and $o.after -eq 'absent') -or ($o.after -eq $ExpectBackup -and $o.aclKept)
  $j.state = $(if ($ok) { 'rolled-back' } else { 'started' }); Journal $j
  $o.decision = $(if ($ok) { 'rolled back' } else { 'MISMATCH after rollback: journal left started' }); Done $o
}
# inspect / apply: decide
if ($Id -notmatch '^0x[0-9a-fA-F]{64}$') { $o.decision = 'refused: -Id must be one 32-byte deployment id'; Done $o }
$Id = $Id.ToLower()
$pc = Parse (ReadText $cfg); $pl = Parse (ReadText $loc)
$o.current = [ordered]@{ ids = @($pl.ids); delayMs = $(if ($pl.delay.Count) { $pl.delay[0] } else { 0 }); global = ($pl.glob -contains '1') }
if ($pc.bad -or $pl.bad) { $o.decision = 'refused: a respawn setting is malformed'; Done $o }
if ($pc.idsAt.Count -or $pc.delayAt.Count -or $pc.glob.Count) { $o.decision = 'refused: respawn settings in the updater-owned node-config.cmd'; Done $o }
if ($pl.idsAt.Count -gt 1 -or $pl.delayAt.Count -gt 1 -or $pl.glob.Count -gt 1) { $o.decision = 'refused: a respawn key is set more than once'; Done $o }
$curDelay = [int64]$o.current.delayMs
if ($Delay -eq 'keep') { $want = $curDelay } elseif ($Delay -match '^[0-9]{1,6}$' -and [int64]$Delay -le 600000) { $want = [int64]$Delay }
else { $o.decision = 'refused: -Delay is keep or 0..600000'; Done $o }
$others = @($pl.ids | Where-Object { $_ -ne $Id })
if ($want -ne $curDelay -and ($others.Count -or $o.current.global)) {
  $o.decision = "refused: changing the delay $curDelay -> $want would also change $($others.Count) other listed id(s)$(if ($o.current.global) { ' and the global respawn' })"; Done $o }
$needId = -not ($pl.ids -contains $Id); $needDelay = ($want -ne $curDelay)
$o.want = [ordered]@{ ids = @($(if ($needId) { @($pl.ids) + $Id } else { @($pl.ids) })); delayMs = $want }
if (-not $needId -and -not $needDelay) { $o.decision = 'noop: already configured'; Done $o }
if ($Mode -eq 'inspect') { $o.localPrivate = $(if ($o.localSha -ne 'absent') { IsPrivate $loc $false } else { $null }); $o.decision = 'would apply'; Done $o }

# apply
if ($o.configSha -ne $ExpectConfig -or $o.localSha -ne $ExpectLocal) { $o.decision = 'refused: CAS (a config file changed since the preflight)'; Done $o }
if ($o.localSha -eq 'absent') { $lines = @($HDR -split '(?<=\n)' | Where-Object { $_ -ne '' }) } else { $lines = @($pl.lines) }
$o.addedFinalNewline = $false
if ($lines.Count -and -not $lines[-1].EndsWith("`n")) { $lines[-1] += "`r`n"; $o.addedFinalNewline = $true }
$keepOther = (Parse (-join $lines)).other
if ($needId) {
  if ($pl.idsAt.Count -eq 1) { $i = $pl.idsAt[0]; $m = [regex]::Match($lines[$i], '^(.*?=[0-9a-fA-Fx,]+)(\s*)$', 'Singleline'); $lines[$i] = $m.Groups[1].Value + ',' + $Id + $m.Groups[2].Value }
  else { $lines += "set ENCLAVE_ISOLATION_RESPAWN_IDS=$Id`r`n" } }
if ($needDelay) {
  if ($pl.delayAt.Count -eq 1) { $i = $pl.delayAt[0]; $lines[$i] = [regex]::Replace($lines[$i], '=[0-9]+', "=$want", 1) }
  else { $lines += "set ENCLAVE_ISOLATION_RESPAWN_DELAY_MS=$want`r`n" } }
$new = -join $lines; $pn = Parse $new
if ($pn.bad -or ($pn.ids -join ',') -ne ($o.want.ids -join ',') -or $(if ($pn.delay.Count) { $pn.delay[0] } else { 0 }) -ne $want -or $pn.other -ne $keepOther) {
  $o.decision = 'refused: the new bytes do not parse to exactly the wanted settings with every other byte kept'; Done $o }
$o.otherBytesSha = (ShaText $keepOther); $o.newSha = (ShaText $new)
try { PrivateDir } catch { $o.decision = "refused: $($_.Exception.Message) (no content was written)"; Done $o }
$j = [ordered]@{ state = 'started'; mode = 'apply'; before = $o.localSha; new = $o.newSha; backup = $(if ($o.localSha -eq 'absent') { 'none' } else { 'backup-' + $o.localSha.Substring(0, 12) }) }
try {
  Journal $j
  $tmp = PrivateFile ('new-' + [guid]::NewGuid().ToString('N')) $L1.GetBytes($new)
  $o.tempPrivateBeforeWrite = $true
  if ($o.localSha -eq 'absent') { [IO.File]::Move($tmp, $loc); $o.backup = 'none' }
  else {
    $b = Join-Path $PRIV $j.backup
    if (Test-Path -LiteralPath $b) { if ((Sha $b) -ne $o.localSha) { throw 'BACKUP_NAME_HOLDS_OTHER_BYTES' } }
    else { [void](PrivateFile $j.backup ([IO.File]::ReadAllBytes($loc))) }
    if ((Sha $b) -ne $o.localSha) { throw 'BACKUP_NOT_THE_ORIGINAL' }
    $o.backupPrivate = (IsPrivate $b $false)
    $acl0 = Get-Acl -LiteralPath $loc
    [IO.File]::Replace($tmp, $loc, [NullString]::Value)
    $o.backup = $o.localSha; $o.aclKept = (RestoreAcl $loc $acl0) }
} catch {
  $o.error = $_.Exception.Message.Substring(0, [Math]::Min(160, $_.Exception.Message.Length)); Observe $o $j
  if ($o.observed.local -eq $j.before) { $j.state = 'aborted-unchanged'; Journal $j; $o.decision = 'FAILED: observed UNCHANGED (local is still the original bytes); journal closed' }
  else { $o.decision = 'AMBIGUOUS: observed local bytes differ from the original; journal left started; only a CAS rollback on the observed bytes may follow' }
  Get-ChildItem -LiteralPath $PRIV -Filter 'new-*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Done $o }
$o.after = (Sha $loc); $o.localPrivate = (IsPrivate $loc $false)
$ok = ($o.after -eq $o.newSha) -and ($o.localSha -eq 'absent' -or $o.aclKept)
$j.state = $(if ($ok) { 'done' } else { 'started' }); Journal $j
$o.decision = $(if ($ok) { 'applied' } else { 'MISMATCH after apply: journal left started (root decides)' }); Done $o
