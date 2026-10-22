# Enclave host for Windows -- the one-line install:
#
#   irm https://get.enclave.host/host.ps1 | iex
#
# With a referral code (attribution only; setup shows it, and it can be changed there):
#
#   $env:ENCLAVE_REFERRAL="code"; irm https://get.enclave.host/host.ps1 | iex
#
# Downloads EnclaveSetup.exe (named, with its sha256, by https://get.enclave.host/windows/latest.json), refuses it unless
# it hashes to the published value, and starts it (it asks for administrator rights: it turns on Hyper-V and installs
# services). Setup then downloads and checks the host bundle itself. See docs/design/windows-host-installer.md.
# That latest.json is UNSIGNED: its hash proves the download is what get.enclave.host published, not who published it.
#
# SIGNED, with release keys and mirrors YOU choose (docs/network/independent-windows.md):
#
#   $env:ENCLAVE_RELEASE_KEYS="ecdsa-p256:MFkw..."                           # comma-separated; the policy's keys
#   $env:ENCLAVE_RELEASE_MIRRORS="https://m1.example/windows/,https://m2.example/windows/"
#   $env:ENCLAVE_RELEASE_THRESHOLD="1"; $env:ENCLAVE_RELEASE_CHANNEL="stable"  # optional (these are the defaults)
#   irm <a copy of this script you trust> | iex
#
# Then setup runs only if a statement signed by those key(s), to the threshold, names it with its size and sha256, from
# whichever mirror proves the highest version; get.enclave.host is not asked. Setup is handed the same release policy
# (--release-policy), so the bundle it installs and every later update are held to it. Nothing fetched verifies THIS
# script: read it, or run a copy you have checked.
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ref = "$env:ENCLAVE_REFERRAL".Trim()
if ($ref -and $ref -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$') { Write-Warning "ENCLAVE_REFERRAL is not a referral code (1-64 letters, digits, '.', '_' or '-'): setup starts without it"; $ref = "" }
$keys = @("$env:ENCLAVE_RELEASE_KEYS".Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$setupArgs = @()

if ($keys.Count) {
  # ---- the signed channel (windows/node/release-channel.mjs; the same constants as EnclaveSetup.cs ReleaseChannel) ----
  $mirrors = @("$env:ENCLAVE_RELEASE_MIRRORS".Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ } | ForEach-Object { if ($_.EndsWith("/")) { $_ } else { "$_/" } })
  if (-not $mirrors.Count) { throw "ENCLAVE_RELEASE_KEYS is set but ENCLAVE_RELEASE_MIRRORS is not: name the mirrors to fetch the signed release from" }
  foreach ($m in $mirrors) { if ($m -notmatch '^https://[^\s?#@]+/$') { throw "mirror '$m' must be an https URL" } }
  $channel = if ($env:ENCLAVE_RELEASE_CHANNEL) { "$env:ENCLAVE_RELEASE_CHANNEL".Trim() } else { "stable" }
  if ($channel -notmatch '^[a-z0-9][a-z0-9._-]{0,31}$') { throw "ENCLAVE_RELEASE_CHANNEL is not a channel name" }
  $threshold = if ($env:ENCLAVE_RELEASE_THRESHOLD) { [int]$env:ENCLAVE_RELEASE_THRESHOLD } else { 1 }
  $p256Prefix = "3059301306072a8648ce3d020106082a8648ce3d03010703420004"
  $hex = { param([byte[]] $b) ([BitConverter]::ToString($b)).Replace("-", "").ToLower() }
  $sha256 = [Security.Cryptography.SHA256]::Create()
  $pinned = @(foreach ($spec in $keys) {
    if ($spec -notmatch '^ecdsa-p256:([A-Za-z0-9+/]+={0,2})$') { throw "release key '$spec' is not ecdsa-p256:<base64 SPKI>" }
    $der = [Convert]::FromBase64String($Matches[1])
    if ($der.Length -ne 91 -or (& $hex $der[0..26]) -ne $p256Prefix) { throw "release key '$spec' is not an uncompressed P-256 public key" }
    # BCRYPT_ECCKEY_BLOB: "ECS1", key length 32, X, Y (the SPKI's last 64 bytes)
    $blob = New-Object byte[] 72
    [BitConverter]::GetBytes([int]0x31534345).CopyTo($blob, 0); [BitConverter]::GetBytes([int]32).CopyTo($blob, 4); [Array]::Copy($der, 27, $blob, 8, 64)
    [pscustomobject]@{ id = (& $hex $sha256.ComputeHash($der)); blob = $blob }
  })
  if ($threshold -lt 1 -or $threshold -gt $pinned.Count) { throw "ENCLAVE_RELEASE_THRESHOLD must be 1 to the number of keys" }
  $ctx = [Text.Encoding]::ASCII.GetBytes("enclave-windows-release-signature/v1`n")
  $fields = "format", "channel", "version", "issuedAt", "expiresAt", "file", "sha256", "bytes", "setup", "setupSha256", "setupBytes", "manifest", "manifestSha256", "manifestBytes"
  $best = $null; $seen = @{}; $conflict = $null
  foreach ($m in $mirrors) {
    try {
      $c = (Invoke-WebRequest -UseBasicParsing -Uri ($m + "latest.signed.json") -TimeoutSec 20).Content
      if ($c -is [byte[]]) { $c = [Text.Encoding]::UTF8.GetString($c) }
      if ($c.Length -gt 65536) { throw "the envelope is too large" }
      $envl = $c | ConvertFrom-Json
      if ($envl.format -ne "enclave-windows-release-envelope/v1") { throw "not a signed release envelope" }
      $stBytes = [Convert]::FromBase64String($envl.statement)
      $msg = New-Object byte[] ($ctx.Length + $stBytes.Length); $ctx.CopyTo($msg, 0); $stBytes.CopyTo($msg, $ctx.Length)
      $ok = @{}
      foreach ($s in @($envl.signatures)) {
        $k = $pinned | Where-Object { $_.id -eq $s.keyId } | Select-Object -First 1
        if (-not $k -or $ok.ContainsKey($k.id)) { continue }
        $sig = [Convert]::FromBase64String([string]$s.sig); if ($sig.Length -ne 64) { continue }
        $ck = [Security.Cryptography.CngKey]::Import($k.blob, [Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
        $ec = New-Object Security.Cryptography.ECDsaCng $ck; $ec.HashAlgorithm = [Security.Cryptography.CngAlgorithm]::Sha256
        if ($ec.VerifyData($msg, $sig)) { $ok[$k.id] = 1 }
        $ec.Dispose(); $ck.Dispose()
      }
      if ($ok.Count -lt $threshold) { throw "$($ok.Count) valid signature(s) by the pinned key(s); $threshold required" }
      $st = [Text.Encoding]::UTF8.GetString($stBytes) | ConvertFrom-Json
      foreach ($n in $st.PSObject.Properties.Name) { if ($fields -notcontains $n) { throw "the signed statement has an unknown field: $n" } }
      $v = [string]$st.version
      if ($st.format -ne "enclave-windows-release/v1" -or $st.channel -ne $channel) { throw "the signed statement is not for channel $channel" }
      if ($v -notmatch '^\d{1,9}(\.\d{1,9}){1,3}$' -or $st.setup -ne "EnclaveSetup-$v.exe" -or $st.setupSha256 -notmatch '^[0-9a-f]{64}$' -or
          -not ($st.setupBytes -is [int] -or $st.setupBytes -is [long]) -or $st.setupBytes -lt 1 -or $st.setupBytes -gt 64MB) { throw "the signed statement does not name a setup program" }
      if ($st.expiresAt -and [DateTime]::Parse($st.expiresAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal) -le [DateTime]::UtcNow) { throw "the signed statement expired at $($st.expiresAt)" }
      $h = & $hex $sha256.ComputeHash($stBytes)
      if ($seen.ContainsKey($v) -and $seen[$v] -ne $h) { $conflict = $v }
      $seen[$v] = $h
      if (-not $best -or [version]$v -gt [version]$best.version) { $best = $st }
    } catch { Write-Warning "$m refused: $($_.Exception.Message)" }
  }
  if ($conflict) { throw "two different signed statements for version ${conflict}: not running anything until the publisher explains" }
  if (-not $best) { throw "no mirror served a release signed by the pinned key(s): not running anything" }
  $exe = Join-Path $env:TEMP $best.setup
  $got = $false
  foreach ($m in $mirrors) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri ($m + $best.setup) -OutFile $exe -TimeoutSec 600
      $len = (Get-Item -LiteralPath $exe).Length
      $sha = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower()
      if ($len -ne $best.setupBytes -or $sha -ne $best.setupSha256) { throw "$len bytes hashing $sha, not the signed $($best.setupBytes) bytes $($best.setupSha256)" }
      $got = $true; break
    } catch { Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue; Write-Warning "$($best.setup) from $m refused: $($_.Exception.Message)" }
  }
  if (-not $got) { throw "no mirror served the signed setup program: not running anything" }
  # the same policy for setup (and through it, install-host.ps1 and every later update)
  $policy = Join-Path $env:TEMP ("enclave-release-policy-" + [guid]::NewGuid().ToString("N").Substring(0, 8) + ".json")
  [ordered]@{ format = "enclave-windows-release-policy/v1"; channel = $channel; keys = @($keys); threshold = $threshold; mirrors = @($mirrors) } |
    ConvertTo-Json -Depth 3 | Set-Content -Encoding UTF8 -LiteralPath $policy
  $setupArgs += "--release-policy", "`"$policy`""
  Write-Host "Checked Enclave setup $($best.version): signed by the pinned key(s), sha256 $($best.setupSha256.Substring(0, 16))... Starting setup; Windows asks for administrator rights."
} else {
  # ---- the legacy channel: get.enclave.host, UNSIGNED --------------------------------------------------------------------
  $base = "https://get.enclave.host/windows"
  $latest = Invoke-RestMethod -UseBasicParsing "$base/latest.json"
  if ($latest.setup -notmatch '^[A-Za-z0-9._-]+\.exe$' -or $latest.setupSha256 -notmatch '^[0-9a-f]{64}$') { throw "latest.json does not name a setup program" }
  $exe = Join-Path $env:TEMP ("EnclaveSetup-" + $latest.version + ".exe")
  Write-Host "Downloading Enclave setup $($latest.version)..."
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$($latest.setup)" -OutFile $exe
  $sha = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower()
  if ($sha -ne $latest.setupSha256) { Remove-Item $exe -Force; throw "the download hashes $sha, not the published $($latest.setupSha256): not running it" }
  Write-Host "Checked against the unsigned latest.json (sha256 $($sha.Substring(0, 16))...). Starting setup; Windows asks for administrator rights."
}
if ($ref) { $setupArgs += "--referral", $ref }
if ($setupArgs.Count) { Start-Process -FilePath $exe -Verb RunAs -ArgumentList $setupArgs } else { Start-Process -FilePath $exe -Verb RunAs }
