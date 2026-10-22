# THE CUSTODY CALLBACK KEY (windows/vbslike/manager/custody-key-file.mjs): the HMAC key the manager and the node share for
# direct Shield custody answers. Created when ABSENT, private from its first byte: a protected DACL granting only SYSTEM and
# Administrators, owner Administrators, applied by the same call that creates it. An EXISTING file is checked by the same
# rule the manager and node apply at start and reported if it is not private: never changed here. Inert until the explicit
# activation sets ENCLAVE_CUSTODY_CALLBACK_KEY_FILE (and ENCLAVE_SHIELD_CUSTODY_V2); no other file is touched.
$ckey = Join-Path $PD "shield\custody-callback.key"
if (-not (Test-Path -LiteralPath $ckey)) {
  $kb = New-Object byte[] 32; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($kb); $rng.Dispose()
  $sec = New-Object System.Security.AccessControl.FileSecurity
  $sec.SetAccessRuleProtection($true, $false)
  foreach ($sid in "S-1-5-18", "S-1-5-32-544") {
    $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier $sid), "FullControl", "Allow")))
  }
  $sec.SetOwner((New-Object System.Security.Principal.SecurityIdentifier "S-1-5-32-544"))
  $hex = [Text.Encoding]::ASCII.GetBytes((($kb | ForEach-Object { $_.ToString("x2") }) -join ""))
  $fsk = [System.IO.File]::Create($ckey, 4096, [System.IO.FileOptions]::None, $sec)
  try { $fsk.Write($hex, 0, $hex.Length) } finally { $fsk.Dispose() }
  [Array]::Clear($kb, 0, $kb.Length); [Array]::Clear($hex, 0, $hex.Length)
  Emit "files" "run" "Created the custody callback key $ckey (SYSTEM and Administrators only; inert until activation)"
} else {
  $acl = Get-Acl -LiteralPath $ckey
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $open = @($acl.Access | Where-Object { $_.AccessControlType -eq "Allow" -and @("S-1-5-18", "S-1-5-32-544") -notcontains $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value })
  $nullDacl = $acl.GetSecurityDescriptorSddlForm("Access") -notmatch "D:" -or $acl.GetSecurityDescriptorSddlForm("Access") -match "D:[A-Z]*NO_ACCESS_CONTROL"
  if ($open.Count -or $nullDacl -or @("S-1-5-18", "S-1-5-32-544") -notcontains $owner) {
    Emit "files" "warn" ("The custody callback key $ckey is NOT private (owner $owner" + $(if ($open.Count) { "; allowed to $($open[0].IdentityReference)" } else { "" }) +
                         "): left unchanged, and the manager and node refuse it until it is SYSTEM and Administrators only")
  }
}
