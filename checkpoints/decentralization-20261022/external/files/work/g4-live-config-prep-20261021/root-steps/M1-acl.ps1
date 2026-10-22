# M1-acl.ps1 - ROOT-RUN MUTATION (Windows PowerShell 5.1, elevated). The SMALLEST ACL change for the challenge declaration.
#   -Mode apply    1. C:\ProgramData\Enclave\network: ADD one ACE  LOCAL SERVICE (S-1-5-19) ReadPermissions (READ_CONTROL only),
#                     THIS FOLDER ONLY (no inheritance), ONLY if R-reads showed lsReadControl=false there. No read-data right,
#                     nothing inherited: the dir's file contents stay readable by SYSTEM/Administrators only (node-hold N3).
#                     CAS: the dir's SDDL must equal -NetworkSddl (from R-reads) before the change.
#                  2. C:\ProgramData\Enclave\network\challenge: CREATED NEW (refused if it exists or the parent is a reparse
#                     point) with ITS OWN protected ACL in one call: SYSTEM + Administrators FullControl, LOCAL SERVICE
#                     ReadAndExecute, all ContainerInherit+ObjectInherit; owner Administrators.
#   -Mode rollback removes exactly that ACE (only with -RemoveNetworkAce, i.e. apply added it) and the challenge dir ONLY if it holds nothing but the managed
#                  front's own declaration file(s) (challenge-front.json and its .challenge-front.json.tmp-*), else refuses.
# Ancestors C:\, C:\ProgramData, C:\ProgramData\Enclave: NO change (root's 21:55 proof: Users read; LOCAL SERVICE is a Users member).
param([ValidateSet('apply', 'rollback')][string]$Mode = 'apply', [string]$NetworkSddl = '', [switch]$AddNetworkAce, [switch]$RemoveNetworkAce)
$ErrorActionPreference = 'Stop'
$NET = 'C:\ProgramData\Enclave\network'; $CH = Join-Path $NET 'challenge'; $LS = New-Object Security.Principal.SecurityIdentifier 'S-1-5-19'
$rule = New-Object Security.AccessControl.FileSystemAccessRule($LS, [Security.AccessControl.FileSystemRights]::ReadPermissions,
  [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
$o = [ordered]@{ mode = $Mode; at = [DateTime]::UtcNow.ToString('o') }
if ($Mode -eq 'apply') {
  $a = Get-Acl -LiteralPath $NET; $o.networkSddlBefore = $a.Sddl
  if ($AddNetworkAce) {
    if ($a.Sddl -ne $NetworkSddl) { $o.decision = 'REFUSED: the network dir ACL is not the one R-reads saw (CAS)'; $o | ConvertTo-Json -Compress; exit 0 }
    $a.AddAccessRule($rule); Set-Acl -LiteralPath $NET -AclObject $a; $o.networkSddlAfter = (Get-Acl -LiteralPath $NET).Sddl }
  if (Test-Path -LiteralPath $CH) { $o.decision = 'REFUSED: the challenge dir exists'; $o | ConvertTo-Json -Compress; exit 0 }
  if ((Get-Item -LiteralPath $NET -Force).Attributes -band 1024) { $o.decision = 'REFUSED: the network dir is a reparse point'; $o | ConvertTo-Json -Compress; exit 0 }
  $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetAccessRuleProtection($true, $false)
  $ds.SetOwner((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))
  foreach ($x in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-19', 'ReadAndExecute'))) {
    $ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $x[0]), $x[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }
  [void][IO.Directory]::CreateDirectory($CH, $ds)
  $c = Get-Acl -LiteralPath $CH; $o.challengeSddl = $c.Sddl; $o.challengeOwner = $c.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $o.decision = 'applied'
} else {
  $a = Get-Acl -LiteralPath $NET; $o.networkSddlBefore = $a.Sddl
  # only when apply added it (root passes -RemoveNetworkAce from apply's own receipt): never a pre-existing identical entry
  if ($RemoveNetworkAce) { $a.RemoveAccessRuleSpecific($rule); Set-Acl -LiteralPath $NET -AclObject $a; $o.networkSddlAfter = (Get-Acl -LiteralPath $NET).Sddl }
  if (Test-Path -LiteralPath $CH) {
    $other = @(Get-ChildItem -LiteralPath $CH -Force | Where-Object { $_.Name -ne 'challenge-front.json' -and $_.Name -notlike '.challenge-front.json.tmp-*' })
    if ($other.Count) { $o.decision = "REFUSED: the challenge dir holds other files ($($other.Count)): root decides"; $o | ConvertTo-Json -Compress; exit 0 }
    Remove-Item -LiteralPath $CH -Recurse -Force }
  $o.challengeGone = -not (Test-Path -LiteralPath $CH); $o.decision = 'rolled back'
}
$o | ConvertTo-Json -Compress
