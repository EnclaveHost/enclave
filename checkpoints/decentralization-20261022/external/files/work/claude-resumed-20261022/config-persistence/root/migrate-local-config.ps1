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
function FileSha($p) { if (Test-Path -LiteralPath $p -PathType Leaf) { Sha ([IO.File]::ReadAllBytes($p)) } else { "absent" } }
function Lines($p) { if (Test-Path -LiteralPath $p -PathType Leaf) { @([IO.File]::ReadAllLines($p)) } else { @() } }

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
    $old = $(if ($before -ne "absent") { [IO.File]::ReadAllBytes($p) } else { [Text.Encoding]::ASCII.GetBytes("@echo off`r`nrem This box's own settings, read last by the generated configuration. Updates never write this file.`r`n") })
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

# Windows ACL steps, kept apart (a moved setting is as sensitive as the hook it lands in)
function New-PrivateFile([string]$path, [byte[]]$bytes) {
  $sec = New-Object System.Security.AccessControl.FileSecurity
  $sec.SetAccessRuleProtection($true, $false)
  foreach ($sid in "S-1-5-18", "S-1-5-32-544") { $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier $sid), "FullControl", "Allow"))) }
  $sec.SetOwner((New-Object System.Security.Principal.SecurityIdentifier "S-1-5-32-544"))
  $f = [IO.File]::Create($path, 4096, [IO.FileOptions]::None, $sec); try { $f.Write($bytes, 0, $bytes.Length) } finally { $f.Dispose() }
}
function New-PrivateDir([string]$path) {
  $ds = New-Object System.Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm("O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
  [void][IO.Directory]::CreateDirectory($path, $ds)
}
function Copy-FileAcl([string]$from, [string]$to) { Set-Acl -LiteralPath $to -AclObject (Get-Acl -LiteralPath $from) }

function Invoke-Migration($root, $pins, $planSha) {
  $plan = Get-MigrationPlan $root $pins
  $json = $plan | ConvertTo-Json -Depth 8 -Compress; $sha = TS $json
  if ($plan.refused.Count) { return [ordered]@{ result = "REFUSED"; planSha = $sha; refused = $plan.refused } }
  if ($planSha -ne $sha) { return [ordered]@{ result = "REFUSED"; planSha = $sha; refused = @("the recomputed plan is not the reviewed one (-PlanSha)") } }
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"); $bak = Join-Path $root "backup\local-config-migration-$stamp"
  $done = [ordered]@{}
  foreach ($h in $plan.hooks.Keys) {
    $hp = $plan.hooks[$h]; if ($hp.after -eq $hp.before) { $done[$h] = "unchanged"; continue }
    $p = Join-Path $root $h
    if ((FileSha $p) -ne $hp.before) { return [ordered]@{ result = "FAILED"; planSha = $sha; error = "$h changed during the migration"; done = $done } }
    if ($hp.create) { New-PrivateFile $p $script:Content[$h] }
    else {
      New-PrivateDir (Join-Path $root "backup"); New-PrivateDir $bak
      $tmp = "$p.migrate-$stamp.tmp"
      [IO.File]::WriteAllBytes($tmp, $script:Content[$h]); Copy-FileAcl $p $tmp
      [IO.File]::Replace($tmp, $p, (Join-Path $bak $h))       # the old file becomes the backup; never a null backup path
    }
    $after = FileSha $p
    if ($after -ne $hp.after) { return [ordered]@{ result = "FAILED"; planSha = $sha; error = "$h after-hash differs from the plan"; done = $done } }
    $done[$h] = [ordered]@{ before = $hp.before; after = $after; backup = $(if ($hp.create) { $null } else { Join-Path $bak $h }) }
  }
  return [ordered]@{ result = "MIGRATED"; planSha = $sha; done = $done }
}

if ($MyInvocation.InvocationName -ne '.') {
  $p = Get-Content -Raw -LiteralPath $Pins | ConvertFrom-Json
  if ($Mode -eq "plan") { $plan = Get-MigrationPlan $Root $p; $j = $plan | ConvertTo-Json -Depth 8 -Compress
    [ordered]@{ mode = "plan"; planSha = (TS $j); plan = $plan } | ConvertTo-Json -Depth 9 }
  else { Invoke-Migration $Root $p $PlanSha | ConvertTo-Json -Depth 6 }
}
