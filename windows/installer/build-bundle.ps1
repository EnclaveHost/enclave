# build-bundle.ps1 -- the Windows half of the host bundle (docs/design/windows-host-installer.md). On a Windows build box:
#   1. expand control-<c8>.tar.gz (windows/installer/stage-bundle.sh) and check every file against its MANIFEST;
#   2. add the prebuilt Windows binaries, each refused unless it hashes to its pin (the known-good runtime nucbox-k11
#      ran until 2026-10-11; building each from source is the next step - SignPath needs it);
#   3. add Node.js and the Python embeddable runtime at pinned versions and hashes;
#   4. compile the tray and the installer with the in-box C# compiler;
#   5. write manifest.json (every file's sha256), zip enclave-host-<version>.zip, write SHA256SUMS.
#
#   powershell -ExecutionPolicy Bypass -File build-bundle.ps1 -Control control-xxxxxxxx.tar.gz -Manifest MANIFEST-control-xxxxxxxx.txt `
#       -Sources C:\path\to\known-good -Out C:\path\to\out [-Version 2026.10.12]
param(
  [Parameter(Mandatory)] [string] $Control,
  [Parameter(Mandatory)] [string] $Manifest,
  [Parameter(Mandatory)] [string] $Sources,
  [Parameter(Mandatory)] [string] $Out,
  [string] $Version = (Get-Date).ToUniversalTime().ToString("yyyy.MM.dd")
)
$ErrorActionPreference = "Stop"
function Sha($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
function Die($m) { throw "build-bundle: $m" }

# --- pins -------------------------------------------------------------------------------------------------------------
# bundle path = (source under -Sources, sha256). Enclave Shield's host binary ships as shield-host.exe.
$Binaries = [ordered]@{
  "bin\shield-host.exe"     = @("vbs-like\releases\risc-service-20261002\vbslike-host.exe", "4feb0adffdd412358d3d67437e096ff5001d38d85fbbc79c9ba73f01dd5242a8")
  "bin\shield-egress.exe"   = @("vbs-like\releases\public-web-20261005\shield-egress.exe",  "a8f384f2aefc65df341519e2e1e2fa56a9d5c900778a9838b2c5ad5d69f48f4b")
  "bin\shielded-bridge.exe" = @("vbs-like\releases\public-web-20261005\shielded-bridge.exe","046442198865f4c70f93fc79f979b760a3514f644862328800db0e26aba3ec79")
  "bin\tpmattest.exe"       = @("vbs-like\hvnode\bin\tpmattest.exe",                       "ebc30d9fa54cf70043900165ce12631224075b3301653eaf8527342d18de6982")
  "bin\wasmtime.exe"        = @("vbs\apps\wasmtime-v49.0.0-x86_64-windows\wasmtime.exe",   "cbe3e2ddc1d449a029b1f581b84688b94fc7e5758cdfe24241609a92b16a5cc2")
  "guest\runtime.bin"       = @("vbs-like\releases\public-web-20261005\runtime.bin",        "5fbfb947884367f1af2b76b4deb8a6ebaad00a5c90577ae7d8c4db95f9ddfa5d")
  "guest\hyperv.psm1"       = @("hyperv.psm1",                                              "17ca4352c500d3498f71be420ddfa418c7ed1d1b5f455856c24e633a4635e49c")
  "guest\runtime.json"      = @("vbs-like\releases\risc-service-20261002\runtime.json",     "c60712e8d90b2b8c3e23e98f62c25f5278bcbffacb26113729a1bd6600b720d0")
}
$NodeZip   = @{ url = "https://nodejs.org/dist/v24.16.0/node-v24.16.0-win-x64.zip"; sha = "edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56"; dir = "node-v24.16.0-win-x64" }
$PythonZip = @{ url = "https://www.python.org/ftp/python/3.14.5/python-3.14.5-embed-amd64.zip"; sha = "ba6bd811c4eedb19195cf275770ef127e893d63701e24152606e2cb76f6d876a" }

$work = Join-Path $Out "work"; $B = Join-Path $work "enclave-host"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force $B, (Join-Path $Out "dl") | Out-Null

# --- 1. control, checked file by file -----------------------------------------------------------------------------
"control: expanding $(Split-Path $Control -Leaf)"
tar.exe -xzf $Control -C $B
if ($LASTEXITCODE) { Die "tar could not expand $Control" }
$n = 0
foreach ($line in Get-Content $Manifest) {
  if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { continue }
  $p = Join-Path $B ($Matches[2] -replace '/', '\')
  if (-not (Test-Path -LiteralPath $p)) { Die "missing from the control archive: $($Matches[2])" }
  if ((Sha $p) -ne $Matches[1]) { Die "hash mismatch in the control archive: $($Matches[2])" }
  $n++
}
"control: $n files match their manifest"

# --- 2. the prebuilt binaries, each against its pin -------------------------------------------------------------------
foreach ($k in $Binaries.Keys) {
  $src = Join-Path $Sources $Binaries[$k][0]; $pin = $Binaries[$k][1]
  if (-not (Test-Path -LiteralPath $src)) { Die "no $src for $k" }
  if ((Sha $src) -ne $pin) { Die "$src hashes $(Sha $src), not the pinned $pin" }
  $dst = Join-Path $B $k; New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
  Copy-Item -LiteralPath $src $dst
  "binary: $k  $($pin.Substring(0,12))"
}

# --- 3. runtimes ------------------------------------------------------------------------------------------------------
function Fetch($spec, $name) {
  $f = Join-Path (Join-Path $Out "dl") (Split-Path $spec.url -Leaf)
  if (-not (Test-Path $f) -or (Sha $f) -ne $spec.sha) {
    Write-Host "download: $($spec.url)"; [Net.ServicePointManager]::SecurityProtocol = "Tls12, Tls13"   # Write-Host: a function's output IS its return value
    Invoke-WebRequest -UseBasicParsing -Uri $spec.url -OutFile $f
  }
  if ((Sha $f) -ne $spec.sha) { Die "$name hashes $(Sha $f), not the pinned $($spec.sha)" }
  return $f
}
$nz = Fetch $NodeZip "Node.js"
Expand-Archive -LiteralPath $nz -DestinationPath (Join-Path $work "node-x") -Force
New-Item -ItemType Directory -Force (Join-Path $B "runtime") | Out-Null
Move-Item (Join-Path (Join-Path $work "node-x") $NodeZip.dir) (Join-Path $B "runtime\node")
"runtime: Node.js $($NodeZip.dir)"
$pz = Fetch $PythonZip "Python"
Expand-Archive -LiteralPath $pz -DestinationPath (Join-Path $B "runtime\python") -Force
# the embeddable Python takes its import path from python3xx._pth only: add the node folder (fetch-cid.py imports
# ipfs_fetch.py from there), relative to the Python folder
$pth = Get-ChildItem (Join-Path $B "runtime\python") -Filter "python3*._pth" | Select-Object -First 1
if (-not $pth) { Die "the Python embeddable runtime has no ._pth file" }
Add-Content -LiteralPath $pth.FullName -Value "..\..\control\windows\node"
"runtime: Python embeddable ($($pth.Name) + control\windows\node)"

# --- 4. the tray and the installer ------------------------------------------------------------------------------------
$setup = Join-Path $B "setup"
$trayDir = Join-Path $setup "windows\tray"
& cmd.exe /c (Join-Path $trayDir "build.cmd") | Out-Host
if ($LASTEXITCODE) { Die "the tray did not build" }
New-Item -ItemType Directory -Force (Join-Path $B "tray") | Out-Null
foreach ($f in "EnclaveTray.exe", "install-tray.cmd", "uninstall-tray.cmd") { Copy-Item (Join-Path $trayDir $f) (Join-Path $B "tray\$f") }
$installer = Join-Path $setup "windows\installer"
if (Test-Path (Join-Path $installer "build-setup.cmd")) {
  & cmd.exe /c (Join-Path $installer "build-setup.cmd") | Out-Host
  if ($LASTEXITCODE) { Die "EnclaveSetup.exe did not build" }
  Copy-Item (Join-Path $installer "EnclaveSetup.exe") (Join-Path $Out "EnclaveSetup.exe") -Force
}
foreach ($f in "install-host.ps1", "uninstall-host.ps1", "update-host.ps1", "templates") {
  $p = Join-Path $installer $f; if (Test-Path $p) { Copy-Item $p (Join-Path $B $f) -Recurse -Force }
}
# the platform's readiness witness (shield-readiness-v1): the pinned app every host runs so the relay can verify its
# Enclave Shield before any buyer's app is admitted (relay policy `witness`). install-host.ps1 checks its runtime is the bundle's.
$witness = Get-Content -Raw (Join-Path $installer "shield-witness.json") | ConvertFrom-Json
Copy-Item (Join-Path $installer "shield-witness.json") (Join-Path $B "guest\witness.json")
# the Shield policy the host's TUNA privacy agent admits its apps under (the relay's open-market policy: any attested TPM)
Copy-Item (Join-Path $installer "admitted-shield-policy.json") (Join-Path $B "tuna\admitted-shield-policy.json")
"witness: shield-readiness-v1 app $($witness.appId.Substring(0,12)) runtime $($witness.derive.runtimeId.Substring(0,12))"
Remove-Item $setup -Recurse -Force

# --- 5. manifest, zip, sums -------------------------------------------------------------------------------------------
$files = Get-ChildItem $B -Recurse -File | Sort-Object FullName
$entries = foreach ($f in $files) { [ordered]@{ path = $f.FullName.Substring($B.Length + 1).Replace('\', '/'); sha256 = (Sha $f.FullName); bytes = $f.Length } }
$commit = ((Get-Content $Manifest -TotalCount 0) -join ""); $c8 = [IO.Path]::GetFileNameWithoutExtension($Control) -replace '^control-', '' -replace '\.tar$', ''
[ordered]@{ product = "Enclave host for Windows"; version = $Version; control = $c8; files = @($entries) } |
  ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $B "manifest.json")
# the staged files carry mtime 0 (deterministic tar); a zip cannot hold dates before 1980, so give every file one fixed date
$stamp = [datetime]::new(2026, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
Get-ChildItem $B -Recurse -File | ForEach-Object { $_.LastWriteTimeUtc = $stamp }
$zip = Join-Path $Out "enclave-host-$Version.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path (Join-Path $B "*") -DestinationPath $zip -CompressionLevel Optimal
$sums = foreach ($f in Get-ChildItem $Out -File | Where-Object { $_.Name -match '^(enclave-host-.*\.zip|EnclaveSetup\.exe)$' }) { "$(Sha $f.FullName)  $($f.Name)" }
$sums | Set-Content -Encoding ASCII (Join-Path $Out "SHA256SUMS")
"bundle: $zip  $([math]::Round((Get-Item $zip).Length / 1MB)) MB, $($files.Count + 1) files"
$sums
