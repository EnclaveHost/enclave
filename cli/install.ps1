# enclave CLI installer (Windows) — PowerShell counterpart of install.sh.
# Two ways in, same artifact out:
#
#   irm https://get.enclave.host/install.ps1 | iex      # hosted one-liner (also: enclave.host/install.ps1)
#   .\cli\install.ps1                                   # from a checkout
#     (or: powershell -ExecutionPolicy Bypass -File cli\install.ps1)
#
# Either way it bundles cli/enclave.mjs (deps inlined, ~1 MB, exact versions
# from the checked-in package-lock.json) into %LOCALAPPDATA%\enclave\bin and
# creates an `enclave` command shim. This is a KEY-HOLDING signing binary, so the
# hosted mode does NOT build the moving branch tip: it downloads a PINNED release
# zipball plus its SHA256SUMS and REFUSES to build unless the checksum matches.
# Pin an exact tag with $env:ENCLAVE_CLI_VERSION="cli-vX.Y.Z"; unset resolves the
# latest cli-* release. $env:ENCLAVE_CLI_CHANNEL="edge" is an explicit, UNVERIFIED
# escape hatch that builds the current main tip (dev only).
#
# BE HONEST ABOUT WHAT THAT CHECKSUM PROVES (same wording as install.sh, because
# it is the same limitation). SHA256SUMS ships from the SAME release as the
# zipball, so it establishes that you got the bytes the release holds —
# transport corruption, a lying mirror, a truncated download. It does NOT defend
# against whoever can PUBLISH a release (a stolen token, a compromised
# maintainer account): they write both files.
#
# A detached SIGNATURE over SHA256SUMS closes that, and the machinery is here:
# set $EnclaveReleasePubKey below and this script REQUIRES a valid signature by
# that key before it will build. It is empty until the project's release key
# exists (scripts/release-key.mjs gen), and while empty this script says so on
# every run rather than implying a guarantee it is not making. The key is PINNED
# here, never fetched - a key downloaded from the same host as the artifact
# proves nothing. Same key, same check, same wording as install.sh.
#
# What you CAN do today, with no key involved: the release assets are
# `git archive` of the tag, which is byte-deterministic, so anyone with a clone
# can reproduce them and tie the artifact to the git history instead of to
# whoever uploaded it (verified against the live cli-v1.1.0 release):
#
#   git fetch --tags; git tag -v <tag>      # if the tag is signed
#   git archive --format=zip --prefix=enclave-<tag>/ <tag> | sha256sum
#
# That hash must equal the zipball line in the release's SHA256SUMS.
#
# Needs node >= 20 on PATH.
# No-script alternative that works on every OS: npm install -g .\cli
# (npm generates the .cmd shim itself; the CLI is plain node either way).
$ErrorActionPreference = "Stop"

# throw, not exit: under `irm | iex` an exit would close the user's terminal
function Fail($msg) { Write-Host "error: $msg" -ForegroundColor Red; throw $msg }

# Ed25519 public key (base64, 32 raw bytes) whose signature over SHA256SUMS is
# REQUIRED before a hosted install will build. Empty = unsigned releases are
# accepted with a loud warning. Fill it from `node scripts/release-key.mjs gen`
# with the SAME value pinned in install.sh, and keep the private half off CI.
$EnclaveReleasePubKey = ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "node is required (https://nodejs.org, v20 or newer)"
}
$major = [int](node -p "parseInt(process.versions.node)")
if ($major -lt 20) { Fail "node >= 20 required (found $(node -v))" }

# checkout mode: this script sits in cli\ next to enclave.mjs. Piped through
# `irm | iex` there is no script path, so fetch the repo and build from that.
$cliDir = $PSScriptRoot
$tmp = $null
if (-not $cliDir -or -not (Test-Path (Join-Path $cliDir "enclave.mjs"))) {
  $gh  = "https://github.com/EnclaveHost/enclave"
  $api = "https://api.github.com/repos/EnclaveHost/enclave"
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("enclave-install-" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp "enclave.zip"

  if ($env:ENCLAVE_CLI_CHANNEL -eq "edge") {
    # explicit, UNVERIFIED dev path: build the current main tip, no checksum.
    Write-Host "WARNING: ENCLAVE_CLI_CHANNEL=edge builds the UNVERIFIED main tip (no checksum). Dev use only." -ForegroundColor Yellow
    Invoke-WebRequest -Uri "$gh/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmp
  } else {
    # pinned + checksum-verified release. ENCLAVE_CLI_VERSION pins an exact tag;
    # unset resolves the latest cli-* release. Resolution uses the tag-prefix
    # refs API, NOT /releases: that endpoint only returns the newest page of
    # releases, and enclave (non-CLI) releases land many per day, so the
    # latest cli-* release is quickly buried pages deep.
    $ver = $env:ENCLAVE_CLI_VERSION
    if (-not $ver) {
      $refs = Invoke-RestMethod -Uri "$api/git/matching-refs/tags/cli-v" -UseBasicParsing
      $ver = @($refs) | ForEach-Object { $_.ref -replace '^refs/tags/', '' } |
        Where-Object { $_ -match '^cli-v\d+\.\d+\.\d+$' } |
        Sort-Object { [version]($_ -replace '^cli-v', '') } | Select-Object -Last 1
      if (-not $ver) { Fail "no cli-* release found (and ENCLAVE_CLI_VERSION unset). Set `$env:ENCLAVE_CLI_VERSION='cli-vX.Y.Z', or `$env:ENCLAVE_CLI_CHANNEL='edge' for an unverified dev build." }
    }
    $base = "$gh/releases/download/$ver"
    $zipname = "enclave-cli-$ver.zip"
    Write-Host "fetching $ver (checksum-verified)..."
    Invoke-WebRequest -Uri "$base/$zipname"   -OutFile $zip -UseBasicParsing
    $sums = Join-Path $tmp "SHA256SUMS"
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing
    # Signature first: the checksum below is only as trustworthy as the file it
    # is read from, so establish WHO wrote SHA256SUMS before believing what it
    # says about the zipball. Inlined for the same reason as install.sh - the
    # verifier cannot come from the archive it is verifying - and node is
    # already a hard requirement above, so this needs no openssl.
    if ($EnclaveReleasePubKey) {
      $sig = Join-Path $tmp "SHA256SUMS.sig"
      try { Invoke-WebRequest -Uri "$base/SHA256SUMS.sig" -OutFile $sig -UseBasicParsing }
      catch { Fail "$ver publishes no SHA256SUMS.sig, but this installer pins a release key - refusing to build" }
      $js = 'const f=require("fs"),c=require("crypto");const a=process.argv.slice(1);const r=Buffer.from(a[2].trim(),"base64");const k=c.createPublicKey({key:r.length===32?Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),r]):r,format:"der",type:"spki"});if(k.asymmetricKeyType!=="ed25519")process.exit(1);const t=f.readFileSync(a[1]);const s=t.length===64?t:Buffer.from(t.toString("utf8").trim(),"base64");if(s.length!==64)process.exit(1);process.exit(c.verify(null,f.readFileSync(a[0]),k,s)?0:1);'
      & node -e $js $sums $sig $EnclaveReleasePubKey
      if ($LASTEXITCODE -ne 0) { Fail "SHA256SUMS for $ver is not signed by the pinned release key - refusing to build" }
      Write-Host "  signature ok (pinned release key)"
    } else {
      Write-Warning "no release key pinned in this installer, so SHA256SUMS is trusted as published."
      Write-Warning "It proves the bytes match the release, NOT who published it. Reproduce instead:"
      Write-Warning "git archive --format=zip --prefix=enclave-$ver/ $ver"
    }
    $want = ((Get-Content $sums | Where-Object { $_ -match [regex]::Escape($zipname) }) -split '\s+' | Where-Object { $_ } | Select-Object -First 1)
    $got  = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if (-not $want -or $want.ToLower() -ne $got) { Fail "checksum mismatch for $ver (want=$want got=$got) - refusing to build" }
    Expand-Archive -Path $zip -DestinationPath $tmp
  }

  $repo = Get-ChildItem -Directory -Path $tmp -Filter "enclave-*" | Select-Object -First 1
  if (-not $repo) { Fail "download did not contain the repo" }
  $cliDir = Join-Path $repo.FullName "cli"
  if (-not (Test-Path (Join-Path $cliDir "enclave.mjs"))) { Fail "download did not contain cli/enclave.mjs" }
}

# bundle deps: the repo root has them; a bare checkout of cli/ installs its own
$haveRoot = Test-Path (Join-Path $cliDir "..\node_modules\viem")
$haveCli  = Test-Path (Join-Path $cliDir "node_modules\viem")
if (-not $haveRoot -and -not $haveCli) {
  Write-Host "installing bundle dependencies (viem, @tinfoilsh/verifier, esbuild)..."
  # Prefer `npm ci` — exact versions from the checked-in package-lock.json (this
  # is a key-holding signing binary; no floating caret ranges). Fall back to
  # `npm install` only if the lockfile is missing (e.g. an old checkout).
  if (Test-Path (Join-Path $cliDir "package-lock.json")) {
    npm --prefix $cliDir ci --no-fund --no-audit
  } else {
    Write-Host "note: no package-lock.json found - falling back to 'npm install' (unpinned)"
    npm --prefix $cliDir install --no-fund --no-audit
  }
  if ($LASTEXITCODE -ne 0) { Fail "npm install failed" }
}

$binDir = Join-Path $env:LOCALAPPDATA "enclave\bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$bundle = Join-Path $binDir "enclave.mjs"

node (Join-Path $cliDir "build.mjs") $bundle
if ($LASTEXITCODE -ne 0) { Fail "bundle failed" }

# the `enclave` command: a .cmd shim (shebangs do nothing on Windows)
$shim = Join-Path $binDir "enclave.cmd"
Set-Content -Path $shim -Value "@echo off`r`nnode `"%~dp0enclave.mjs`" %*" -Encoding ascii

# put the bin dir on the user PATH (announced, not silent; new terminals see it)
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $binDir) {
  if ([string]::IsNullOrEmpty($userPath)) { $newPath = $binDir } else { $newPath = "$userPath;$binDir" }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "added $binDir to your user PATH (open a new terminal to pick it up)"
}

node $bundle version | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "installed bundle failed its smoke test" }

# hosted mode leaves nothing behind but the install itself
if ($tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }

Write-Host "installed $shim"
Write-Host "try: enclave help"
