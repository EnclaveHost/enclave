# isolated-probe.exit.tests.ps1 -- the OUTER contract of ops\isolated-probe.ps1: its process exit
# status, and that a failing run still performs its cleanup first. The library tests cover the
# decisions; these invoke the script itself and read $LASTEXITCODE, because the defect this file exists
# for was precisely that the script reported failures and exited 0.
#
# Every case here is read-only: no case passes -Approve, so none of them can touch the setting.
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\isolated-probe.exit.tests.ps1
# -Root is where the lab lives (the directory holding ops\, the launcher's target\ and the image). It
# is a parameter rather than a path derived by counting Split-Paths upwards, because the first version
# of this file counted one too many, pointed at a non-existent image, and every "expected to fail" case
# then passed for the wrong reason -- a test suite green because nothing it ran could work.
param(
  [string] $Root = (Split-Path $PSScriptRoot -Parent),
  [string] $Image,
  [string] $ImageSha256 = 'd240f40c53eb6fa016caaea9357dafbfea2048f18851a38f928fe25792df2864'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'
$script:pass = 0; $script:fail = 0
$probe = Join-Path $PSScriptRoot 'isolated-probe.ps1'
$root  = $Root
$image = if ($Image) { $Image } else { Join-Path $root 'openhcl-x64-test-linux-direct.bin' }
$hash  = $ImageSha256
if (-not (Test-Path $image)) { Write-Host "  [FAIL] the image this suite tests against does not exist: $image"; exit 2 }
Write-Host "lab root: $root"

function Run([string[]] $ScriptArgs) {
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $probe @ScriptArgs 2>&1 | Out-String
  return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
}
function T([string] $name, [scriptblock] $body) {
  try { if (& $body) { $script:pass++; Write-Host "  [PASS] $name" } else { $script:fail++; Write-Host "  [FAIL] $name" } }
  catch { $script:fail++; Write-Host "  [FAIL] $name -- threw: $($_.Exception.Message)" }
}

Write-Host 'exit status of the script itself (all read-only: no -Approve anywhere here)'
T 'a clean read-only preflight exits 0 and says the run is OK' {
  $r = Run @('-Image', $image, '-ImageSha256', $hash, '-Root', $root)
  $r.Code -eq 0 -and $r.Out -match 'RUN OK' -and $r.Out -notmatch 'RUN FAILED'
}
T 'a failed preflight exits NONZERO (the wrong image hash)' {
  $r = Run @('-Image', $image, '-ImageSha256', ('0' * 64), '-Root', $root)
  $r.Code -ne 0 -and $r.Out -match 'RUN FAILED'
}
T '...and that failing run still attempted its cleanup before exiting' {
  $r = Run @('-Image', $image, '-ImageSha256', ('0' * 64), '-Root', $root)
  $r.Out -match 'steps attempted' -and $r.Out -match 'verify-unchanged' -and $r.Out -match 'node'
}
T '...and it verified the live node even though the preflight failed' {
  $r = Run @('-Image', $image, '-ImageSha256', ('0' * 64), '-Root', $root)
  $r.Out -match 'live node unchanged'
}
T 'a missing image exits NONZERO rather than reporting success' {
  $r = Run @('-Image', (Join-Path $root 'no-such-image.bin'), '-ImageSha256', $hash, '-Root', $root)
  $r.Code -ne 0 -and $r.Out -match 'RUN FAILED'
}
T 'no read-only run leaves the setting behind' {
  $present = (Get-ItemProperty 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization').PSObject.Properties.Name -contains 'AllowFirmwareLoadFromFile'
  -not $present
}

Write-Host ''
Write-Host "$script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
exit 0
