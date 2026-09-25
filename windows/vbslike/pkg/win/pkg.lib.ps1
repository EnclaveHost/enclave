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
    $tag = if ($r.Kind -eq 'info') { 'info   ' } elseif ($r.Ok) { 'ok     ' } elseif ($r.Kind -eq 'blocked') { 'BLOCKED' } else { 'FAIL   ' }
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
    # the npm tree stage.ps1 assembles from the pinned tarballs lives under the manifest's npmTree.root
    if (($M.PSObject.Properties.Name -contains 'npmTree') -and $rel.StartsWith($M.npmTree.root + '/')) { continue }
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
  # a host setting that was MEASURED to gate the profile (the manifest says how): absent or different = BLOCKED.
  # Read here, never written: setting one is the host owner's decision, not a script's.
  if ($hc.PSObject.Properties.Name -contains 'registry') {
    foreach ($g in @($hc.registry)) {
      $v = $null
      try { $v = (Get-ItemProperty -LiteralPath $g.path -Name $g.name -ErrorAction Stop).($g.name) } catch { $v = $null }
      $ok = ($null -ne $v) -and ([string]$v -eq [string]$g.value); if (-not $ok) { $ready = $false }
      [void](Add-Result $R $ok "[$Boot] $($g.name)" $(if ($ok) { "= $v" } else { "$(if ($null -eq $v) { 'absent' } else { "= $v" }), needs $($g.value): $($g.why)" }) 'blocked')
    }
  }
  # a file this HOST supplies, named and hash-pinned by the manifest but not shipped (the launcher hashes it again at
  # use): absent or different = BLOCKED. Read here, never written.
  if ($hc.PSObject.Properties.Name -contains 'boxFiles') {
    foreach ($b in @($hc.boxFiles)) {
      $h = $null
      if (Test-Path -LiteralPath $b.path -PathType Leaf) { try { $h = Get-Sha256 $b.path } catch { $h = $null } }
      $ok = ($null -ne $h) -and ($h -eq $b.sha256); if (-not $ok) { $ready = $false }
      $why = ''; if (@($b.PSObject.Properties.Name) -contains 'why') { $why = ": $($b.why)" }
      [void](Add-Result $R $ok "[$Boot] box file $($b.name)" $(if ($ok) { "$($b.path) sha256 $h" } elseif ($null -eq $h) { "absent at $($b.path)$why" } else { "$($b.path) hashes $h, not the pinned $($b.sha256)" }) 'blocked')
    }
  }
  # recorded, never gating: a setting someone suspects matters, whose role is not established
  if ($hc.PSObject.Properties.Name -contains 'info') {
    foreach ($g in @($hc.info)) {
      $v = $null
      try { $v = (Get-ItemProperty -LiteralPath $g.path -Name $g.name -ErrorAction Stop).($g.name) } catch { $v = $null }
      [void](Add-Result $R $true "[$Boot] $($g.name)" "$(if ($null -eq $v) { 'absent' } else { "= $v" }) ($($g.note))" 'info')
    }
  }
  return $ready
}

# The assembled npm tree: each pinned package present at its lockfile position with its name and version.
function Test-NpmTree($R, [string]$Dir, $M) {
  if (-not ($M.PSObject.Properties.Name -contains 'npmTree')) { return }
  $t = $M.npmTree; $ok = 0
  foreach ($p in $t.packages) {
    $pj = Get-PkgFilePath $Dir ("$($t.root)/" + ($p.dir -replace '^node_modules/', '') + '/package.json')
    $v = $null; if (Test-Path -LiteralPath $pj) { try { $v = Get-Content -LiteralPath $pj -Raw | ConvertFrom-Json } catch { } }
    if ($v -and $v.name -eq $p.name -and $v.version -eq $p.version) { $ok++ } else { [void](Add-Result $R $false "npm tree: $($p.name)@$($p.version)" $(if ($v) { "found $($v.name)@$($v.version)" } else { 'absent: run stage.ps1' })) }
  }
  [void](Add-Result $R ($ok -eq @($t.packages).Count) 'npm tree: every pinned package at its lockfile position' "$ok/$(@($t.packages).Count)")
}

function Get-PkgApp($M, [string]$Name) { return @($M.apps | Where-Object { $_.name -eq $Name })[0] }

# Will the manager in $MgrDir create its VM so Hyper-V even considers our IGVM? win\manager-check.mjs runs that
# manager's own start() on a recording fake host (nothing touches Hyper-V) and reads the New-VM it issued. A stale
# manager passes every hash check and still reproduces the silent guest, which is why this is asked of its code.
function Test-ManagerCreatesIsolated($R, [string]$Dir, $M, [string]$MgrDir, [string]$Name) {
  $app = @($M.apps | Where-Object { $_.servable })[0]
  $ig = @($M.files | Where-Object { $_.path -eq $M.profiles.igvm.image })[0]
  $line = & node (Get-PkgFilePath $Dir $M.profiles.igvm.manager.check) $MgrDir --record (Get-PkgFilePath $Dir "$($app.dir)/record.json") --component (Get-PkgFilePath $Dir "$($app.dir)/component.wasm") --image-sha256 $ig.sha256 2>&1 | Select-Object -Last 1
  $j = $null; try { $j = "$line" | ConvertFrom-Json } catch { }
  $ok = $j -and $j.ok -eq $true
  [void](Add-Result $R $ok $Name $(if ($ok) { "$(if ("$($j.isolation)" -match '^[0-9]+$') { 'New-CustomVM' } else { 'New-VM' }) -GuestStateIsolationType $($j.isolation)$(if ($j.secureBootOff) { ', Secure Boot off' })" } elseif ($j) { $j.reason } else { "$line" }))
}

function Get-BytesSha256([byte[]]$B) {
  $h = [System.Security.Cryptography.SHA256]::Create()
  try { return ([System.BitConverter]::ToString($h.ComputeHash($B)) -replace '-', '').ToLower() } finally { $h.Dispose() }
}

# One HTTP answer, through curl.exe (in the box's System32). -k: the app's TLS ends INSIDE the domain on its own key,
# which this tier does not attest; the check here is the ANSWER, tied to the bytes by the guest's AppID, not the key.
# BodySha256 is over the exact bytes received: an answer is compared to the byte, never trimmed.
function Invoke-PkgGet([string]$Url, [string]$BodyFile) {
  if (Test-Path -LiteralPath $BodyFile) { Remove-Item -LiteralPath $BodyFile }
  $code = & curl.exe -sk --max-time 20 -o $BodyFile -w '%{http_code}' $Url 2>$null
  $raw = if (Test-Path -LiteralPath $BodyFile) { [System.IO.File]::ReadAllBytes($BodyFile) } else { [byte[]]@() }
  return [pscustomobject]@{ Status = [int]("0$code"); Body = [System.Text.Encoding]::UTF8.GetString($raw); BodySha256 = (Get-BytesSha256 $raw); Exit = $LASTEXITCODE }
}

# One HTTPS request on its OWN TLS session, returning the certificate that session saw. The domain's certificate is
# self-signed on the domain's own key; what ties that key to the app is the judged document (judge-hv binds
# report_data to THIS handshake's SPKI and our nonce), never a CA -- so the certificate is recorded, not validated.
# HTTP/1.1 with Connection: close; a chunked body (wasmtime serve answers chunked) is de-chunked.
function Invoke-TlsRequest([string]$HostName, [int]$Port, [string]$Path, [int]$TimeoutMs = 15000) {
  $tcp = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $tcp.BeginConnect($HostName, $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { throw "connect ${HostName}:$Port timed out" }
    $tcp.EndConnect($iar)
    $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, ([System.Net.Security.RemoteCertificateValidationCallback]{ $true }))
    $ssl.ReadTimeout = $TimeoutMs; $ssl.WriteTimeout = $TimeoutMs
    $protos = [System.Security.Authentication.SslProtocols]::Tls12
    try { $protos = $protos -bor [System.Security.Authentication.SslProtocols]'Tls13' } catch { }
    $ssl.AuthenticateAsClient($HostName, $null, $protos, $false)
    $cert = [System.Convert]::ToBase64String($ssl.RemoteCertificate.GetRawCertData())
    $req = [System.Text.Encoding]::ASCII.GetBytes("GET $Path HTTP/1.1`r`nHost: $HostName`r`nAccept: */*`r`nConnection: close`r`n`r`n")
    $ssl.Write($req, 0, $req.Length); $ssl.Flush()
    $ms = New-Object System.IO.MemoryStream; $buf = New-Object byte[] 65536
    try { while (($n = $ssl.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) } } catch [System.IO.IOException] { if ($ms.Length -eq 0) { throw } }
    $all = $ms.ToArray()
  } finally { $tcp.Close() }
  $sep = -1
  for ($i = 0; $i -le $all.Length - 4; $i++) { if ($all[$i] -eq 13 -and $all[$i + 1] -eq 10 -and $all[$i + 2] -eq 13 -and $all[$i + 3] -eq 10) { $sep = $i; break } }
  if ($sep -lt 0) { throw "no HTTP response header from ${HostName}:$Port$Path ($($all.Length) bytes)" }
  $lines = [System.Text.Encoding]::ASCII.GetString($all, 0, $sep) -split "`r`n"
  $status = [int](($lines[0] -split ' ')[1])
  $h = @{}; foreach ($l in @($lines | Select-Object -Skip 1)) { $k = $l.IndexOf(':'); if ($k -gt 0) { $h[$l.Substring(0, $k).Trim().ToLower()] = $l.Substring($k + 1).Trim() } }
  $rest = New-Object byte[] ($all.Length - $sep - 4); [Array]::Copy($all, $sep + 4, $rest, 0, $rest.Length)
  if ($h['transfer-encoding'] -eq 'chunked') {
    $out = New-Object System.IO.MemoryStream; $p = 0
    while ($p -lt $rest.Length) {
      $e = $p; while ($e -lt $rest.Length - 1 -and -not ($rest[$e] -eq 13 -and $rest[$e + 1] -eq 10)) { $e++ }
      $size = [Convert]::ToInt32((([System.Text.Encoding]::ASCII.GetString($rest, $p, $e - $p)) -split ';')[0].Trim(), 16)
      if ($size -eq 0) { break }
      $out.Write($rest, $e + 2, $size); $p = $e + 2 + $size + 2
    }
    $body = $out.ToArray()
  } elseif ($h.ContainsKey('content-length')) {
    $len = [Math]::Min([int]$h['content-length'], $rest.Length); $body = New-Object byte[] $len; [Array]::Copy($rest, 0, $body, 0, $len)
  } else { $body = $rest }
  return [pscustomobject]@{ Status = $status; Headers = $h; Body = [System.Text.Encoding]::UTF8.GetString($body); BodySha256 = (Get-BytesSha256 $body); CertB64 = $cert }
}
