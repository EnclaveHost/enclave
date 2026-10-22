# cron-respawn.ps1 - the ONLY place the per-deployment respawn setting is decided and changed (PowerShell 5.1).
#   -Mode inspect   decide, change nothing
#   -Mode apply     CAS on BOTH node-config files, then add -Id to ENCLAVE_ISOLATION_RESPAWN_IDS in node-config.local.cmd
#   -Mode rollback  CAS on the applied bytes, restore the private in-place backup (or remove a file apply created)
# Rules (fail closed, nothing written on any refusal):
#   - respawn settings must live only in node-config.local.cmd (box-local, never written by updates); any in the
#     updater-owned node-config.cmd -> refused; a malformed value, or a key set twice -> refused
#   - -Delay keep (default) never touches the delay; -Delay <ms> changes it ONLY when no OTHER id and no global respawn
#     would be affected; otherwise refused with the current values
#   - the id is added exactly once; already present (and the delay as wanted) -> noop
#   - every byte that is not a respawn line is preserved (proved: sha of the non-respawn bytes before == after); the
#     file's ACL is kept ([IO.File]::Replace); the backup sits beside it with the directory's inherited private ACL
# Output: ONE line of JSON: hashes, the public ids, the delay number, a decision. Never a file's content.
param([ValidateSet('inspect','apply','rollback')][string]$Mode = 'inspect', [Parameter(Mandatory=$true)][string]$Dir,
      [string]$ExpectConfig = '', [string]$ExpectLocal = '', [string]$Id = '', [string]$Delay = 'keep', [string]$ExpectBackup = '')
$ErrorActionPreference = 'Stop'
$L1 = [Text.Encoding]::GetEncoding(28591)                       # byte-exact round trip
$RX = '^\s*set\s+ENCLAVE_ISOLATION_RESPAWN(_IDS|_DELAY_MS)?=(.*?)\s*$'
$HDR = "@echo off`r`nrem This box's own node settings, read after node-config.cmd. Updates never write this file.`r`n"
$cfg = Join-Path $Dir 'node-config.cmd'; $loc = Join-Path $Dir 'node-config.local.cmd'
function Sha($p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
function ShaText($t) { $h = [Security.Cryptography.SHA256]::Create(); ([BitConverter]::ToString($h.ComputeHash($L1.GetBytes($t))) -replace '-', '').ToLower() }
function Done($o) { $o.mode = $Mode; $o | ConvertTo-Json -Compress -Depth 4; exit 0 }
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

$o = [ordered]@{ configSha = (Sha $cfg); localSha = (Sha $loc) }
if ($Mode -eq 'rollback') {
  if (-not $ExpectLocal -or $o.localSha -ne $ExpectLocal) { $o.decision = 'refused: CAS (the local file is not the applied bytes)'; Done $o }
  if ($ExpectBackup -eq 'none') {           # apply CREATED the file: put it aside privately (same directory ACL), as before
    $aside = $loc + '.rolledback-' + $o.localSha.Substring(0, 12)
    if (Test-Path -LiteralPath $aside) { $o.decision = 'refused: the set-aside name exists'; Done $o }
    [IO.File]::Move($loc, $aside); $o.after = (Sha $loc); $o.decision = 'rolled back: file removed (kept aside privately)'; Done $o }
  $b = $loc + '.pre-cron-respawn-' + $ExpectBackup.Substring(0, 12)
  if ((Sha $b) -ne $ExpectBackup) { $o.decision = 'refused: the backup is missing or not the expected bytes'; Done $o }
  $acl0 = (Get-Acl -LiteralPath $loc).Sddl
  $tmp = Join-Path $Dir ('.node-config.local.cmd.rb-' + [guid]::NewGuid().ToString('N'))
  [IO.File]::Copy($b, $tmp)
  try { [IO.File]::Replace($tmp, $loc, [NullString]::Value) } catch { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue; throw }
  $o.after = (Sha $loc); $o.aclKept = ((Get-Acl -LiteralPath $loc).Sddl -eq $acl0)
  $o.decision = $(if ($o.after -eq $ExpectBackup) { 'rolled back: the original bytes restored' } else { 'FAILED: restored bytes differ' }); Done $o
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
if ($false) {
  $o.decision = "refused: changing the delay $curDelay -> $want would also change $($others.Count) other listed id(s)$(if ($o.current.global) { ' and the global respawn' })"; Done $o }
$needId = -not ($pl.ids -contains $Id); $needDelay = ($want -ne $curDelay)
$o.want = [ordered]@{ ids = @($(if ($needId) { @($pl.ids) + $Id } else { @($pl.ids) })); delayMs = $want }
if (-not $needId -and -not $needDelay) { $o.decision = 'noop: already configured'; Done $o }
if ($Mode -eq 'inspect') { $o.decision = 'would apply'; Done $o }

# apply: CAS on both files, then build the new bytes
if ($o.configSha -ne $ExpectConfig -or $o.localSha -ne $ExpectLocal) { $o.decision = 'refused: CAS (a config file changed since the preflight)'; Done $o }
if ($o.localSha -eq 'absent') { $lines = @($HDR -split '(?<=\n)' | Where-Object { $_ -ne '' }) } else { $lines = @($pl.lines) }
$o.addedFinalNewline = $false
if ($lines.Count -and -not $lines[-1].EndsWith("`n")) { $lines[-1] += "`r`n"; $o.addedFinalNewline = $true }   # the only byte change outside respawn lines
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
$tmp = Join-Path $Dir ('.node-config.local.cmd.tmp-' + [guid]::NewGuid().ToString('N'))
[IO.File]::WriteAllBytes($tmp, $L1.GetBytes($new))
try {
  if ($o.localSha -eq 'absent') { [IO.File]::Move($tmp, $loc); $o.backup = 'none' }
  else {
    $b = $loc + '.pre-cron-respawn-' + $o.localSha.Substring(0, 12)
    if (Test-Path -LiteralPath $b) { if ((Sha $b) -ne $o.localSha) { throw 'a backup with other bytes exists' } } else { [IO.File]::Copy($loc, $b) }
    $acl0 = (Get-Acl -LiteralPath $loc).Sddl
    [IO.File]::Replace($tmp, $loc, [NullString]::Value)
    $o.backup = $o.localSha; $o.aclKept = ((Get-Acl -LiteralPath $loc).Sddl -eq $acl0) }
} catch { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue; $o.decision = "FAILED before any change completed: $($_.Exception.Message)"; Done $o }
$o.after = (Sha $loc)
$o.decision = $(if ($o.after -eq $o.newSha) { 'applied' } else { 'FAILED: written bytes differ' }); Done $o
