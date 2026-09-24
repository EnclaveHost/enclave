# pkg.lib.ps1 -- shared by stage.ps1, check.ps1 and smoke-hcs.ps1 (windows/vbslike/pkg/README.md).
# Windows PowerShell 5.1, as the box has it. Nothing here writes; the callers say what they write and where.
Set-StrictMode -Version 2

$script:StageRoot   = 'C:\Users\claude\vbs-like\pkg'
$script:VmWorkerSid = 'S-1-5-83-0'          # NT VIRTUAL MACHINE\Virtual Machines: the account a VM worker reads files as
$script:PkgType     = 'enclave-vbslike-package/1'
# operator scratch inside a package directory; everything else in it must be a file of the manifest
$script:ScratchTop  = @('staged.json', 'runs', 'fetched', '.selftest')

function New-Results { return ,(New-Object System.Collections.ArrayList) }

# Kind: '' = a check of the package (a failure fails the run), 'blocked' = a host prerequisite that is not met
# (reported, never folded into the package verdict), 'info' = recorded only.
function Add-Result($R, [bool]$Ok, [string]$Name, [string]$Detail = '', [string]$Kind = '') {
  [void]$R.Add([pscustomobject]@{ Ok = $Ok; Name = $Name; Detail = $Detail; Kind = $Kind })
  return $Ok
}

function Write-Results($R) {
  foreach ($r in $R) {
    $tag = if ($r.Ok) { 'ok     ' } elseif ($r.Kind -eq 'blocked') { 'BLOCKED' } elseif ($r.Kind -eq 'info') { 'info   ' } else { 'FAIL   ' }
    if ($r.Detail) { "$tag $($r.Name): $($r.Detail)" } else { "$tag $($r.Name)" }
  }
}

function Test-ResultsOk($R) { return -not @($R | Where-Object { -not $_.Ok -and $_.Kind -eq '' }).Count }

function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower() }

# A package directory is a DIRECT child of the stage root, named by the first 16 hex of the manifest's sha256.
function Resolve-PkgDir([string]$Dir) {
  $full = [System.IO.Path]::GetFullPath($Dir).TrimEnd('\')
  $parent = [System.IO.Path]::GetDirectoryName($full)
  if ($parent -ne $script:StageRoot) { throw "refusing: $full is not a package directory under $script:StageRoot" }
  return $full
}

function Test-PkgPathSafe([string]$P) {
  if ($P -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$') { return $false }
  foreach ($s in $P.Split('/')) { if ($s -eq '..' -or $s -eq '.' -or $s -eq '') { return $false } }
  return $true
}

function Get-PkgFilePath([string]$Dir, [string]$P) { return Join-Path $Dir ($P -replace '/', '\') }

# The operator names the manifest by its FULL sha256, copied from the commit: the box is never the authority on it.
function Read-PkgManifest($R, [string]$Dir, [string]$ManifestSha256) {
  $want = $ManifestSha256.ToLower()
  if ($want -notmatch '^[0-9a-f]{64}$') { [void](Add-Result $R $false 'manifest id' "-ManifestSha256 must be 64 hex, got '$ManifestSha256'"); return $null }
  $leaf = Split-Path $Dir -Leaf
  if ($leaf -ne $want.Substring(0, 16)) { [void](Add-Result $R $false 'manifest id' "the directory is $leaf, the manifest id starts $($want.Substring(0, 16))"); return $null }
  $p = Join-Path $Dir 'MANIFEST.json'
  if (-not (Test-Path -LiteralPath $p)) { [void](Add-Result $R $false 'manifest id' "no MANIFEST.json in $Dir"); return $null }
  $h = Get-Sha256 $p
  if ($h -ne $want) { [void](Add-Result $R $false 'manifest id' "MANIFEST.json hashes to $h, not $want"); return $null }
  $m = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($m.type -ne $script:PkgType) { [void](Add-Result $R $false 'manifest id' "type is '$($m.type)', not $script:PkgType"); return $null }
  [void](Add-Result $R $true 'manifest id' "$($m.name) v$($m.version), $want")
  return $m
}

# Every file of the manifest present with its pinned hash, and nothing else outside the operator's scratch.
function Test-PkgFiles($R, [string]$Dir, $M) {
  $want = @{}
  foreach ($f in $M.files) {
    if (-not (Test-PkgPathSafe $f.path)) { [void](Add-Result $R $false "file $($f.path)" 'not a plain relative path'); continue }
    $want[$f.path] = $f
    $p = Get-PkgFilePath $Dir $f.path
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { [void](Add-Result $R $false "file $($f.path)" 'missing'); continue }
    $h = Get-Sha256 $p
    [void](Add-Result $R ($h -eq $f.sha256) "file $($f.path)" $(if ($h -eq $f.sha256) { '' } else { "hashes to $h, pinned $($f.sha256)" }))
  }
  $extra = @()
  foreach ($x in Get-ChildItem -LiteralPath $Dir -Recurse -File -Force) {
    $rel = $x.FullName.Substring($Dir.Length + 1) -replace '\\', '/'
    $top = $rel.Split('/')[0]
    if ($rel -eq 'MANIFEST.json' -or $want.ContainsKey($rel) -or $script:ScratchTop -contains $top) { continue }
    $extra += $rel
  }
  [void](Add-Result $R ($extra.Count -eq 0) 'no file outside the manifest' $(if ($extra.Count) { 'extra: ' + ($extra -join ', ') } else { '' }))
}

function Test-VmWorkerRead($R, [string]$Path, [string]$Name) {
  $sid = New-Object System.Security.Principal.SecurityIdentifier($script:VmWorkerSid)
  $read = [System.Security.AccessControl.FileSystemRights]::Read
  $ok = $false
  if (Test-Path -LiteralPath $Path) {
    foreach ($a in (Get-Acl -LiteralPath $Path).Access) {
      try { $s = $a.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) } catch { continue }
      if ($s -eq $sid -and $a.AccessControlType -eq 'Allow' -and (($a.FileSystemRights -band $read) -eq $read)) { $ok = $true }
    }
  }
  [void](Add-Result $R $ok "the VM worker account can read $Name" $(if ($ok) { '' } else { "no Allow Read for $script:VmWorkerSid (the launch fails 0x80070005)" }))
}

# What each profile needs from the host, read-only, as the manifest states it. Not met = BLOCKED, not FAIL.
function Test-HostProfile($R, $M, [string]$Boot) {
  $hc = $M.hostChecks.$Boot
  $ready = $true
  if ($hc.PSObject.Properties.Name -contains 'features') {
    foreach ($f in $hc.features.PSObject.Properties) {
      $st = ''
      try { $st = [string](Get-WindowsOptionalFeature -Online -FeatureName $f.Name -ErrorAction Stop).State } catch { $st = "unreadable: $($_.Exception.Message)" }
      $ok = $st -eq $f.Value; if (-not $ok) { $ready = $false }
      [void](Add-Result $R $ok "[$Boot] feature $($f.Name)" $(if ($ok) { $st } else { "is $st, needs $($f.Value)" }) 'blocked')
    }
  }
  if ($hc.PSObject.Properties.Name -contains 'services') {
    foreach ($s in $hc.services.PSObject.Properties) {
      $x = Get-Service $s.Name -ErrorAction SilentlyContinue
      $st = if ($x) { [string]$x.Status } else { 'NOT INSTALLED' }
      $ok = $st -eq $s.Value; if (-not $ok) { $ready = $false }
      [void](Add-Result $R $ok "[$Boot] service $($s.Name)" $(if ($ok) { $st } else { "is $st, needs $($s.Value)" }) 'blocked')
    }
  }
  if ($hc.PSObject.Properties.Name -contains 'wmi') {
    $w = $hc.wmi
    $props = $null
    try { $props = @((Get-CimClass -Namespace $w.namespace -ClassName $w.class -ErrorAction Stop).CimClassProperties.Name) } catch { $props = $null }
    $ok = ($null -ne $props) -and ($props -contains $w.property); if (-not $ok) { $ready = $false }
    [void](Add-Result $R $ok "[$Boot] WMI $($w.namespace) $($w.class).$($w.property)" $(if ($ok) { '' } elseif ($null -eq $props) { 'namespace or class absent' } else { 'property absent' }) 'blocked')
  }
  if ($hc.PSObject.Properties.Name -contains 'commands') {
    foreach ($c in $hc.commands) {
      $ok = [bool](Get-Command $c -ErrorAction SilentlyContinue); if (-not $ok) { $ready = $false }
      [void](Add-Result $R $ok "[$Boot] command $c" $(if ($ok) { '' } else { 'absent' }) 'blocked')
    }
  }
  return $ready
}

function Get-PkgApp($M, [string]$Name) { return @($M.apps | Where-Object { $_.name -eq $Name })[0] }

# One HTTP answer, through curl.exe (in the box's System32). -k: the app's TLS ends INSIDE the domain on its own key,
# which this tier does not attest; the check here is the ANSWER, tied to the bytes by the guest's AppID, not the key.
function Invoke-PkgGet([string]$Url, [string]$BodyFile) {
  $code = & curl.exe -sk --max-time 20 -o $BodyFile -w '%{http_code}' $Url 2>$null
  $body = if (Test-Path -LiteralPath $BodyFile) { [System.IO.File]::ReadAllText($BodyFile, [System.Text.Encoding]::UTF8) } else { '' }
  return [pscustomobject]@{ Status = [int]("0$code"); Body = $body; Exit = $LASTEXITCODE }
}
