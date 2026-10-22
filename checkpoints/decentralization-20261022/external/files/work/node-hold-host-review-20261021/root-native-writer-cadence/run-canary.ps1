# run-canary.ps1 - ROOT RUNS THIS on the Windows node (7d prepared it; 7d never runs anything remotely).
# Native check of the wallet-channel writer's atomic replace against real readers/holders. SCRATCH FILES ONLY:
#   - a NEW unique directory under %ProgramData%\Enclave\staging, removed at the end (verified);
#   - no production config, keys, VMs, scheduled tasks, services, accounts or firewall rules are read or changed;
#   - child processes: the pinned node (canary + one reader) and short-lived powershell holders (<= 3 s each), all
#     bounded by the canary's 120-s watchdog and this script's 180-s kill of the whole tree.
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-canary.ps1 -NodeExe "<the network agent's node.exe>" -NodeSha256 <its sha256>
param(
  [Parameter(Mandatory = $true)][string]$NodeExe,
  [Parameter(Mandatory = $true)][string]$NodeSha256
)
$ErrorActionPreference = 'Stop'
$Stage = $PSScriptRoot
$Pins = [ordered]@{
  'canary.mjs'                      = 'b555bc41148770e6e7f355f171603ed6e6e7b18b06d01feb8a307cc53d2ac805'
  'reader.mjs'                      = 'eaaa41d01aa344755cb5bf2b285b2685b061b8d2cff996b5d122ec107792a4b5'
  'wallet-admission.candidate.mjs'  = '358c7aa92c5413e0c2a3953b2189d1d8258d8b3541c2629b743821678c6319f8'
  'wallet-admission.original.mjs'   = '7a024c432e7b8c78f103467f31da38b37779462429b634ce4e00e313dbc84910'
}
function FileSha([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant() }
$report = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); stage = $Stage; pins = [ordered]@{}; node = $null; scratch = $null; exit = $null; result = $null; cleanup = [ordered]@{} }
foreach ($k in $Pins.Keys) {
  $got = FileSha (Join-Path $Stage $k)
  if ($got -ne $Pins[$k]) { throw "pin mismatch: $k is $got, expected $($Pins[$k])" }
  $report.pins[$k] = $got
}
if (-not (Test-Path -LiteralPath $NodeExe)) { throw "node not found: $NodeExe" }
$nodeHash = FileSha $NodeExe
if ($nodeHash -ne $NodeSha256.ToLowerInvariant()) { throw "node pin mismatch: $nodeHash" }
$report.node = [ordered]@{ path = $NodeExe; sha256 = $nodeHash; version = (& $NodeExe -v) }

$tag = 'wa-native-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$scratch = Join-Path $env:ProgramData ('Enclave\staging\' + $tag)
if (Test-Path -LiteralPath $scratch) { throw "scratch exists: $scratch" }
New-Item -ItemType Directory -Path $scratch | Out-Null
$work = Join-Path $scratch 'work'; New-Item -ItemType Directory -Path $work | Out-Null
$out = Join-Path $scratch 'result.json'
$report.scratch = $scratch
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
try {
  $argList = @('"' + (Join-Path $Stage 'canary.mjs') + '"', '--candidate', '"' + (Join-Path $Stage 'wallet-admission.candidate.mjs') + '"',
    '--original', '"' + (Join-Path $Stage 'wallet-admission.original.mjs') + '"', '--reader', '"' + (Join-Path $Stage 'reader.mjs') + '"',
    '--scratch', '"' + $work + '"', '--out', '"' + $out + '"', '--powershell', '"' + $psExe + '"')
  $proc = Start-Process -FilePath $NodeExe -ArgumentList $argList -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $scratch 'stdout.txt') -RedirectStandardError (Join-Path $scratch 'stderr.txt')
  if (-not $proc.WaitForExit(180000)) {
    # native stderr under ErrorActionPreference Stop would throw in Windows PowerShell 5.1: contained here
    try { & taskkill.exe /T /F /PID $proc.Id 2>$null | Out-Null } catch {}
    $report.exit = 'killed after 180 s'
  } else { $report.exit = $proc.ExitCode }
  if (Test-Path -LiteralPath $out) { $report.result = Get-Content -Raw -LiteralPath $out | ConvertFrom-Json }
  else { $report.result = [ordered]@{ missing = $true; stderr = (Get-Content -Raw -LiteralPath (Join-Path $scratch 'stderr.txt') -ErrorAction SilentlyContinue) } }
} finally {
  # any holder or reader still alive that names THIS scratch directory is stopped (expected: none)
  $left = @(Get-CimInstance Win32_Process | Where-Object { ([string]$_.CommandLine) -like ('*' + $tag + '*') })
  $report.cleanup.leftoverProcesses = $left.Count
  foreach ($p in $left) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }
  Start-Sleep -Milliseconds 300
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
  $report.cleanup.scratchRemoved = -not (Test-Path -LiteralPath $scratch)
}
$resultFile = Join-Path $Stage ('result-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '.json')
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultFile -Encoding UTF8
$report | ConvertTo-Json -Depth 8
