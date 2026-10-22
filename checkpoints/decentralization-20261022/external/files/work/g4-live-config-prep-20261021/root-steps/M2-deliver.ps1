# M2-deliver.ps1 - ROOT-RUN MUTATION (Windows PowerShell 5.1, elevated). Delivers the reviewed challenge-replica release and the
# reviewed authority profile into a NEW directory under Program Files (it inherits Program Files' ACL: SYSTEM, Administrators,
# TrustedInstaller write; Users read). The files come from -Staging, a protected staging dir root's transport already filled
# (scp + sha check, as in root's other kits); every file is checked at the source AND at the target.
#   -Mode apply     refuses if the target exists; copies; verifies; reads back the writers of the new dirs
#   -Mode rollback  removes the target ONLY if it holds exactly these 4 files with these shas, else refuses (root decides)
param([ValidateSet('apply', 'rollback')][string]$Mode = 'apply', [string]$Staging = '')
$ErrorActionPreference = 'Stop'
$T = 'C:\Program Files\Enclave\network\challenge-replica'; $R = Join-Path $T 'release-3e1560f94542'
$FILES = [ordered]@{
  'dns.mjs'                    = @($R, '3e1560f94542f57fb4c93aa6008ec35711fb21439c8adb74c9ee72fc22c90574')
  'network-runtime.bundle.mjs' = @($R, '3de76b54cf64fc06b5965bcc989290d6653de6e4f6e59f00b0da52e39218d76a')
  'dns.mjs.manifest.json'      = @($R, 'aa1ebdb591e15866d30061ae41704c6532ff6ec03a882f920c99058a3bd41bbf')
  'network-profile-base.json'  = @($T, 'ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8') }
function Sha($p) { if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
function Writers($p) { $a = Get-Acl -LiteralPath $p
  @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' -and -not ([int]$_.PropagationFlags -band 2) -and ([int]$_.FileSystemRights -band 0x500D0156) } |
    ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique) }
$o = [ordered]@{ mode = $Mode; at = [DateTime]::UtcNow.ToString('o') }
if ($Mode -eq 'apply') {
  if (Test-Path -LiteralPath $T) { $o.decision = 'REFUSED: the target exists'; $o | ConvertTo-Json -Compress; exit 0 }
  foreach ($n in $FILES.Keys) { if ((Sha (Join-Path $Staging $n)) -ne $FILES[$n][1]) { $o.decision = "REFUSED: staged $n is not the pinned sha"; $o | ConvertTo-Json -Compress; exit 0 } }
  [void][IO.Directory]::CreateDirectory($R)
  foreach ($n in $FILES.Keys) { Copy-Item -LiteralPath (Join-Path $Staging $n) -Destination (Join-Path $FILES[$n][0] $n) }
  $o.files = [ordered]@{}; foreach ($n in $FILES.Keys) { $o.files[$n] = (Sha (Join-Path $FILES[$n][0] $n)) -eq $FILES[$n][1] }
  $o.writers = [ordered]@{ target = (Writers $T); release = (Writers $R) }
  $o.writersOk = -not @(@($o.writers.target) + @($o.writers.release) | Where-Object { $_ -notin @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') }).Count
  $o.decision = $(if (-not @($o.files.Values | Where-Object { -not $_ }).Count -and $o.writersOk) { 'applied' } else { 'CHECK: a file or the inherited ACL is not as expected (see fields); rollback is -Mode rollback' })
} else {
  if (-not (Test-Path -LiteralPath $T)) { $o.decision = 'nothing to roll back'; $o | ConvertTo-Json -Compress; exit 0 }
  $all = @(Get-ChildItem -LiteralPath $T -Recurse -Force -File); $ok = $all.Count -eq $FILES.Count
  foreach ($n in $FILES.Keys) { if ((Sha (Join-Path $FILES[$n][0] $n)) -ne $FILES[$n][1]) { $ok = $false } }
  if (-not $ok) { $o.decision = 'REFUSED: the target holds other or changed files: root decides'; $o | ConvertTo-Json -Compress; exit 0 }
  Remove-Item -LiteralPath $T -Recurse -Force; $o.gone = -not (Test-Path -LiteralPath $T); $o.decision = 'rolled back'
}
$o | ConvertTo-Json -Compress
