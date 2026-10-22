# PREPARED FOR ROOT REVIEW (not run by Claude). Windows PowerShell 5.1, elevated, on the Windows HV node.
# Adds SHIELDED_BRIDGE_MAX_CONNS=96 to C:\ProgramData\Enclave\shield-config.cmd by compare-and-swap, or puts the file back.
# It changes ONE file and restarts NOTHING. The value reaches a bridge only when \Enclave\Shield's run-shield.cmd starts
# fresh (it runs `call shield-config.cmd` once, before its restart loop) and the manager then starts that bridge.
#   -Mode Plan      read-only: current sha256, newline style, checks, and the exact sha256 the result would have
#   -Mode Apply     -ExpectSha256 <current, from Plan> -ExpectNewSha256 <result, from Plan>: backup, temp + Replace, verify
#   -Mode Rollback  -ExpectSha256 <applied file's sha> -Backup <backup path from Apply> -ExpectNewSha256 <original sha>
# Exit: 0 done (or Plan printed); 1 refused, nothing written; 3 written but verification failed (inspect; backup kept).
param(
  [ValidateSet('Plan', 'Apply', 'Rollback')][string]$Mode = 'Plan',
  [string]$ExpectSha256 = '',
  [string]$ExpectNewSha256 = '',
  [string]$Backup = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$CfgFile = Join-Path $env:ProgramData 'Enclave\shield-config.cmd'
$Anchor = 'set ENCLAVE_EGRESS_BRIDGE_EXE_SHA256='
$Insert = @(
  'rem every shielded-bridge the manager starts (egress 9443, GPU 19595, package 9446, custody 9445) gets 96 slots, the',
  "rem same as shield-egress's per-guest MaxConcurrent: streams a guest already closed but the bridge still holds (up to",
  'rem 120 s, HALF_CLOSED_IDLE) no longer refuse its live ones below the guest''s own 64-connection front (2026-10-21)',
  'set SHIELDED_BRIDGE_MAX_CONNS=96')
$Out = [ordered]@{ mode = $Mode; file = $CfgFile; restarted = 'nothing' }
function Emit([int]$code) { $Out.exit = $code; Write-Output ('RESULT ' + ($Out | ConvertTo-Json -Compress)); exit $code }
function Refuse([string]$why) { $Out.error = $why; Emit 1 }
function ShaBytes([byte[]]$b) { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) }
function ShaFile([string]$f) { (Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLowerInvariant() }
function ReplaceWith([byte[]]$bytes, [string]$want) {
  # a temp beside the target, verified, then [IO.File]::Replace (same directory: the target keeps its ACL)
  $tmp = $CfgFile + '.bridgecap-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  $fs = [IO.File]::Open($tmp, 'CreateNew', 'Write', 'None'); try { $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true) } finally { $fs.Close() }
  if ((ShaFile $tmp) -ne $want) { Remove-Item -LiteralPath $tmp -Force; Refuse 'the temp copy is not the planned bytes' }
  $acl0 = (Get-Acl -LiteralPath $CfgFile).Sddl
  [IO.File]::Replace($tmp, $CfgFile, [NullString]::Value)
  $Out.after = ShaFile $CfgFile
  $Out.aclKept = ((Get-Acl -LiteralPath $CfgFile).Sddl -eq $acl0)
  if ($Out.after -ne $want -or -not $Out.aclKept) { $Out.error = 'written, but the file or its ACL is not what was planned'; Emit 3 }
}

if (-not (Test-Path -LiteralPath $CfgFile -PathType Leaf)) { Refuse 'shield-config.cmd is missing' }
$raw = [IO.File]::ReadAllBytes($CfgFile)
$Out.current = ShaBytes $raw
if (@($raw | Where-Object { $_ -gt 127 }).Count) { Refuse 'shield-config.cmd is not plain ASCII' }
$text = [Text.Encoding]::ASCII.GetString($raw)

if ($Mode -eq 'Rollback') {
  if ($Out.current -ne $ExpectSha256.ToLowerInvariant()) { Refuse 'the file is not the applied version named by -ExpectSha256' }
  if (-not $Backup -or -not (Test-Path -LiteralPath $Backup -PathType Leaf)) { Refuse '-Backup must name the backup Apply wrote' }
  $Out.backup = $Backup
  if ((ShaFile $Backup) -ne $ExpectNewSha256.ToLowerInvariant()) { Refuse 'the backup is not the original named by -ExpectNewSha256' }
  ReplaceWith ([IO.File]::ReadAllBytes($Backup)) $ExpectNewSha256.ToLowerInvariant()
  Emit 0
}

$nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
$Out.newline = if ($nl -eq "`r`n") { 'CRLF' } else { 'LF' }
$lines = $text -split "`r?`n", -1
$hits = @(for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].StartsWith($Anchor)) { $i } })
if ($hits.Count -ne 1) { Refuse "expected exactly one '$Anchor' line, found $($hits.Count)" }
if (@($lines | Where-Object { $_ -match '(?i)^\s*set\s+"?SHIELDED_BRIDGE_MAX_CONNS' }).Count) { Refuse 'SHIELDED_BRIDGE_MAX_CONNS is already set: nothing to add' }
$at = $hits[0]
if ($at -ge $lines.Count - 1) { Refuse 'the anchor is the last line: not the installer layout' }   # a reversed range below otherwise
$new = @($lines[0..$at]) + $Insert + @($lines[($at + 1)..($lines.Count - 1)])
$newBytes = [Text.Encoding]::ASCII.GetBytes(($new -join $nl))
$Out.planned = ShaBytes $newBytes
$Out.insertedAfterLine = $at + 1
if ($Mode -eq 'Plan') { Emit 0 }

# Apply
if ($Out.current -ne $ExpectSha256.ToLowerInvariant()) { Refuse 'the file changed since the Plan (-ExpectSha256)' }
if ($Out.planned -ne $ExpectNewSha256.ToLowerInvariant()) { Refuse 'the result would differ from the Plan (-ExpectNewSha256)' }
$Backup = $CfgFile + '.pre-bridgecap-' + $Out.current.Substring(0, 12)
if (Test-Path -LiteralPath $Backup) { if ((ShaFile $Backup) -ne $Out.current) { Refuse 'a backup with other bytes already exists' } }
else { [IO.File]::Copy($CfgFile, $Backup, $false); if ((ShaFile $Backup) -ne $Out.current) { Refuse 'the backup copy is not the current file' } }
$Out.backup = $Backup
ReplaceWith $newBytes $Out.planned
Emit 0
