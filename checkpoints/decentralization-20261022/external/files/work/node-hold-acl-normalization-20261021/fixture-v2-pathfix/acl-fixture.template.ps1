# acl-fixture.ps1 - NATIVE NTFS check of the helper's ProtectedTemp / CasWrite (G4). Root executes; prepared by Claude 60543494.
# Runs ONLY inside -Stage (a NEW SYSTEM+Administrators-only dir the driver created). Reads ONLY the ACL metadata of -Cfg
# (Get-Acl: the security descriptor, never a byte of the file). Writes only fixture PUBLIC text inside -Stage. No task, no
# service, no restart. Output: ONE JSON line (SDDLs, SIDs, sizes, sha256s of public text, booleans).
# -NodeExe/-NodeSha: the node.exe ROOT's native writer proof hashed on minipc (21:29Z: C:\Program Files\nodejs\node.exe,
# b3094d0b..., v24.16.0); refused unless it is exactly that file
param([Parameter(Mandatory = $true)][string]$Stage, [Parameter(Mandatory = $true)][string]$Cfg, [Parameter(Mandatory = $true)][string]$NodeExe, [Parameter(Mandatory = $true)][string]$NodeSha)
$ErrorActionPreference = 'Stop'
if ($Stage -notmatch '^C:\\ProgramData\\Enclave\\staging\\native-acl-[0-9a-f]{12}$' -or -not (Test-Path -LiteralPath $Stage)) { '{"decision":"refused: not a native-acl stage"}'; exit 0 }
#### BEGIN EXTRACTED: functions.ps1 FUNCTIONS_SHA (Sha, ProtectedTemp, CasWrite verbatim from helper e369c5e2) ####
EXTRACTED_FUNCTIONS
#### END EXTRACTED ####
function Facts($p) { $a = Get-Acl -LiteralPath $p; $r = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  [ordered]@{ sddl = $a.Sddl; owner = $a.GetOwner([Security.Principal.SecurityIdentifier]).Value; protected = $a.AreAccessRulesProtected
              explicit = @($r | Where-Object { -not $_.IsInherited }).Count; inherited = @($r | Where-Object { $_.IsInherited }).Count
              readers = @($r | Where-Object { $_.AccessControlType -eq 'Allow' -and ([int]$_.FileSystemRights -band 0x1) } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique) } }
# DIAGNOSIS ONLY (public fixture files; never the helper's functions): mirror ProtectedTemp's two steps on a SEPARATE probe
# file and record every SDDL involved, so a failure is explained by data. NormAi removes ONLY the AI token from the DACL flags.
function NormAi($s) { [regex]::Replace([string]$s, 'D:([A-Z]*)\(', { param($m) 'D:' + ($m.Groups[1].Value -replace 'AI', '') + '(' }) }
function Probe($t) { $a = Get-Acl -LiteralPath $t; $p = $t + '.probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8); $r = [ordered]@{ parentSddl = (Get-Acl -LiteralPath (Split-Path -Parent $t)).Sddl; targetSddl = $a.Sddl }
  try { [IO.File]::WriteAllBytes($p, [byte[]]@()); $r.tempAsCreated = (Get-Acl -LiteralPath $p).Sddl; Set-Acl -LiteralPath $p -AclObject $a; $r.tempAfterSetAcl = (Get-Acl -LiteralPath $p).Sddl
        $r.exactEqual = ($r.tempAfterSetAcl -eq $a.Sddl); $r.equalExceptAiFlag = ((NormAi $r.tempAfterSetAcl) -eq (NormAi $a.Sddl)) } catch { $r.error = Clip $_.Exception.Message }
  finally { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force } }; $r.probeGone = -not (Test-Path -LiteralPath $p); return $r }
function Left($d) { @(Get-ChildItem -LiteralPath $d -Force | Where-Object { $_.Name -like '*.nh-*' } | ForEach-Object { $_.Name }) }
function Clip($m) { $t = [string]$m -replace [regex]::Escape($Stage), '<stage>'; $t.Substring(0, [math]::Min(160, $t.Length)) }   # sanitize, THEN clip by the sanitized length
if ((Sha $NodeExe) -ne $NodeSha) { '{"decision":"refused: the node.exe is not the pinned one (root native writer proof)"}'; exit 0 }
$enc = [Text.Encoding]::ASCII
$o = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); functionsSha = 'FUNCTIONS_SHA'; helperSha = 'e369c5e204f4d0fe9c6277a7237d7f0ddae6beea6a1bfe935825481b34c6ac45'
                 stage = (Facts $Stage); cfg = (Facts $Cfg); node = (Sha $NodeExe); cases = [ordered]@{} }
foreach ($case in 'copied-config-acl', 'inherited', 'protected-explicit', 'ai-parent') {
  $c = [ordered]@{}; $dir = Join-Path $Stage $case; [void][IO.Directory]::CreateDirectory($dir); $target = Join-Path $dir 'target.txt'
  # ai-parent: the case directory's own DACL round-tripped through Set-Acl (which sets the auto-inherited flag) BEFORE the target
  # is created, so the target inherits like the real config files under C:\ProgramData\Enclave (D:AI): tests the diagnosis
  if ($case -eq 'ai-parent') { Set-Acl -LiteralPath $dir -AclObject (Get-Acl -LiteralPath $dir); $c.parentAfterRoundTrip = (Get-Acl -LiteralPath $dir).Sddl }
  [IO.File]::WriteAllBytes($target, $enc.GetBytes("native-acl-fixture public text v1 $case`n"))
  try {
    if ($case -eq 'copied-config-acl') { Set-Acl -LiteralPath $target -AclObject (Get-Acl -LiteralPath $Cfg) }
    if ($case -eq 'protected-explicit') { $a = Get-Acl -LiteralPath $target; $a.SetAccessRuleProtection($true, $true); Set-Acl -LiteralPath $target -AclObject $a }
    $c.target = Facts $target; $c.targetSddlEqualsCfg = ($c.target.sddl -eq $o.cfg.sddl); $c.probe = Probe $target
    # T1 ProtectedTemp: EMPTY with the target's exact SDDL when returned; node.exe then writes into it (as the helper's edit
    # does) and the ACL must survive that write; removed afterwards
    $acl0 = Get-Acl -LiteralPath $target; $t = ProtectedTemp $target '.nh-edit-'
    $c.t1 = [ordered]@{ lengthAtReturn = (Get-Item -LiteralPath $t).Length; sddlEqual = ((Get-Acl -LiteralPath $t).Sddl -eq $acl0.Sddl); tempReaders = (Facts $t).readers }
    $ea = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $null = & $NodeExe -e "require('fs').writeFileSync(process.argv[1],'node-written public fixture text')" $t 2>&1; $c.t1.nodeRc = $LASTEXITCODE; $ErrorActionPreference = $ea
    $c.t1.lengthAfterNode = (Get-Item -LiteralPath $t).Length; $c.t1.sddlEqualAfterNodeWrite = ((Get-Acl -LiteralPath $t).Sddl -eq $acl0.Sddl)
    Remove-Item -LiteralPath $t -Force; $c.t1.gone = -not (Test-Path -LiteralPath $t)
    # T2 CasWrite success: exact new bytes, the target's SDDL kept, no temp left
    $new = $enc.GetBytes("native-acl-fixture public text v2 $case`n"); $b0 = Sha $target
    $r = CasWrite $target $b0 $new
    $c.t2 = [ordered]@{ aclKept = $r.aclKept; afterIsNew = ($r.after -eq (-join ([Security.Cryptography.SHA256]::Create().ComputeHash($new) | ForEach-Object { $_.ToString('x2') })))
                        bytesExact = ([Convert]::ToBase64String([IO.File]::ReadAllBytes($target)) -eq [Convert]::ToBase64String($new)); sddlEqual = ((Get-Acl -LiteralPath $target).Sddl -eq $acl0.Sddl); leftovers = (Left $dir) }
    # T3 CAS refusal (wrong expected sha): throws before any temp; target unchanged
    $b1 = Sha $target; $c.t3 = [ordered]@{}
    try { $null = CasWrite $target ('0' * 64) $enc.GetBytes('never'); $c.t3.threw = $false } catch { $c.t3.threw = $true; $c.t3.error = Clip $_.Exception.Message }
    $c.t3.unchanged = ((Sha $target) -eq $b1); $c.t3.leftovers = (Left $dir)
    # T4 the replace refused natively: a holder WITHOUT FILE_SHARE_DELETE keeps the target open -> CasWrite throws, its finally
    # removes the temp, the target is unchanged
    $h = [IO.File]::Open($target, 'Open', 'Read', 'Read'); $c.t4 = [ordered]@{}
    try { try { $null = CasWrite $target $b1 $enc.GetBytes("native-acl-fixture public text v3 $case`n"); $c.t4.threw = $false } catch { $c.t4.threw = $true; $c.t4.error = Clip $_.Exception.Message } }
    finally { $h.Close() }
    $c.t4.unchanged = ((Sha $target) -eq $b1); $c.t4.sddlEqual = ((Get-Acl -LiteralPath $target).Sddl -eq $acl0.Sddl); $c.t4.leftovers = (Left $dir)
    # T5 a read-only target: the replace is refused; temp removed; target unchanged (attribute restored afterwards)
    (Get-Item -LiteralPath $target).Attributes = 'ReadOnly'; $c.t5 = [ordered]@{}
    try { try { $null = CasWrite $target $b1 $enc.GetBytes('never'); $c.t5.threw = $false } catch { $c.t5.threw = $true } } finally { (Get-Item -LiteralPath $target).Attributes = 'Normal' }
    $c.t5.unchanged = ((Sha $target) -eq $b1); $c.t5.leftovers = (Left $dir)
    $c.pass = ($c.t1.lengthAtReturn -eq 0 -and $c.t1.sddlEqual -and $c.t1.nodeRc -eq 0 -and $c.t1.sddlEqualAfterNodeWrite -and $c.t1.gone -and
               $c.t2.aclKept -and $c.t2.afterIsNew -and $c.t2.bytesExact -and $c.t2.sddlEqual -and -not $c.t2.leftovers.Count -and
               $c.t3.threw -and $c.t3.unchanged -and -not $c.t3.leftovers.Count -and $c.t4.threw -and $c.t4.unchanged -and $c.t4.sddlEqual -and -not $c.t4.leftovers.Count)
    $c.t5informational = $true      # a read-only target is not a helper path; reported, not part of pass (no leftover is still required)
    if ($c.t5.leftovers.Count) { $c.pass = $false }
  } catch { $c.error = Clip $_.Exception.Message; $c.pass = $false; $c.leftovers = (Left $dir) }
  $o.cases[$case] = $c }
# v2 verdict: the three auto-inherited/protected forms must PASS every check; the non-AI 'inherited' form must be REFUSED by
# ProtectedTemp (fail closed), leave no temp/probe, and differ ONLY by the DACL's AI flag (the diagnosis, measured)
$ih = $o.cases['inherited']
$ih.expectedRefusal = ($ih.error -eq 'the temp file does not carry the config ACL') -and -not $ih.probe.exactEqual -and $ih.probe.equalExceptAiFlag -and $ih.probe.probeGone -and -not @($ih.leftovers).Count
$o.pass = $o.cases['copied-config-acl'].pass -and $o.cases['protected-explicit'].pass -and $o.cases['ai-parent'].pass -and $ih.expectedRefusal
$o | ConvertTo-Json -Compress -Depth 6
