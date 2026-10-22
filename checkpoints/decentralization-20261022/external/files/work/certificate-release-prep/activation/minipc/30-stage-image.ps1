# 30-stage-image.ps1 - CREATE-ONLY: copies the Shield-direct image, its vbs json and runtime.json from the unzipped stage into
# C:\ProgramData\Enclave\shield-direct\image-<sha12>\ and verifies each sha256. Changes no setting; nothing uses it until
# 40-enable-direct.ps1.
param([Parameter(Mandatory = $true)][string]$Stage, [switch]$Reviewed)
. (Join-Path $Stage 'common.ps1')
if (-not $Reviewed) { Say "refused: run with -Reviewed"; exit 2 }
$src = Join-Path $Stage 'image'
$want = @{ $ImageFile = $ImageSha; 'runtime.json' = $RuntimeJsonSha }
foreach ($k in $want.Keys) { if ((Sha (Join-Path $src $k)) -ne $want[$k]) { Say "refused: staged $k is not $($want[$k])"; exit 2 } }
if (-not (Test-Path -LiteralPath $ImageDir)) { New-Item -ItemType Directory -Path $ImageDir | Out-Null }
foreach ($k in $want.Keys) {
  $dst = Join-Path $ImageDir $k
  if (Test-Path -LiteralPath $dst) { if ((Sha $dst) -ne $want[$k]) { Say "refused: $dst exists with other bytes"; exit 2 } else { continue } }
  Copy-Item -LiteralPath (Join-Path $src $k) -Destination $dst
  if ((Sha $dst) -ne $want[$k]) { Remove-Item -LiteralPath $dst -Force; Say "error: $dst did not copy intact"; exit 1 }
}
Say "STAGED image $ImageSha (RuntimeID $RuntimeId) in $ImageDir"; exit 0
