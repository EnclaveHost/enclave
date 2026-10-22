# updater-first-hop r4 NATIVE descriptor fixture (ROOT-ONLY; Windows PowerShell 5.1). Proves on minipc, with REAL Windows ACLs, that
# r4's exact Swap keeps the full security descriptor (owner, group, DACL) of a file shaped like the live PF\Enclave\update-host.ps1,
# and that r3's exact Swap does not (the drift root observed in Apply 33600). Everything happens INSIDE -Stage:
#   pf\            a fixture folder whose inheritable ACEs mirror the live parent (SY/BA full, BU/AC/S-1-15-2-2 read+execute)
#   pf\old.ps1     live-shaped (owner SY, group SY, 5 inherited ACEs = the pinned original SDDL): r3 Swap live -> candidate
#   pf\new.ps1     live-shaped: r4 Swap live -> candidate, then r4 Swap candidate -> live with the SAME captured descriptor
# The swapped bytes are the exact public scripts e0d9df1c / 36f9e0d6 (copies in the stage). NOTHING outside the stage is read
# for writing or changed: no task, process, service, VM, network or production file (tripwires; Set-Acl only on stage paths).
param([string]$Stage)
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$sw = [Diagnostics.Stopwatch]::StartNew(); $BOUND_SEC = 120
$PIN = [ordered]@{ 'first-hop.r4.ps1' = 'b5c1680ee1a9090a35beaee9f17bb1ce0ed00a82bdd2d8e7e8210d749d15d720'; 'first-hop.r3.ps1' = 'd57c5ef60bad7e9575bc9b2215f9b5b2eccd4e0a7689fb56fa041e3d828771b0'
  'update-host.live-e0d9df1c.ps1' = 'e0d9df1c271bf09cc21e8f00452fd0415087fb33b8030a7d16bbd717b7058531'
  'update-host.first-hop.ps1' = '36f9e0d61afe58b77e566033ad1155d5c771252874f622592837c33e0a990112' }
$OrigSddl = 'O:SYG:SYD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)(A;ID;0x1200a9;;;AC)(A;ID;0x1200a9;;;S-1-15-2-2)'
$out = [ordered]@{ pass = $false; boundSec = $BOUND_SEC }
trap { $out.pass = $false; $out.error = 'fixture error: ' + $_.Exception.Message; $out | ConvertTo-Json -Compress -Depth 6; exit 3 }
foreach ($n in 'Stop-Process','Start-Process','Start-ScheduledTask','Stop-ScheduledTask','Enable-ScheduledTask','Disable-ScheduledTask','Set-ScheduledTask',
               'Register-ScheduledTask','Unregister-ScheduledTask','Stop-Service','Start-Service','Restart-Service','Stop-VM','Start-VM','Restart-Computer',
               'Remove-Item','Move-Item','Copy-Item','Rename-Item','New-Item','Set-Content','Add-Content','Out-File','Invoke-WebRequest','Invoke-RestMethod') {
  . ([scriptblock]::Create("function $n { throw 'TRIPWIRE: $n is forbidden in this fixture' }")) }
$ROOTFULL = [IO.Path]::GetFullPath($Stage).TrimEnd('\')
function InStage([string]$p) { $f = [IO.Path]::GetFullPath($p); if (-not $f.StartsWith($ROOTFULL + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "TRIPWIRE: ACL/file write outside the stage: $f" }; $f }
function Set-Acl { param([string]$LiteralPath, $AclObject) Microsoft.PowerShell.Security\Set-Acl -LiteralPath (InStage $LiteralPath) -AclObject $AclObject }
function Bound($what) { if ($sw.Elapsed.TotalSeconds -gt $BOUND_SEC) { throw "fixture bound $BOUND_SEC s exceeded before $what" } }

# ---- 1 exact staged bytes; Windows PowerShell 5.1 parse of all four scripts
if ($PSVersionTable.PSVersion.Major -ne 5 -or [string]$PSVersionTable.PSEdition -ne 'Desktop') { $out.error = 'not Windows PowerShell 5.1 Desktop'; $out | ConvertTo-Json -Compress; exit 4 }
$out.psVersion = $PSVersionTable.PSVersion.ToString()
$pins = [ordered]@{}; foreach ($k in $PIN.Keys) { $pins[$k] = ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Stage $k)).Hash.ToLower() -eq $PIN[$k]) }
$out.pins = $pins; if (@($pins.Values | Where-Object { -not $_ }).Count) { throw 'staged bytes are not the pinned files' }
$asts = @{}; $parse = [ordered]@{}
foreach ($k in @($PIN.Keys) + 'native-acl-test.ps1') { $tk = $null; $er = $null; $asts[$k] = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Stage $k), [ref]$tk, [ref]$er); $parse[$k] = $er.Count }
$out.parseErrors = $parse; if (@($parse.Values | Where-Object { $_ -ne 0 }).Count) { throw 'parse errors' }
$LIVE = Join-Path $Stage 'update-host.live-e0d9df1c.ps1'; $CAND = Join-Path $Stage 'update-host.first-hop.ps1'
$LiveSha = $PIN['update-host.live-e0d9df1c.ps1']; $CandSha = $PIN['update-host.first-hop.ps1']
function FileSha256($p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }

# ---- 2 a live-shaped fixture folder + files (real Windows ACLs, inside the stage only)
Bound 'fixture folder'
$PFX = InStage (Join-Path $Stage 'pf')
$ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetAccessRuleProtection($true, $false)
foreach ($ace in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute, Synchronize'),
                   @('S-1-15-2-1', 'ReadAndExecute, Synchronize'), @('S-1-15-2-2', 'ReadAndExecute, Synchronize'))) {
  $ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $ace[0]), $ace[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }
[void][IO.Directory]::CreateDirectory($PFX, $ds)
$SY = New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
function LiveShaped([string]$name) {   # live bytes, inherited ACEs from pf\, then owner+group SYSTEM -> must equal the pinned original
  $p = InStage (Join-Path $PFX $name); [IO.File]::WriteAllBytes($p, [IO.File]::ReadAllBytes($LIVE))
  $a = Get-Acl -LiteralPath $p; $a.SetOwner($SY); $a.SetGroup($SY); Set-Acl -LiteralPath $p -AclObject $a; $how = 'owner+group'
  if ((Get-Acl -LiteralPath $p).Sddl -ne $OrigSddl) {   # only flag/order differences left: apply the pinned original descriptor itself
    $a = Get-Acl -LiteralPath $p; $a.SetSecurityDescriptorSddlForm($OrigSddl); Set-Acl -LiteralPath $p -AclObject $a; $how = 'pinned SDDL' }
  [ordered]@{ path = $p; sddl = (Get-Acl -LiteralPath $p).Sddl; how = $how } }
$repro = [ordered]@{}
try { $o = LiveShaped 'old.ps1'; $n = LiveShaped 'new.ps1'; $repro.oldSddl = $o.sddl; $repro.newSddl = $n.sddl; $repro.how = @($o.how, $n.how)
      $repro.equalsOriginal = ($o.sddl -eq $OrigSddl -and $n.sddl -eq $OrigSddl) }
catch { $repro.error = $_.Exception.Message; $repro.equalsOriginal = $false }
$out.reproduction = $repro
if (-not $repro.equalsOriginal) { $out.error = 'could not build a file with the exact live descriptor in the stage: no claim either way'; $out | ConvertTo-Json -Compress -Depth 6; exit 1 }

# the EXACT functions of each revision (AST text, never retyped), each in its own scriptblock scope
function Load($file, [string[]]$names) { (@($names | ForEach-Object { $nm = $_
  $f = @($asts[$file].FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $nm }, $true))
  if ($f.Count -ne 1) { throw "$nm missing in $file" }; $f[0].Extent.Text })) -join "`n" }
$R3 = Load 'first-hop.r3.ps1' @('Sha', 'Swap'); $R4 = Load 'first-hop.r4.ps1' @('Sha', 'Swap')

# ---- 3 BASELINE r3 Swap: must reproduce the drift (bytes swapped, descriptor NOT kept)
Bound 'r3'
$old = [ordered]@{}
$sb = [scriptblock]::Create($R3 + "`n" + '$Target = $args[0]; $RunId = ''native-r3''; Swap $args[1] $args[2] ''new''; [ordered]@{ sha = (Sha $Target); sddl = (Get-Acl -LiteralPath $Target).Sddl }')
try { $r = & $sb $o.path $CAND $CandSha; $old.sha = $r.sha; $old.sddl = $r.sddl } catch { $old.error = $_.Exception.Message }
$old.bytesSwapped = ($old.sha -eq $CandSha); $old.descriptorDrifted = ($old.sddl -ne $OrigSddl)
$out.r3 = $old

# ---- 4 r4 Swap round trip with ONE captured descriptor: live -> candidate -> live, exact SDDL after each step
Bound 'r4'
$new = [ordered]@{}
$sb4 = [scriptblock]::Create($R4 + "`n" + '$Target = $args[0]; $RunId = ''native-r4''; $ref = Get-Acl -LiteralPath $Target; $res = [ordered]@{ refSddl = $ref.Sddl }
  Swap $args[1] $args[2] ''new'' $ref; $res.applySha = (Sha $Target); $res.applySddl = (Get-Acl -LiteralPath $Target).Sddl
  Swap $args[3] $args[4] ''restore'' $ref; $res.restoreSha = (Sha $Target); $res.restoreSddl = (Get-Acl -LiteralPath $Target).Sddl; $res')
try { $r = & $sb4 $n.path $CAND $CandSha $LIVE $LiveSha; foreach ($k in $r.Keys) { $new[$k] = $r[$k] } } catch { $new.error = $_.Exception.Message }
$new.applyExact = ($new.applySha -eq $CandSha -and $new.applySddl -eq $OrigSddl)
$new.restoreExact = ($new.restoreSha -eq $LiveSha -and $new.restoreSddl -eq $OrigSddl)
$new.noTempLeft = (@(Get-ChildItem -LiteralPath $PFX -Force | Where-Object { $_.Name -like '*.first-hop-*' }).Count -eq 0)
$out.r4 = $new

# ---- 5 informational: r4 Swap restoring r3's drifted file from a descriptor built from the PINNED original SDDL
Bound 'info'
$info = [ordered]@{}
$sb5 = [scriptblock]::Create($R4 + "`n" + '$Target = $args[0]; $RunId = ''native-r4b''; $ref = New-Object Security.AccessControl.FileSecurity; $ref.SetSecurityDescriptorSddlForm($args[3])
  Swap $args[1] $args[2] ''restore'' $ref; [ordered]@{ sha = (Sha $Target); sddl = (Get-Acl -LiteralPath $Target).Sddl }')
try { $r = & $sb5 $o.path $LIVE $LiveSha $OrigSddl; $info.sha = $r.sha; $info.sddl = $r.sddl; $info.exact = ($r.sha -eq $LiveSha -and $r.sddl -eq $OrigSddl) } catch { $info.error = $_.Exception.Message }
$out.informationalRestoreFromPinnedSddl = $info

$out.seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
$out.baselineFailsAsExpected = [bool]($old.bytesSwapped -and $old.descriptorDrifted)
$out.r4RoundTripExact = [bool]($new.applyExact -and $new.restoreExact -and $new.noTempLeft)
$out.notProven = 'Fixture files in the stage only; the production file, task and Apply/Restore-Guarded control flow are not exercised here.'
$out.pass = [bool]($out.baselineFailsAsExpected -and $out.r4RoundTripExact -and $sw.Elapsed.TotalSeconds -le $BOUND_SEC)
$out | ConvertTo-Json -Compress -Depth 6
if ($out.pass) { exit 0 } else { exit 1 }
