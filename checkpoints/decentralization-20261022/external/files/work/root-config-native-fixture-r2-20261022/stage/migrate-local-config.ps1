# migrate-local-config.ps1 -- ROOT ONLY, run natively on the host by an administrator. Prepared by Claude; never run by it on a host.
# Moves the operator's OWN hand-made launcher settings into the update-proof local hooks (ENCLAVE-LOCAL-CONFIG-V1), so an install
# that regenerates the launchers keeps them effective:
#   run-node.cmd   set lines  -> appended to node-config.local.cmd   (node-config.cmd calls it last)
#   run-shield.cmd set lines  -> appended to shield-config.local.cmd (shield-config.cmd calls it last, install-host r6)
#   plus EXPLICIT pinned entries {file, name, valueSha256, hook} for node-config.cmd / shield-config.cmd settings that root's
#   offline value-hash comparison (tools/compare-config.r2.py) classified as customized (live: none).
# PRECEDENCE: the moved lines are APPENDED after everything already in the hook. In the old launcher they ran after node-config.cmd
# and its local hook, so appending keeps exactly that order (a same-name local value is still overridden by the moved one).
# SAFETY: only strict set lines are copied, never other batch text:
#   set NAME=value | set "NAME=value" | if [not] defined NAME <one of those>
#   value without & | < > ^ % ! " or control characters (no command, redirection or expansion can ride along);
#   any other line form, or a hook containing anything but blank/@echo off/rem/:: comments/set lines/call "x"/if exist "x" call "x"
#   (control flow could skip the appended block), REFUSES the whole migration.
# FILESYSTEM (r2): private-at-creation, exclusive, same-directory replace, new backup directory, no links on any ancestor.
# Every source and hook is CAS-pinned (sha256, "absent" for a hook to be created) and every moved line by (name, value sha256)
# exactly as root's reader (config-names-read.py 018f9b93) hashes it. Nothing prints a value: names, forms, line numbers and
# hashes only.
#   -Mode plan                     (default) read only; prints the plan and its planSha
#   -Mode execute -PlanSha <sha>   only if the recomputed plan is byte-identical; atomic replace, protected backup, after-hash check
param([string]$Root = "C:\ProgramData\Enclave", [Parameter(Mandatory)][string]$Pins, [ValidateSet("plan", "execute")][string]$Mode = "plan", [string]$PlanSha = "")
$ErrorActionPreference = "Stop"

$script:RootSet = '(?i)^\s*(?:if [^\r\n]*?\s)?set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$'   # root's reader, quotes preserved
$script:Plain = '^\s*set\s+([A-Za-z_][A-Za-z0-9_]*)=([^"]*)$'
$script:Quoted = '^\s*set\s+"([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"\s*$'
$script:Cond = '(?i)^\s*if\s+(?:not\s+)?defined\s+[A-Za-z_][A-Za-z0-9_]*\s+(set\s.*)$'
$script:Unsafe = '[&|<>^%!"]|[^\x20-\x7e]'                 # also: ASCII only (hooks are ASCII; nothing is re-encoded)
function Sha([byte[]]$b) { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($b) | ForEach-Object { $_.ToString("x2") }) }
function TS([string]$t) { Sha ([Text.Encoding]::UTF8.GetBytes($t)) }
# never read through a link (a dangling one included: File.Exists is true for it): the path check refuses it
function IsLink($p) { $fi = New-Object IO.FileInfo $p; $fi.Refresh(); [int]$fi.Attributes -ne -1 -and ($fi.Attributes -band [IO.FileAttributes]::ReparsePoint) }
function FileSha($p) { if (IsLink $p) { "link" } elseif ([IO.File]::Exists($p)) { Sha ([IO.File]::ReadAllBytes($p)) } else { "absent" } }
function Lines($p) { if (-not (IsLink $p) -and [IO.File]::Exists($p)) { @([IO.File]::ReadAllLines($p)) } else { @() } }

# one set line -> @{ name; form; text; valueSha256 } or @{ refused }; the value never leaves this function except as a hash
function Read-SetLine([string]$l) {
  $root = [regex]::Match($l, $script:RootSet)
  if (-not $root.Success) { return $null }
  $name = $root.Groups[1].Value.ToUpperInvariant(); $vh = TS $root.Groups[2].Value
  $body = $l; $form = "plain"
  $c = [regex]::Match($l, $script:Cond)
  if ($c.Success) { $body = $c.Groups[1].Value; $form = "conditional" }
  elseif ($l -match '(?i)^\s*if\s') { return @{ name = $name; valueSha256 = $vh; refused = "unsupported conditional form (only: if [not] defined NAME set ...)" } }
  $q = [regex]::Match($body, $script:Quoted); $p = [regex]::Match($body, $script:Plain)
  $m = $(if ($q.Success) { $q } elseif ($p.Success) { $p } else { $null })
  if (-not $m) { return @{ name = $name; valueSha256 = $vh; refused = "not a plain or quoted set line" } }
  if ($form -ne "conditional") { $form = $(if ($q.Success) { "quoted" } else { "plain" }) }
  if ($m.Groups[2].Value -match $script:Unsafe) { return @{ name = $name; valueSha256 = $vh; refused = "value holds a command, redirection, quote or expansion character" } }
  return @{ name = $name; form = $form; text = $l.TrimStart(); valueSha256 = $vh }
}
# a hook may hold only lines that cannot skip what is appended after them
function Test-HookShape($lines) {
  $bad = @(); $i = 0
  foreach ($l in $lines) { $i++; $t = $l.Trim()
    $path = '(?:"[^"&|<>^%!]+"|[^\s"&|<>^%!]+)'
    $ok = ($t -eq "") -or ($t -ieq "@echo off") -or ($t -match '(?i)^(rem(\s|$)|::)') -or [regex]::Match($t, $script:RootSet).Success -or
          ($t -match "(?i)^call\s+$path\s*$") -or ($t -match "(?i)^if\s+exist\s+$path\s+call\s+$path\s*$")
    if (-not $ok) { $bad += @{ line = $i; sha256 = TS $l } } }
  return , $bad
}

function Get-MigrationPlan($root, $pins) {
  $plan = [ordered]@{ format = "enclave-local-config-migration/v1"; root = $root; hooks = [ordered]@{}; sources = [ordered]@{}; refused = @() }
  # nothing is planned through a link or into a directory others may write
  $why = Get-PathProblem $root "dir"; if ($why) { $plan.refused += "root directory unsafe: $why" }
  foreach ($f in "run-node.cmd", "run-shield.cmd", "node-config.cmd", "shield-config.cmd", "node-config.local.cmd", "shield-config.local.cmd") {
    $why = Get-PathProblem (Join-Path $root $f) "file"; if ($why) { $plan.refused += "${f} unsafe: $why" } }
  if (Test-Path -LiteralPath (Join-Path $root "backup")) { $why = Get-PathProblem (Join-Path $root "backup") "dir"; if ($why) { $plan.refused += "backup directory unsafe: $why" } }
  $pairs = @(@("run-node.cmd", "node-config.local.cmd"), @("run-shield.cmd", "shield-config.local.cmd"))
  $append = @{ "node-config.local.cmd" = [Collections.Generic.List[object]]::new(); "shield-config.local.cmd" = [Collections.Generic.List[object]]::new() }
  $hookLines = @{}
  foreach ($h in $append.Keys) { $hookLines[$h] = @(Lines (Join-Path $root $h)) }
  $pinned = { param($f) $want = $pins.files.$f; $have = FileSha (Join-Path $root $f)
    if (-not $want) { $plan.refused += "$f is not pinned (sha256 or absent)" } elseif ($want -ne $have) { $plan.refused += "$f changed since review (pinned $($want.Substring(0, [math]::Min(12, $want.Length))), now $($have.Substring(0, [math]::Min(12, $have.Length))))" }
    $have }
  $isPersisted = { param($hook, $e)
    $sets = @($hookLines[$hook] | ForEach-Object { Read-SetLine $_ } | Where-Object { $_ -and -not $_.refused })
    if ($e.form -eq "conditional") { return @($sets | Where-Object { $_.text -ceq $e.text }).Count -gt 0 }
    $last = @($sets | Where-Object { $_.name -eq $e.name } | Select-Object -Last 1)
    return ($last.Count -eq 1 -and $last[0].text -ceq $e.text) }
  # 1. SET-free launchers: EVERY set line is the operator's
  foreach ($pr in $pairs) {
    $src = $pr[0]; $hook = $pr[1]; $sha = & $pinned $src
    $entries = @(); $i = 0
    foreach ($l in @(Lines (Join-Path $root $src))) { $i++; $e = Read-SetLine $l; if ($null -eq $e) { continue }
      $row = [ordered]@{ line = $i; name = $e.name; valueSha256 = $e.valueSha256 }
      if ($e.refused) { $row.action = "REFUSED: $($e.refused)"; $plan.refused += "${src}:$i $($e.name): $($e.refused)" }
      else { $row.form = $e.form; $row.action = $(if (& $isPersisted $hook $e) { "already-persisted" } else { $append[$hook].Add($e); "append" }) }
      $entries += $row }
    if ($sha -ne "absent" -and $null -eq $pins.sources.$src) { $plan.refused += "$src set lines are not pinned (sources.$src)" }
    $expect = @(@($pins.sources.$src) | Where-Object { $_ } | ForEach-Object { "$(([string]$_.name).ToUpperInvariant())=$($_.valueSha256)" })
    $found = @($entries | ForEach-Object { "$($_.name)=$($_.valueSha256)" })
    if ($sha -ne "absent" -and (($expect -join "|") -ne ($found -join "|"))) { $plan.refused += "$src set lines differ from the pinned (name, value hash) list" }
    $plan.sources[$src] = [ordered]@{ sha256 = $sha; setLines = $entries }
  }
  # 2. explicit pinned entries from generated launchers (offline value-hash review)
  foreach ($x in @($pins.extra)) {
    if (-not $x) { continue }
    $src = [string]$x.file; $hook = [string]$x.hook
    if (@("node-config.cmd", "shield-config.cmd") -notcontains $src -or -not $append.ContainsKey($hook)) { $plan.refused += "extra entry $src -> $hook is not an allowed source/hook pair"; continue }
    $sha = & $pinned $src
    $hits = @(); $i = 0
    foreach ($l in @(Lines (Join-Path $root $src))) { $i++; $e = Read-SetLine $l; if ($e -and $e.name -eq ([string]$x.name).ToUpperInvariant()) { $hits += @{ e = $e; line = $i } } }
    if (-not $hits.Count) { $plan.refused += "$src has no set line for $($x.name)"; continue }
    $e = $hits[-1].e
    if ($e.refused) { $plan.refused += "${src}:$($hits[-1].line) $($e.name): $($e.refused)"; continue }
    if ($e.valueSha256 -ne [string]$x.valueSha256) { $plan.refused += "${src}:$($e.name) value hash differs from the pinned one"; continue }
    $act = $(if (& $isPersisted $hook $e) { "already-persisted" } else { $append[$hook].Add($e); "append" })
    if (-not $plan.sources[$src]) { $plan.sources[$src] = [ordered]@{ sha256 = $sha; setLines = @() } }
    $plan.sources[$src].setLines += [ordered]@{ line = $hits[-1].line; name = $e.name; form = $e.form; valueSha256 = $e.valueSha256; action = $act }
  }
  # 3. the hooks after: old bytes, then one marked block of the exact moved lines, CRLF
  foreach ($h in @("node-config.local.cmd", "shield-config.local.cmd")) {
    $p = Join-Path $root $h; $before = & $pinned $h
    $shape = Test-HookShape $hookLines[$h]
    if ($shape.Count) { $plan.refused += "$h holds $($shape.Count) line(s) that could skip an appended block (lines $(@($shape | ForEach-Object { $_.line }) -join ','))" }
    $old = $(if ($before -eq "link") { [byte[]]@() } elseif ($before -ne "absent") { [IO.File]::ReadAllBytes($p) } else { [Text.Encoding]::ASCII.GetBytes("@echo off`r`nrem This box's own settings, read last by the generated configuration. Updates never write this file.`r`n") })
    $add = $append[$h]
    $content = $old
    if ($add.Count) {
      $sep = $(if ($old.Length -and $old[-1] -ne 10) { "`r`n" } else { "" })
      $block = $sep + "rem --- moved here by root's local-config migration (ENCLAVE-LOCAL-CONFIG-V1): " + (@($add | ForEach-Object { $_.name }) -join " ") + "`r`n" +
               ((@($add | ForEach-Object { $_.text })) -join "`r`n") + "`r`n"
      $content = [byte[]]($old + [Text.Encoding]::ASCII.GetBytes($block))
    }
    $plan.hooks[$h] = [ordered]@{ before = $before; after = $(if ($add.Count) { Sha $content } else { $before }); append = @($add | ForEach-Object { [ordered]@{ name = $_.name; form = $_.form; valueSha256 = $_.valueSha256 } }); create = ($before -eq "absent" -and $add.Count -gt 0) }
    $script:Content[$h] = $content
  }
  return $plan
}
$script:Content = @{}

# ---- filesystem safety (r2) --------------------------------------------------------------------------------------------
# Every file this migration writes is private from its first byte, created EXCLUSIVELY (never over an existing name), beside its
# target (same directory, same volume), and never through a link. A backup directory is always NEW; its parent is reused only if
# it is itself safe. Only the two Windows-ACL primitives below touch security descriptors.
$script:SY = "S-1-5-18"; $script:BA = "S-1-5-32-544"
# a reparse point (symlink, junction, mount point) on the item or ANY ancestor up to the volume root redirects a write: refused
function Get-ReparseProblem([string]$path) {
  $p = [IO.Path]::GetFullPath($path)
  while ($p) {
    # the entry's OWN attributes (a dangling link included): -1 means nothing is there
    $fi = New-Object IO.FileInfo $p; $fi.Refresh(); $at = $fi.Attributes
    if ([int]$at -ne -1 -and ($at -band [IO.FileAttributes]::ReparsePoint)) { return "a reparse point (link, junction or mount point) is on the path ($p)" }
    $parent = [IO.Path]::GetDirectoryName($p)
    if (-not $parent -or $parent -eq $p) { break }
    $p = $parent
  }
  return $null
}
# owner SYSTEM/Administrators and no other principal allowed to write, delete, re-permission or take it: else the reason
function Test-PrivateAcl([string]$path) {
  $acl = Get-Acl -LiteralPath $path; $sid = [Security.Principal.SecurityIdentifier]
  $owner = $acl.GetOwner($sid).Value
  if (@($script:SY, $script:BA) -notcontains $owner) { return "owned by $owner, not SYSTEM or Administrators" }
  $w = [Security.AccessControl.FileSystemRights]"WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership"
  foreach ($r in $acl.GetAccessRules($true, $true, $sid)) {
    if ($r.AccessControlType -eq "Allow" -and @($script:SY, $script:BA) -notcontains $r.IdentityReference.Value -and ($r.FileSystemRights -band $w)) {
      return "$($r.IdentityReference.Value) may modify it" } }
  return $null
}
function Get-PathProblem([string]$path, [string]$kind) {
  $r = Get-ReparseProblem $path; if ($r) { return $r }
  $fi = New-Object IO.FileInfo $path; $fi.Refresh(); if ([int]$fi.Attributes -eq -1) { return $null }
  if ($kind -eq "file" -and -not [IO.File]::Exists($path)) { return "not a regular file" }
  if ($kind -eq "dir" -and -not [IO.Directory]::Exists($path)) { return "not a directory" }
  return Test-PrivateAcl $path
}
# Windows ACL primitive 1: a NEW file (FileMode.CreateNew: fails if the name exists), protected DACL SYSTEM + Administrators and
# the given OWNER (SYSTEM or Administrators only), applied by the same call that creates it (Windows PowerShell 5.1 / .NET
# Framework FileStream overload). If this token may not assign that owner, the create fails and no file exists: no privilege is
# enabled or adjusted to make it succeed.
function Open-NewPrivateFile([string]$path, [string]$ownerSid) {
  if (@($script:SY, $script:BA) -notcontains $ownerSid) { throw "refusing to create a file owned by $ownerSid (only SYSTEM or Administrators)" }
  $sec = New-Object System.Security.AccessControl.FileSecurity
  $sec.SetAccessRuleProtection($true, $false)
  foreach ($s in $script:SY, $script:BA) { $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier $s), "FullControl", "Allow"))) }
  $sec.SetOwner((New-Object System.Security.Principal.SecurityIdentifier $ownerSid))
  New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, $sec)
}
# Windows ACL primitive 2: a directory created WITH its protected descriptor
function New-DirWithPrivateAcl([string]$path) {
  $ds = New-Object System.Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm("O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
  [void][IO.Directory]::CreateDirectory($path, $ds)
}
# the owner SID of a file (Windows ACL read)
function Get-OwnerSid([string]$path) { (Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier]).Value }
# ReplaceFile (r3, root's native finding 2026-10-22): the destination keeps its DACL but takes the REPLACEMENT file's OWNER; the
# backup keeps the original owner. So the replacement is created with the destination's owner and the owner is verified after.
function Invoke-FileReplace([string]$replacement, [string]$destination, [string]$backup) { [IO.File]::Replace($replacement, $destination, $backup) }
function New-ExclusivePrivateFile([string]$path, [byte[]]$bytes, [string]$ownerSid = $script:BA) {
  $f = Open-NewPrivateFile $path $ownerSid                                 # throws, creating nothing, if the name exists or the owner is refused
  $ok = $false
  try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true); $ok = $true } finally { $f.Dispose(); if (-not $ok) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue } }
}
# a NEW private directory: an existing one is never reused (it could carry another principal's ACL or contents)
function New-ExclusivePrivateDir([string]$path) {
  if (Test-Path -LiteralPath $path) { throw "refusing to reuse an existing directory ($path)" }
  New-DirWithPrivateAcl $path
  $why = Get-PathProblem $path "dir"; if ($why) { throw "the new directory is not private: $why" }
}
# the backups' parent: reused only if it is a safe directory, else created new
function Get-BackupParent([string]$root) {
  $b = Join-Path $root "backup"
  if (Test-Path -LiteralPath $b) { $why = Get-PathProblem $b "dir"; if ($why) { throw "backup directory unsafe: $why" }; return $b }
  New-ExclusivePrivateDir $b; return $b
}

function Invoke-Migration($root, $pins, $planSha) {
  $plan = Get-MigrationPlan $root $pins
  $json = $plan | ConvertTo-Json -Depth 8 -Compress; $sha = TS $json
  if ($plan.refused.Count) { return [ordered]@{ result = "REFUSED"; planSha = $sha; refused = $plan.refused } }
  if ($planSha -ne $sha) { return [ordered]@{ result = "REFUSED"; planSha = $sha; refused = @("the recomputed plan is not the reviewed one (-PlanSha)") } }
  $done = [ordered]@{}
  foreach ($h in $plan.hooks.Keys) {
    $hp = $plan.hooks[$h]; if ($hp.after -eq $hp.before) { $done[$h] = "unchanged"; continue }
    $p = Join-Path $root $h; $tmp = $null
    try {
      $why = Get-PathProblem $p "file"; if ($why) { throw "$h unsafe: $why" }
      if ((FileSha $p) -ne $hp.before) { throw "$h changed during the migration" }
      $tag = [guid]::NewGuid().ToString("N")
      if ($hp.create) {
        New-ExclusivePrivateFile $p $script:Content[$h]                  # fails, writing nothing, if the file appeared meanwhile
        $backup = $null
      } else {
        # the replacement carries the hook's OWN owner (validated SYSTEM/Administrators) from creation, before any content: it
        # is created FIRST, so a token that cannot assign that owner fails here with nothing replaced and no backup made
        $owner = Get-OwnerSid $p
        if (@($script:SY, $script:BA) -notcontains $owner) { throw "$h owner $owner is not SYSTEM or Administrators" }
        $tmp = Join-Path $root (".$h.migrate-$tag.tmp")                   # same directory as the hook: an atomic same-volume replace
        try { New-ExclusivePrivateFile $tmp $script:Content[$h] $owner }
        catch { $tmp = $null                                              # never delete what is at that name: it may not be ours
                throw "$h replacement could not be created with the hook's owner $owner (nothing replaced): $($_.Exception.Message)" }
        if ((Get-OwnerSid $tmp) -ne $owner) { throw "$h replacement owner is not the hook's owner $owner (nothing replaced)" }
        $bak = Join-Path (Get-BackupParent $root) ("local-config-migration-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ") + "-" + $tag.Substring(0, 12))
        New-ExclusivePrivateDir $bak
        $backup = Join-Path $bak $h
        # ReplaceFile: the hook keeps its DACL and takes the replacement's owner (= its own); its old bytes and owner go to the backup
        Invoke-FileReplace $tmp $p $backup; $tmp = $null
        if ((FileSha $backup) -ne $hp.before) { throw "$h backup hash differs from the replaced file" }
        $nowOwner = Get-OwnerSid $p
        if ($nowOwner -ne $owner) { throw "$h owner changed by the replace ($owner -> $nowOwner); its original bytes and owner are in $backup" }
      }
      $why = Get-PathProblem $p "file"; if ($why) { throw "$h after the write: $why" }
      $after = FileSha $p
      if ($after -ne $hp.after) { throw "$h after-hash differs from the plan" }
      $done[$h] = [ordered]@{ before = $hp.before; after = $after; backup = $backup }
    } catch {
      if ($tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
      return [ordered]@{ result = "FAILED"; planSha = $sha; error = [string]$_.Exception.Message; done = $done }
    }
  }
  return [ordered]@{ result = "MIGRATED"; planSha = $sha; done = $done }
}

if ($MyInvocation.InvocationName -ne '.') {
  $p = Get-Content -Raw -LiteralPath $Pins | ConvertFrom-Json
  if ($Mode -eq "plan") { $plan = Get-MigrationPlan $Root $p; $j = $plan | ConvertTo-Json -Depth 8 -Compress
    [ordered]@{ mode = "plan"; planSha = (TS $j); plan = $plan } | ConvertTo-Json -Depth 9 }
  else { Invoke-Migration $Root $p $PlanSha | ConvertTo-Json -Depth 6 }
}
