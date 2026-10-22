# swap-prelude.ps1 - TEST-ONLY, dot-sourced by the mock harness's bundle-swap child (params.testPrelude; refused on Windows by the
# coordinator's testRoot guard) BEFORE the pinned bundle-swap.ps1 bytes run. It supplies what Linux pwsh lacks (Get-Acl / Set-Acl
# of a protected SYSTEM+Administrators file) and injects the swap faults armed in <root>\swap-fault.json by pair-mock.ps1:
#   hang                 the child never finishes (the coordinator must kill it: an UNKNOWN outcome)
#   hang-on-2            the second operation on that target hangs (an undo that cannot be proven)
#   crash                the child exits 7 before touching anything (exit confirmed, target unchanged, journal untouched)
#   acl-mismatch         Set-Acl does not restore the ACL: bundle-swap reports MISMATCH, journal left started
#   crash-after-replace  the child exits 9 right after [IO.File]::Replace (target new, journal started)
$ErrorActionPreference = 'Stop'
$global:SwapRoot = $env:PAIR_MOCK_ROOT
function global:SwapFault($target) {
  $f = Join-Path $global:SwapRoot 'swap-fault.json'; if (-not (Test-Path $f)) { return $null }
  $name = [IO.Path]::GetFileName($target); $j = Get-Content -Raw $f | ConvertFrom-Json; return [string]$j.$name }
function global:Get-FileHash { param([string]$Algorithm, [string]$LiteralPath)
  if (-not $global:FaultChecked -and $LiteralPath -like '*control*node*.mjs') {
    $global:FaultChecked = $true; $global:FaultTarget = $LiteralPath; $fault = SwapFault $LiteralPath
    $cnt = Join-Path $global:SwapRoot ('swap-count-' + [IO.Path]::GetFileName($LiteralPath)); $n = 1 + [int]$(if (Test-Path $cnt) { Get-Content $cnt } else { 0 }); Set-Content $cnt $n
    if ($fault -eq 'hang' -or ($fault -eq 'hang-on-2' -and $n -ge 2)) { Start-Sleep -Seconds 120 }
    if ($fault -eq 'crash') { exit 7 }
    $global:Fault = $fault }
  Microsoft.PowerShell.Utility\Get-FileHash -Algorithm $Algorithm -LiteralPath $LiteralPath }
function global:NewAcl($sddl) {
  $a = [pscustomobject]@{ Sddl = $sddl; AreAccessRulesProtected = $true }
  $a | Add-Member ScriptMethod GetAccessRules { param($x, $y, $z)
    @([pscustomobject]@{ AccessControlType = 'Allow'; IdentityReference = [pscustomobject]@{ Value = 'S-1-5-18' } },
      [pscustomobject]@{ AccessControlType = 'Allow'; IdentityReference = [pscustomobject]@{ Value = 'S-1-5-32-544' } }) }
  return $a }
function global:Get-Acl { param([string]$LiteralPath)
  $m = $LiteralPath + '.acl-changed'
  if (Test-Path -LiteralPath $m) { return (NewAcl 'O:SYG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;WD)') }
  return (NewAcl 'O:SYG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)') }
function global:Set-Acl { param([string]$LiteralPath, $AclObject)
  if ($global:Fault -eq 'crash-after-replace' -and $LiteralPath -eq $global:FaultTarget) { exit 9 }
  if ($global:Fault -eq 'acl-mismatch' -and $LiteralPath -eq $global:FaultTarget) { Set-Content -LiteralPath ($LiteralPath + '.acl-changed') 'x' } }
