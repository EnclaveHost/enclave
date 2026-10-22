# sandbox-test.ps1 - NATIVE tests of tunnel-receiver.ps1 on a real Windows host, with NO side effect outside $PSScriptRoot:
# every scenario runs the receiver in sandbox mode (params.sandbox=true): its sshd_config is a COPY, its accounts are a
# JSON file, sshd is never restarted, no scheduled task is created. Only `sshd -t -f <copy>` touches the real binary.
# Inputs beside this file: tunnel-receiver.ps1, block.txt (the reviewed managed block), test.json {publicKey, winUser}.
# Output: one JSON document on stdout (scenario results + PASS/FAIL per assertion).
$ErrorActionPreference = 'Stop'
$HERE = $PSScriptRoot
$T = Get-Content -Raw -LiteralPath (Join-Path $HERE 'test.json') | ConvertFrom-Json
$BLK = [IO.File]::ReadAllText((Join-Path $HERE 'block.txt'))
function ShaText($str) { $h = [Security.Cryptography.SHA256]::Create(); (($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($str)) | ForEach-Object { $_.ToString('x2') }) -join '') }
function Sha($path) { if (Test-Path -LiteralPath $path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower() } else { 'absent' } }
$OUT = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); psVersion = $PSVersionTable.PSVersion.ToString(); scenarios = [ordered]@{} }
$KEYLINE = 'restrict,port-forwarding,permitlisten="127.0.0.1:31053",command="cmd.exe /c exit 1" ' + $T.publicKey + "`r`n"

function NewScenario($name) {
  $root = Join-Path $HERE $name; $stage = Join-Path $root 'stage'
  [void](New-Item -ItemType Directory -Path $stage)
  Copy-Item -LiteralPath 'C:\ProgramData\ssh\sshd_config' -Destination (Join-Path $root 'sshd_config')
  Copy-Item -LiteralPath (Join-Path $HERE 'tunnel-receiver.ps1') -Destination (Join-Path $stage 'tunnel-receiver.ps1')
  $cfgText = [IO.File]::ReadAllText((Join-Path $root 'sshd_config'))
  $p = [ordered]@{ runId = $name; winUser = $T.winUser; sandbox = $true; sandboxRoot = $root; publicKey = $T.publicKey
    keysSha = (ShaText $KEYLINE); expectConfigSha = (Sha (Join-Path $root 'sshd_config')); blockSha = (ShaText $BLK)
    appliedConfigSha = (ShaText ($cfgText.TrimEnd("`r", "`n") + "`r`n`r`n" + $BLK + "`r`n")); userDescription = 'Enclave challenge-DNS tunnel -R 127.0.0.1:31053' }
  $p | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $stage 'params.json')
  # as the real stage step does: Administrators own the staged dir and files (no other owner can rewrite their ACL)
  & icacls.exe $stage /setowner '*S-1-5-32-544' /T /Q | Out-Null
  return @{ root = $root; stage = $stage; cfg = (Join-Path $root 'sshd_config'); keys = (Join-Path $root ($T.winUser + '_authorized_keys')); accounts = (Join-Path $root 'accounts.json') }
}
function Run($s, $mode) {
  & (Join-Path $s.stage 'tunnel-receiver.ps1') -Mode $mode -Dir $s.stage
  $r = Get-Content -Raw -LiteralPath (Join-Path $s.stage "receipt-$mode.json") | ConvertFrom-Json
  return $r
}
function Check($name, $cond, $detail) { $script:CUR.checks += [ordered]@{ check = $name; result = $(if ($cond) { 'PASS' } else { 'FAIL' }); detail = $detail } }
# PS 5.1 ConvertFrom-Json emits a JSON array as ONE object: enumerate it explicitly
function Accounts($s) { if (Test-Path -LiteralPath $s.accounts) { $x = Get-Content -Raw -LiteralPath $s.accounts | ConvertFrom-Json; foreach ($acc in @($x)) { if ($null -ne $acc) { $acc } } } }

# A: apply, then rollback with nothing changed in between -> byte-identical config, keys gone, account gone
$script:CUR = [ordered]@{ checks = @() }; $s = NewScenario 'A'
$before = Sha $s.cfg; $a = Run $s 'apply'
Check 'A.applied' ($a.decision -like 'applied*') $a.decision
Check 'A.blockInConfig' ([IO.File]::ReadAllText($s.cfg).Contains($BLK)) (Sha $s.cfg)
Check 'A.keysExact' ((Sha $s.keys) -eq (ShaText $KEYLINE)) (Sha $s.keys)
$acs = @(Accounts $s); Check 'A.accountCreated' ($acs.Count -eq 1 -and $acs[0].name -eq $T.winUser -and $acs[0].sid -eq (Get-Content -Raw -LiteralPath (Join-Path $s.stage 'state.json') | ConvertFrom-Json).createdSid) ($acs | ConvertTo-Json -Compress)
$b = Run $s 'rollback'
Check 'A.rolledBack' ($b.decision -eq 'rolled-back') $b.decision
Check 'A.configRestored' ((Sha $s.cfg) -eq $before) (Sha $s.cfg)
Check 'A.keysGone' (-not (Test-Path -LiteralPath $s.keys)) ''
Check 'A.accountGone' (@(Accounts $s).Count -eq 0) (Get-Content -Raw -LiteralPath $s.accounts)
$OUT.scenarios.A = $script:CUR

# B: after apply, someone else edits sshd_config AND the keys file -> rollback keeps both edits, removes only its block,
#    leaves the changed keys file, removes its own account, and reports a conflict (not success)
$script:CUR = [ordered]@{ checks = @() }; $s = NewScenario 'B'
$a = Run $s 'apply'
Add-Content -LiteralPath $s.cfg -Value '# a later unrelated change (must survive)'
Add-Content -LiteralPath $s.keys -Value '# a later change to the keys file'
$keysAfterEdit = Sha $s.keys
$b = Run $s 'rollback'
$text = [IO.File]::ReadAllText($s.cfg)
Check 'B.conflictReported' ($b.decision -like 'rollback-conflict*') $b.decision
Check 'B.unrelatedConfigChangeKept' ($text.Contains('# a later unrelated change (must survive)')) ''
Check 'B.ownBlockRemoved' (-not $text.Contains($BLK)) ''
Check 'B.changedKeysLeft' ((Sha $s.keys) -eq $keysAfterEdit) ''
Check 'B.ownAccountRemoved' (@(Accounts $s).Count -eq 0) (Get-Content -Raw -LiteralPath $s.accounts)
$OUT.scenarios.B = $script:CUR

# C: pre-existing objects (an account of that name, a keys file, a managed block) -> apply REFUSED, then the guard
#    (no confirm) changes NOTHING
$script:CUR = [ordered]@{ checks = @() }; $s = NewScenario 'C'
ConvertTo-Json -InputObject @([pscustomobject]@{ name = $T.winUser; sid = 'S-1-5-21-9-9-9-4242' }) | Set-Content -LiteralPath $s.accounts
Set-Content -LiteralPath $s.keys -Value 'pre-existing keys (not ours)'
Add-Content -LiteralPath $s.cfg -Value ("`r`n" + $BLK)
$pre = @{ cfg = (Sha $s.cfg); keys = (Sha $s.keys); acct = (Sha $s.accounts) }
$a = Run $s 'apply'
Check 'C.applyRefused' ($a.decision -like 'refused*') $a.decision
Check 'C.noStateWritten' (-not (Test-Path -LiteralPath (Join-Path $s.stage 'state.json'))) ''
$g = Run $s 'guard'
Check 'C.guardChangedNothing' ($g.decision -like '*nothing-to-roll-back*') $g.decision
Check 'C.configUntouched' ((Sha $s.cfg) -eq $pre.cfg) ''
Check 'C.keysUntouched' ((Sha $s.keys) -eq $pre.keys) ''
Check 'C.accountsUntouched' ((Sha $s.accounts) -eq $pre.acct) ''
$acs = @(Accounts $s); Check 'C.preExistingAccountKept' ($acs.Count -eq 1 -and $acs[0].sid -eq 'S-1-5-21-9-9-9-4242') ($acs | ConvertTo-Json -Compress)
$OUT.scenarios.C = $script:CUR

# D: a PRE-EXISTING backup parent with its own ACL and another run's backup -> both unchanged by apply + rollback
$script:CUR = [ordered]@{ checks = @() }; $s = NewScenario 'D'
$bp = Join-Path $s.root 'backup'; [void](New-Item -ItemType Directory -Path (Join-Path $bp 'other-run'))
Set-Content -LiteralPath (Join-Path $bp 'other-run\keep.txt') -Value 'another run''s backup'
$acl = Get-Acl -LiteralPath $bp
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'), 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
Set-Acl -LiteralPath $bp -AclObject $acl
$sddl = (Get-Acl -LiteralPath $bp).Sddl; $keep = Sha (Join-Path $bp 'other-run\keep.txt')
$a = Run $s 'apply'; $b = Run $s 'rollback'
Check 'D.applied' ($a.decision -like 'applied*') $a.decision
Check 'D.parentAclUnchanged' ((Get-Acl -LiteralPath $bp).Sddl -eq $sddl) ''
Check 'D.otherBackupUnchanged' ((Sha (Join-Path $bp 'other-run\keep.txt')) -eq $keep) ''
$runAcl = Get-Acl -LiteralPath (Join-Path $bp 'tunnel-D')
Check 'D.runBackupProtected' ($runAcl.AreAccessRulesProtected -and @($runAcl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-5-32-544') }).Count -eq 0) $runAcl.Sddl
$OUT.scenarios.D = $script:CUR

# E: a staging dir that grants write to Users -> the receiver refuses before reading anything else
$script:CUR = [ordered]@{ checks = @() }; $s = NewScenario 'E'
$acl = Get-Acl -LiteralPath $s.stage
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'), 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
Set-Acl -LiteralPath $s.stage -AclObject $acl
$a = Run $s 'apply'
Check 'E.untrustedStagingRefused' ($a.decision -like 'refused: staging not trusted*') $a.decision
Check 'E.nothingChanged' (-not (Test-Path -LiteralPath $s.keys) -and -not [IO.File]::ReadAllText($s.cfg).Contains($BLK)) ''
$OUT.scenarios.E = $script:CUR

# F: B1, natively and WITHOUT creating anything: New-LocalUser's own parameter validation under -WhatIf, for the new name
#    and the old 22-character one (the documented SAM limit is 20)
$script:CUR = [ordered]@{ checks = @() }
function WhatIfUser($n) { try { New-LocalUser -Name $n -NoPassword -WhatIf -ErrorAction Stop 3>$null 6>$null | Out-Null; 'accepted' } catch { 'rejected: ' + $_.Exception.Message } }
$newName = WhatIfUser $T.winUser; $oldName = WhatIfUser 'enclave-control-tunnel'
Check 'F.newNameAccepted' ($newName -eq 'accepted' -and $T.winUser.Length -le 20) $newName
Check 'F.oldNameRejected' ($oldName -like 'rejected*') $oldName
Check 'F.noAccountCreated' (-not (Get-LocalUser -Name $T.winUser -ErrorAction SilentlyContinue)) ''
$OUT.scenarios.F = $script:CUR

# G: B6, the EXACT launcher the SYSTEM tasks run (texts made by tunnel_install.py launcher_text, pinned to this dir's
#    params + receiver hashes), started the way the task starts it (-EncodedCommand), in sandbox mode
if (Test-Path -LiteralPath (Join-Path $HERE 'G-params.json')) {
  $script:CUR = [ordered]@{ checks = @() }
  $root = Join-Path $HERE 'G'; $stage = Join-Path $root 'stage'; [void](New-Item -ItemType Directory -Path $stage)
  Copy-Item -LiteralPath 'C:\ProgramData\ssh\sshd_config' -Destination (Join-Path $root 'sshd_config')
  $rx = Join-Path $stage 'tunnel-receiver.ps1'; $pj = Join-Path $stage 'params.json'
  Copy-Item -LiteralPath (Join-Path $HERE 'tunnel-receiver.ps1') -Destination $rx; Copy-Item -LiteralPath (Join-Path $HERE 'G-params.json') -Destination $pj
  & icacls.exe $stage /setowner '*S-1-5-32-544' /T /Q | Out-Null
  $cfg0 = Sha (Join-Path $root 'sshd_config')
  function Launch($mode) {
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([IO.File]::ReadAllText((Join-Path $HERE "G-launch-$mode.txt"))))
    $ErrorActionPreference = 'Continue'; & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $enc 2>&1 | Out-Null; $c = $LASTEXITCODE; $ErrorActionPreference = 'Stop'; $c
  }
  function Refusal($mode) { $f = Join-Path $stage "launcher-refused-$mode.txt"; if (Test-Path -LiteralPath $f) { $x = (Get-Content -Raw -LiteralPath $f).Trim(); Remove-Item -LiteralPath $f -Force; $x } else { $null } }
  # 1: the receiver changed after staging -> refused before it runs
  $orig = [IO.File]::ReadAllBytes($rx); Add-Content -LiteralPath $rx -Value '# tampered after staging'
  $c = Launch 'apply'; $why = Refusal 'apply'
  Check 'G.tamperedReceiverRefused' ($c -eq 9 -and $why -like '*hash tunnel-receiver.ps1*' -and -not (Test-Path -LiteralPath (Join-Path $stage 'receipt-apply.json'))) "rc=$c $why"
  [IO.File]::WriteAllBytes($rx, $orig)
  # 2: params.json writable by Users -> refused
  $acl0 = Get-Acl -LiteralPath $pj; $acl = Get-Acl -LiteralPath $pj
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'), 'Modify', 'Allow')))
  Set-Acl -LiteralPath $pj -AclObject $acl
  $c = Launch 'apply'; $why = Refusal 'apply'
  Check 'G.writableParamsRefused' ($c -eq 9 -and $why -like '*write S-1-5-32-545*' -and -not (Test-Path -LiteralPath (Join-Path $stage 'state.json'))) "rc=$c $why"
  Set-Acl -LiteralPath $pj -AclObject $acl0
  Check 'G.configUntouchedByRefusals' ((Sha (Join-Path $root 'sshd_config')) -eq $cfg0) ''
  # 3: the pinned bytes in a trusted dir -> the receiver runs: apply, then rollback restores every byte
  $c = Launch 'apply'; $why = Refusal 'apply'
  $a = if (Test-Path -LiteralPath (Join-Path $stage 'receipt-apply.json')) { Get-Content -Raw -LiteralPath (Join-Path $stage 'receipt-apply.json') | ConvertFrom-Json } else { $null }
  Check 'G.pinnedApplyRan' ($a -and $a.decision -like 'applied*') "rc=$c $why $(if ($a) { $a.decision })"
  $c = Launch 'rollback'; $why = Refusal 'rollback'
  $b = if (Test-Path -LiteralPath (Join-Path $stage 'receipt-rollback.json')) { Get-Content -Raw -LiteralPath (Join-Path $stage 'receipt-rollback.json') | ConvertFrom-Json } else { $null }
  Check 'G.pinnedRollbackRan' ($b -and $b.decision -eq 'rolled-back') "rc=$c $why $(if ($b) { $b.decision })"
  Check 'G.configRestored' ((Sha (Join-Path $root 'sshd_config')) -eq $cfg0) ''
  $OUT.scenarios.G = $script:CUR
}

$all = @($OUT.scenarios.Values | ForEach-Object { $_.checks })
$OUT.total = $all.Count; $OUT.failed = @($all | Where-Object { $_.result -ne 'PASS' }).Count
$OUT | ConvertTo-Json -Depth 6 -Compress
