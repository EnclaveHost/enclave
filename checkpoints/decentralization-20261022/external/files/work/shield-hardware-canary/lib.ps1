# Shared helpers for the Shield hardware canary (work/shield-hardware-canary/plan.json). Dot-sourced by the other scripts.
# Every state-changing script refuses unless BOTH -Apply is given AND the approval file names its exact step.
$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"
$CanaryPrefix = "enclave-canary-"
$GcsRoot = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices"
$CanaryServices = [ordered]@{ "000024e5-facb-11e6-bd58-64006a7986d3" = "Enclave Shield custody authorization (hv_sock port 9445)";
                              "000024e6-facb-11e6-bd58-64006a7986d3" = "Enclave Shield owner-committed package (hv_sock port 9446)" }
function Sha256Text($s) { $h = [System.Security.Cryptography.SHA256]::Create(); ($h.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$s)) | ForEach-Object { $_.ToString("x2") }) -join "" }
function Snapshot {
  [ordered]@{
    capturedAt = (Get-Date).ToUniversalTime().ToString("o")
    vms   = @(Get-VM | Sort-Object Name | ForEach-Object { [ordered]@{ name = $_.Name; id = $_.Id.Guid; state = [string]$_.State; notesSha256 = (Sha256Text $_.Notes) } })
    gcs   = @(Get-ChildItem $GcsRoot -EA SilentlyContinue | Sort-Object PSChildName | ForEach-Object { [ordered]@{ id = $_.PSChildName.ToLower(); name = (Get-ItemProperty $_.PSPath).ElementName } })
    tasks = @(Get-ScheduledTask -TaskPath "\Enclave\" -EA SilentlyContinue | Sort-Object TaskName | ForEach-Object { [ordered]@{ name = $_.TaskName; state = [string]$_.State } })
    installedManifestSha256 = $(if (Test-Path "C:\Program Files\Enclave\manifest.json") { (Get-FileHash "C:\Program Files\Enclave\manifest.json").Hash.ToLower() } else { $null })
  }
}
# Returns EXACTLY $true or $false and writes NOTHING to the pipeline (messages go to the host): a function that also
# Write-Output's would return an array, and `-not <non-empty array>` is $false - which once let a plan-only run apply.
# Callers must test `if ((Require-Approval ...) -ne $true) { return }`.
function Require-Approval([string]$CanaryDir, [string]$Step, [switch]$Apply) {
  if (-not $Apply) { Write-Host "PLAN ONLY ($Step): nothing changed. Re-run with -Apply after the coordinator approves this step."; return [bool]$false }
  $f = Join-Path $CanaryDir "approved-steps.txt"
  if (-not (Test-Path -LiteralPath $f) -or -not (@(Get-Content -LiteralPath $f) -ccontains "approved: $Step")) { throw "step '$Step' is not approved in $f (a line 'approved: $Step')" }
  return [bool]$true
}
