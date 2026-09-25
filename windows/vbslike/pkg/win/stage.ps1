# stage.ps1 -- finish staging one package directory on the box (windows/vbslike/pkg/README.md).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\claude\vbs-like\pkg\<id16>\win\stage.ps1 -ManifestSha256 <64 hex>
#
# push.sh has already copied the small files. This script, and nothing else, then:
#   1. copies each file the manifest marks boxReuse from where the box already holds it (the 125 MB image, the
#      monitor initrd, the WSL kernel, the launcher), ONLY after that source hashes to the pin;
#   2. grants the VM worker account (S-1-5-83-0) read on the files in vmWorkerRead -- the IGVM -- with icacls;
#   3. verifies the whole directory exactly as check.ps1 does, and writes staged.json beside MANIFEST.json.
# It writes nowhere but this package directory. It enables no feature, changes no host setting, starts no VM, and
# does not touch C:\Users\claude\vbs\node or \vbs\ee. Exit 0 = staged and verified, 1 = not.
param(
  [Parameter(Mandatory = $true)][string]$ManifestSha256,
  [string]$Dir = ''                 # default: the package directory this script sits in
)
$ErrorActionPreference = 'Stop'
# $PSScriptRoot is empty in a param() default under Windows PowerShell 5.1 -File, so it is read here
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'pkg.lib.ps1')
if (-not $Dir) { $Dir = Split-Path -Parent $here }

$R = New-Results
$Dir = Resolve-PkgDir $Dir
$M = Read-PkgManifest $R $Dir $ManifestSha256
if (-not $M) { Write-Results $R; 'FAIL stage: the manifest is not the one named'; exit 1 }

$copied = @()
foreach ($f in $M.files) {
  if (-not (Test-PkgPathSafe $f.path)) { continue }                 # reported by Test-PkgFiles below
  $dst = Get-PkgFilePath $Dir $f.path
  if ((Test-Path -LiteralPath $dst) -or -not ($f.PSObject.Properties.Name -contains 'boxReuse')) { continue }
  $src = [string]$f.boxReuse
  if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { [void](Add-Result $R $false "reuse $($f.path)" "$src is absent"); continue }
  $h = Get-Sha256 $src
  if ($h -ne $f.sha256) { [void](Add-Result $R $false "reuse $($f.path)" "$src hashes to $h, pinned $($f.sha256): not copied"); continue }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Copy-Item -LiteralPath $src -Destination $dst
  $copied += $f.path
  [void](Add-Result $R $true "reuse $($f.path)" "copied from $src after it hashed to the pin")
}

foreach ($p in @($M.vmWorkerRead)) {
  $file = Get-PkgFilePath $Dir $p
  if (-not (Test-Path -LiteralPath $file)) { continue }              # reported missing by Test-PkgFiles
  $out = & icacls.exe $file /grant "*$($script:VmWorkerSid):(R)" 2>&1
  [void](Add-Result $R ($LASTEXITCODE -eq 0) "grant the VM worker read on $p" $(if ($LASTEXITCODE -eq 0) { '' } else { "icacls: $out" }))
}

# Boot media are read-only on disk: the guest cannot write them, and now neither can a stray host write go unnoticed
# (a later check sees a hash mismatch, not a silently changed medium). Roles guest.uefi-medium, guest.uefi-fallback, probe.uefi-medium.
foreach ($f in @($M.files | Where-Object { $_.role -eq 'guest.uefi-medium' -or $_.role -eq 'guest.uefi-fallback' -or $_.role -eq 'probe.uefi-medium' })) {
  $file = Get-PkgFilePath $Dir $f.path
  if (Test-Path -LiteralPath $file) { Set-ItemProperty -LiteralPath $file -Name IsReadOnly -Value $true; [void](Add-Result $R $true "read-only attribute on $($f.path)") }
}

# The npm tree for the box acceptance harness: each pinned tarball unpacked to its lockfile position under npmTree.root
# (nested where npm nests it), with tar.exe from System32. Inside this package directory only.
if ($M.PSObject.Properties.Name -contains 'npmTree') {
  $t = $M.npmTree; $n = 0
  foreach ($p in $t.packages) {
    $tgz = Get-PkgFilePath $Dir $p.file
    $dst = Get-PkgFilePath $Dir ("$($t.root)/" + ($p.dir -replace '^node_modules/', ''))
    if (-not (Test-Path -LiteralPath $tgz)) { [void](Add-Result $R $false "unpack $($p.name)@$($p.version)" "$($p.file) missing"); continue }
    if ((Get-Sha256 $tgz) -ne $p.sha256) { [void](Add-Result $R $false "unpack $($p.name)@$($p.version)" 'the tarball does not hash to its pin: not unpacked'); continue }
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    & tar.exe -xzf $tgz -C $dst --strip-components=1 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { [void](Add-Result $R $false "unpack $($p.name)@$($p.version)" "tar exit $LASTEXITCODE"); continue }
    $n++
  }
  [void](Add-Result $R ($n -eq @($t.packages).Count) 'npm tree unpacked from the pinned tarballs' "$n/$(@($t.packages).Count)")
}

Test-PkgFiles $R $Dir $M
Test-NpmTree $R $Dir $M
foreach ($p in @($M.vmWorkerRead)) { Test-VmWorkerRead $R (Get-PkgFilePath $Dir $p) $p }

$ok = Test-ResultsOk $R
$receipt = [ordered]@{
  type = 'enclave-vbslike-package-staged/1'; manifestSha256 = $ManifestSha256.ToLower(); ok = $ok
  stagedAtUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); by = "$env:USERDOMAIN\$env:USERNAME"
  copiedFromBox = $copied
  results = @($R | ForEach-Object { [ordered]@{ ok = $_.Ok; name = $_.Name; detail = $_.Detail } })
}
[System.IO.File]::WriteAllText((Join-Path $Dir 'staged.json'), ($receipt | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Write-Results $R
if ($ok) {
  "STAGED $($M.name) v$($M.version) $($ManifestSha256.ToLower())"
  "next:  powershell -NoProfile -ExecutionPolicy Bypass -File $Dir\win\check.ps1 -ManifestSha256 $($ManifestSha256.ToLower())"
  exit 0
}
'FAIL stage: see the FAIL lines; staged.json records them'
exit 1
