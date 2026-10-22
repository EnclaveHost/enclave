# STAGING ONLY (C:\Users\claude\enclave-staging\claude-shield-local-auth\pd): the installer's key block, extracted verbatim from
# install-host.ps1, run against a staging copy of ProgramData\Enclave\shield (same protected SYSTEM+Administrators ACL as the
# installer gives the real one); then each case through the REAL readCustodyCallbackKey. Never touches ProgramData.
$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"
$root = Join-Path $env:USERPROFILE "enclave-staging\claude-shield-local-auth"
$PD = Join-Path $root "pd"
if (Test-Path $PD) { Remove-Item $PD -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $PD "shield") | Out-Null
icacls (Join-Path $PD "shield") /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /q | Out-Null
function Emit($step, $state, $message) { "EMIT $step $state $message" }
$block = Join-Path $root "installer-block.ps1"
$k = Join-Path $PD "shield\custody-callback.key"
"--- run 1: absent -> created"; . $block
$sddl1 = (Get-Acl -LiteralPath $k).Sddl; "created sddl: $sddl1"
# variants
$u = Join-Path $PD "shield\users-read.key"; Copy-Item $k $u; icacls $u /setowner "*S-1-5-32-544" /q | Out-Null; icacls $u /grant "*S-1-5-32-545:R" /q | Out-Null
$e = Join-Path $PD "shield\everyone-read.key"; Copy-Item $k $e; icacls $e /setowner "*S-1-5-32-544" /q | Out-Null; icacls $e /grant "*S-1-1-0:R" /q | Out-Null
$o = Join-Path $PD "shield\user-owned.key"; Copy-Item $k $o                                       # inherited private DACL, owner = this user
$p = Join-Path $root "profile-acl.key"; Copy-Item $k $p                                           # the user profile's ACL
& node (Join-Path $root "keycheck.mjs") $k $u $e $o $p (Join-Path $PD "shield\absent.key")
"--- run 2: an EXISTING key that is not private -> reported, unchanged"
icacls $k /grant "*S-1-5-32-545:R" /q | Out-Null
$before = (Get-Acl -LiteralPath $k).Sddl; $hashBefore = (Get-FileHash $k).Hash
. $block
$after = (Get-Acl -LiteralPath $k).Sddl; $hashAfter = (Get-FileHash $k).Hash
"unchanged acl: " + ($before -eq $after) + "; unchanged content: " + ($hashBefore -eq $hashAfter)
