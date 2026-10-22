# bundle-swap.ps1 - CAS replacement of ONE public node artifact (default: the live host-admission.bundle.mjs) by a staged,
# root-pinned file; backup + rollback. Executed from hash-verified bytes (activate.py), no execution-policy change.
# No effect on the running agent until the ONE coordinated node restart (the module is loaded at start).
#   -Mode inspect   CAS view only: target sha vs -OldSha, staged sha vs -NewSha, node --check of the staged bytes
#   -Mode apply     target == -OldSha AND staged == -NewSha (!= old) AND `node --check` passes ON THE EXACT BYTES THAT WILL
#                   BE INSTALLED (a private copy) -> private backup of the old bytes (sha == -OldSha) -> [IO.File]::Replace
#                   (the target keeps its own ACL) -> target == -NewSha
#   -Mode rollback  target == -ExpectCurrent (normally -NewSha) -> the private backup (sha == -OldSha) restored the same way
# Private work directory (protected SYSTEM+Administrators, verified before any byte is written), a hash-only journal
# (apply refuses while a previous mutation is "started"), observed-state errors: as cron-respawn.ps1.
param([ValidateSet('inspect','apply','rollback')][string]$Mode = 'inspect',
      [string]$Target = 'C:\Program Files\Enclave\control\windows\node\host-admission.bundle.mjs',
      [Parameter(Mandatory=$true)][string]$WorkDir, [string]$OldSha = '', [string]$NewFile = '', [string]$NewSha = '',
      [string]$ExpectCurrent = '', [string]$Node = 'C:\Program Files\Enclave\runtime\node\node.exe', [int]$MaxBytes = 8388608)
$ErrorActionPreference = 'Stop'
$PRIV = Join-Path $WorkDir '.bundle-swap'; $JOURNAL = Join-Path $PRIV 'journal.json'; $OK_SIDS = @('S-1-5-18', 'S-1-5-32-544')
function Sha($p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
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
    $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetAccessRuleProtection($true, $false)
    foreach ($s in $OK_SIDS) { $ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $s), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }
    [void][IO.Directory]::CreateDirectory($PRIV, $ds) }
  if (-not (IsPrivate $PRIV $true)) { throw 'PRIVATE_DIR_NOT_PRIVATE' } }
function PrivateFile($name, [byte[]]$bytes) {
  $p = Join-Path $PRIV $name; $fs = [IO.File]::Open($p, 'CreateNew', 'Write'); $fs.Close()
  if (-not (IsPrivate $p $false)) { Remove-Item -LiteralPath $p -Force; throw "PRIVATE_FILE_NOT_PRIVATE $name" }
  [IO.File]::WriteAllBytes($p, $bytes); return $p }
function Journal($j) { $tmp = PrivateFile ('journal.' + [guid]::NewGuid().ToString('N')) ([Text.Encoding]::ASCII.GetBytes(($j | ConvertTo-Json -Compress)))
  if (Test-Path -LiteralPath $JOURNAL) { [IO.File]::Replace($tmp, $JOURNAL, [NullString]::Value) } else { [IO.File]::Move($tmp, $JOURNAL) } }
function ReadJournal { if (Test-Path -LiteralPath $JOURNAL) { Get-Content -Raw -LiteralPath $JOURNAL | ConvertFrom-Json } else { $null } }
function Check($p) { $ea = $ErrorActionPreference; $ErrorActionPreference = 'Continue'   # native stderr must not become a terminating error
  try { $null = & $Node --check $p 2>&1; return $LASTEXITCODE } finally { $ErrorActionPreference = $ea } }
function Observe($o, $j) { $o.observed = [ordered]@{ target = (Sha $Target); journal = $j.state; before = $j.before; new = $j.new; backup = (Sha (Join-Path $PRIV $j.backup)) } }

$o = [ordered]@{ targetSha = (Sha $Target); privateDir = $PRIV }
$j0 = ReadJournal
if ($j0 -and $j0.state -eq 'started' -and $Mode -ne 'rollback') { Observe $o $j0; $o.decision = 'refused: a previous mutation did not finish (journal started); resolve with a CAS rollback on the observed bytes'; Done $o }
if ($OldSha -notmatch '^[0-9a-f]{64}$') { $o.decision = 'refused: -OldSha must be a lowercase sha256'; Done $o }
$bk = 'backup-' + $OldSha.Substring(0, 12) + '.mjs'

if ($Mode -eq 'rollback') {
  if (-not $ExpectCurrent -or $o.targetSha -ne $ExpectCurrent) { $o.decision = 'refused: CAS (the target is not the expected bytes)'; Done $o }
  try { PrivateDir } catch { $o.decision = "refused: $($_.Exception.Message)"; Done $o }
  $b = Join-Path $PRIV $bk
  if ((Sha $b) -ne $OldSha) { $o.decision = 'refused: the backup is missing or not -OldSha'; Done $o }
  $j = [ordered]@{ state = 'started'; mode = 'rollback'; before = $o.targetSha; new = $OldSha; backup = $bk }
  try { $acl0 = Get-Acl -LiteralPath $Target; Journal $j
        $tmp = PrivateFile ('restore-' + [guid]::NewGuid().ToString('N') + '.mjs') ([IO.File]::ReadAllBytes($b))
        [IO.File]::Replace($tmp, $Target, [NullString]::Value); $o.aclKept = (RestoreAcl $Target $acl0) }
  catch { Observe $o $j; $o.error = $_.Exception.Message.Substring(0, [Math]::Min(160, $_.Exception.Message.Length)); $o.decision = 'ERROR during rollback: see observed hashes; journal left started'; Done $o }
  $o.after = (Sha $Target); $ok = ($o.after -eq $OldSha -and $o.aclKept)
  $j.state = $(if ($ok) { 'rolled-back' } else { 'started' }); Journal $j
  $o.decision = $(if ($ok) { 'rolled back' } else { 'MISMATCH after rollback: journal left started' }); Done $o }

# inspect / apply
if ($NewSha -notmatch '^[0-9a-f]{64}$' -or $NewSha -eq $OldSha) { $o.decision = 'refused: -NewSha must be a lowercase sha256 different from -OldSha'; Done $o }
$o.newFileSha = (Sha $NewFile); $o.casTarget = ($o.targetSha -eq $OldSha); $o.casNew = ($o.newFileSha -eq $NewSha)
if ($o.targetSha -eq $NewSha) { $o.decision = 'noop: the target already is -NewSha'; Done $o }
if (-not $o.casTarget) { $o.decision = 'refused: CAS (the target is not -OldSha)'; Done $o }
if (-not $o.casNew) { $o.decision = 'refused: the staged file is not -NewSha'; Done $o }
if ((Get-Item -LiteralPath $NewFile).Length -gt $MaxBytes) { $o.decision = 'refused: the staged file exceeds -MaxBytes'; Done $o }
try { PrivateDir } catch { $o.decision = "refused: $($_.Exception.Message) (nothing written)"; Done $o }
$tmp = PrivateFile ('new-' + [guid]::NewGuid().ToString('N') + '.mjs') ([IO.File]::ReadAllBytes($NewFile))
if ((Sha $tmp) -ne $NewSha) { Remove-Item -LiteralPath $tmp -Force; $o.decision = 'refused: the private copy is not -NewSha'; Done $o }
$o.nodeCheck = (Check $tmp)
if ($o.nodeCheck -ne 0) { Remove-Item -LiteralPath $tmp -Force; $o.decision = 'refused: node --check failed on the exact bytes'; Done $o }
if ($Mode -eq 'inspect') { Remove-Item -LiteralPath $tmp -Force; $o.decision = 'would apply'; Done $o }
$j = [ordered]@{ state = 'started'; mode = 'apply'; before = $o.targetSha; new = $NewSha; backup = $bk }
try {
  Journal $j
  $b = Join-Path $PRIV $bk
  if (Test-Path -LiteralPath $b) { if ((Sha $b) -ne $OldSha) { throw 'BACKUP_NAME_HOLDS_OTHER_BYTES' } } else { [void](PrivateFile $bk ([IO.File]::ReadAllBytes($Target))) }
  if ((Sha $b) -ne $OldSha) { throw 'BACKUP_NOT_THE_OLD_BYTES' }
  $acl0 = Get-Acl -LiteralPath $Target
  [IO.File]::Replace($tmp, $Target, [NullString]::Value); $o.aclKept = (RestoreAcl $Target $acl0)
} catch {
  $o.error = $_.Exception.Message.Substring(0, [Math]::Min(160, $_.Exception.Message.Length)); Observe $o $j
  if ($o.observed.target -eq $j.before) { $j.state = 'aborted-unchanged'; Journal $j; $o.decision = 'FAILED: observed UNCHANGED (target is still -OldSha); journal closed' }
  else { $o.decision = 'AMBIGUOUS: observed target differs from -OldSha; journal left started; only a CAS rollback may follow' }
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; Done $o }
$o.after = (Sha $Target); $ok = ($o.after -eq $NewSha -and $o.aclKept)
$j.state = $(if ($ok) { 'done' } else { 'started' }); Journal $j
$o.decision = $(if ($ok) { 'applied (no effect until the coordinated node restart)' } else { 'MISMATCH after apply: journal left started' }); Done $o
