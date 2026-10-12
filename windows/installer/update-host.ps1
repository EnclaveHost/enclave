# update-host.ps1 -- keep this Enclave host on the latest release with no one at the keyboard. Run as SYSTEM by the
# scheduled task \Enclave\Update (5 minutes after boot, then every hour; install-host.ps1 registers it):
#   1. ask get.enclave.host/windows/latest.json for the latest version; nothing newer than Program Files' manifest: done,
#      silently (an hourly no-op leaves no log line);
#   2. download that release's zip and EnclaveSetup.exe into ProgramData\Enclave-setup and check both against the sha256
#      latest.json publishes (the same check EnclaveSetup makes); a mismatch installs nothing;
#   3. run the new release's install-host.ps1 over this host: the same name and owner (node\host.json), so the keys, the
#      records, the guest state and the registration are kept and the services restart on the new version;
#   4. if that install fails, reinstall the release that was running from its own bundle (kept for exactly this), so a
#      bad release leaves the host on the old one rather than on none.
# Releases older than the running one and the one before it are removed. Log: ProgramData\Enclave\logs\update.log.
#   powershell -ExecutionPolicy Bypass -File update-host.ps1 [-Force]      (-Force: reinstall the latest even if current)
param([switch] $Force, [string] $Downloads = "https://get.enclave.host/windows/")
$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"
$PF = Join-Path $env:ProgramFiles "Enclave"; $PD = Join-Path $env:ProgramData "Enclave"; $W = Join-Path $env:ProgramData "Enclave-setup"
$log = Join-Path $PD "logs\update.log"
function Log($m) { "$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')) $m" | Add-Content -Encoding UTF8 $log }
function Sha($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
function Ver($s) { $v = $null; if ([version]::TryParse([string]$s, [ref]$v)) { $v } else { $null } }
function Fetch($name, $sha) {
  $f = Join-Path $W $name
  if (-not (Test-Path -LiteralPath $f) -or (Sha $f) -ne $sha) { Invoke-WebRequest -UseBasicParsing -Uri ($Downloads + $name) -OutFile $f -TimeoutSec 3600 }
  if ((Sha $f) -ne $sha) { Remove-Item -LiteralPath $f -Force; throw "$name hashes differently from the published $sha: not installing it" }
  return $f
}
function Install($dir, $name, $owner, $setup) {
  # ENCLAVE_UPDATING: install-host.ps1 leaves the \Enclave\Update task (this script's own) running and registered as is
  $env:ENCLAVE_UPDATING = "1"
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir "install-host.ps1") -Name $name -Owner $owner -SetupExe $setup 2>&1
  $code = $LASTEXITCODE
  foreach ($l in $out) { Log "  $l" }
  return $code
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
  if (-not (Test-Path (Join-Path $PF "manifest.json")) -or -not (Test-Path (Join-Path $PD "node\host.json"))) { exit 0 }   # not installed
  $installed = (Get-Content (Join-Path $PF "manifest.json") -Raw | ConvertFrom-Json).version
  $hostRec = Get-Content (Join-Path $PD "node\host.json") -Raw | ConvertFrom-Json
  if (-not $hostRec.name) { Log "node\host.json names no host: nothing to update"; exit 0 }
  $latest = Invoke-RestMethod -UseBasicParsing -Uri ($Downloads + "latest.json") -TimeoutSec 30
  if (-not (Ver $latest.version) -or -not (Ver $installed)) { throw "unreadable version: installed '$installed', published '$($latest.version)'" }
  if (-not $Force -and (Ver $latest.version) -le (Ver $installed)) { exit 0 }
  foreach ($k in "file", "sha256", "setup", "setupSha256") { if (-not $latest.$k) { throw "latest.json has no $k" } }
  Log "update $installed -> $($latest.version) for '$($hostRec.name)'"
  New-Item -ItemType Directory -Force $W | Out-Null
  $zip = Fetch $latest.file $latest.sha256.ToLower()
  $setup = Fetch $latest.setup $latest.setupSha256.ToLower()
  $dir = Join-Path $W $latest.version
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $dir)
  Log "downloaded and checked $($latest.file) (sha256 $($latest.sha256.Substring(0, 12))...): installing"
  $owner = if ($hostRec.owner) { [string]$hostRec.owner } else { "" }
  $code = Install $dir $hostRec.name $owner $setup
  if ($code -ne 0) {
    $old = Join-Path $W $installed
    if (Test-Path (Join-Path $old "install-host.ps1")) {
      Log "install of $($latest.version) FAILED (exit $code): reinstalling $installed"
      $oldSetup = Get-ChildItem $W -Filter "EnclaveSetup-$installed.exe" | Select-Object -First 1
      $back = Install $old $hostRec.name $owner $(if ($oldSetup) { $oldSetup.FullName } else { "" })
      Log "rollback to $installed: exit $back"
    } else { Log "install of $($latest.version) FAILED (exit $code), and no bundle of $installed is kept to roll back to" }
    exit 1
  }
  Log "updated to $($latest.version)"
  # keep the running release and the one before it (the rollback); older bundles, zips and setups go
  $keep = @(Get-ChildItem $W -Directory | Where-Object { Ver $_.Name } | Sort-Object { Ver $_.Name } -Descending | Select-Object -First 2 | ForEach-Object Name)
  foreach ($d in Get-ChildItem $W -Directory | Where-Object { (Ver $_.Name) -and $keep -notcontains $_.Name }) { Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  foreach ($f in Get-ChildItem $W -File | Where-Object { $_.Name -match '^(enclave-host-|EnclaveSetup-)(.+?)(\.zip|\.exe)$' -and $keep -notcontains $Matches[2] }) {
    Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
  }
  exit 0
} catch { Log "update failed: $($_.Exception.Message)"; exit 1 }
