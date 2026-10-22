function Sha($p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
function ProtectedTemp($ref, $tag) {
  $acl = Get-Acl -LiteralPath $ref; $tmp = $ref + $tag + [guid]::NewGuid().ToString('N').Substring(0, 8)
  [IO.File]::WriteAllBytes($tmp, [byte[]]@())
  try { Set-Acl -LiteralPath $tmp -AclObject $acl
        if ((Get-Acl -LiteralPath $tmp).Sddl -ne $acl.Sddl -or (Get-Item -LiteralPath $tmp).Length -ne 0) { throw 'the temp file does not carry the config ACL' } }
  catch { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }; throw }
  return $tmp }
function CasWrite($path, $expect, [byte[]]$bytes) {
  if ((Sha $path) -ne $expect) { throw "CAS refused: $path is not the expected sha" }
  $acl = Get-Acl -LiteralPath $path; $tmp = ProtectedTemp $path '.nh-'
  try { [IO.File]::WriteAllBytes($tmp, $bytes); if ((Sha $path) -ne $expect) { throw "CAS refused: $path changed during the write" }
        [IO.File]::Replace($tmp, $path, [NullString]::Value); Set-Acl -LiteralPath $path -AclObject $acl }
  finally { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force } }
  return [ordered]@{ after = (Sha $path); aclKept = ((Get-Acl -LiteralPath $path).Sddl -eq $acl.Sddl) } }
