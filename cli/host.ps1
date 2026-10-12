# Enclave host for Windows -- the one-line install:
#
#   irm https://get.enclave.host/host.ps1 | iex
#
# Downloads EnclaveSetup.exe (named, with its sha256, by https://get.enclave.host/windows/latest.json), refuses it unless
# it hashes to the published value, and starts it (it asks for administrator rights: it turns on Hyper-V and installs
# services). Setup then downloads and checks the host bundle itself. See docs/design/windows-host-installer.md.
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$base = "https://get.enclave.host/windows"
$latest = Invoke-RestMethod -UseBasicParsing "$base/latest.json"
if ($latest.setup -notmatch '^[A-Za-z0-9._-]+\.exe$' -or $latest.setupSha256 -notmatch '^[0-9a-f]{64}$') { throw "latest.json does not name a setup program" }
$exe = Join-Path $env:TEMP ("EnclaveSetup-" + $latest.version + ".exe")
Write-Host "Downloading Enclave setup $($latest.version)..."
Invoke-WebRequest -UseBasicParsing -Uri "$base/$($latest.setup)" -OutFile $exe
$sha = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLower()
if ($sha -ne $latest.setupSha256) { Remove-Item $exe -Force; throw "the download hashes $sha, not the published $($latest.setupSha256): not running it" }
Write-Host "Checked (sha256 $($sha.Substring(0, 16))...). Starting setup; Windows asks for administrator rights."
Start-Process -FilePath $exe -Verb RunAs
