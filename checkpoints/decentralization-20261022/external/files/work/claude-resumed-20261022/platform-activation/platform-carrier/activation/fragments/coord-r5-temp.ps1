# platform-carrier r5 (review of config-persistence-r3's file-safety rules against this path): base PrivDir 333-336 and ProtectedTemp
# 337-344, with two changes. (1) An EXISTING private directory is used only if it is protected, SYSTEM/Administrators-only and not a
# reparse point (the base trusted any existing one). (2) The temp is created EXCLUSIVELY (CreateNew): a file or link already at that
# name is never truncated, written through or deleted (the base's WriteAllBytes created-or-truncated, and its catch removed
# whatever sat there). The owner/DACL rule is unchanged: Set-Acl gives the temp the config's exact security descriptor (owner
# included), verified by full SDDL BEFORE any byte; after File.Replace (whose result takes the REPLACEMENT's owner) CasWrite
# re-applies and re-verifies the full SDDL, so the hook's owner and DACL are both kept (native: cutover 03:37Z aclKept=true).
function PrivDir { if ($TR) { [void][IO.Directory]::CreateDirectory($PRIV); return }   # mock harness only (no Windows ACL API)
  if (-not (Test-Path -LiteralPath $PRIV)) { $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetAccessRuleProtection($true, $false)
    foreach ($s in $ADMIN_SIDS) { $ds.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $s), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }
    [void][IO.Directory]::CreateDirectory($PRIV, $ds); return }
  $a = Get-Acl -LiteralPath $PRIV
  $other = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -ne 'Allow' -or $ADMIN_SIDS -notcontains $_.IdentityReference.Value })
  if (-not $a.AreAccessRulesProtected -or $other.Count -or ([int](Get-Item -LiteralPath $PRIV -Force).Attributes -band [int][IO.FileAttributes]::ReparsePoint) -or $ADMIN_SIDS -notcontains $a.GetOwner([Security.Principal.SecurityIdentifier]).Value) {
    throw 'the existing private backup directory is not protected SYSTEM/Administrators-only (or is a reparse point): nothing is written into it' } }
# an EMPTY temp beside $ref, created EXCLUSIVELY, that carries $ref's exact security descriptor BEFORE any byte is written into it
function ProtectedTemp($ref, $tag) {
  $acl = Get-Acl -LiteralPath $ref; $tmp = $ref + $tag + [guid]::NewGuid().ToString('N').Substring(0, 8)
  $fs = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write); $fs.Close()   # throws if the name exists: nothing created or deleted
  try { Set-Acl -LiteralPath $tmp -AclObject $acl
        if ((Get-Acl -LiteralPath $tmp).Sddl -ne $acl.Sddl -or (Get-Item -LiteralPath $tmp).Length -ne 0) { throw 'the temp file does not carry the config ACL' } }
  catch { Remove-Item -LiteralPath $tmp -Force; throw }                                         # only the temp this call created
  return $tmp }
