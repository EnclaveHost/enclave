param([Parameter(Mandatory)][string]$Scripts)
$ErrorActionPreference='Stop'
$base=Join-Path $env:TEMP ('enclave-gcs-fixture-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $base|Out-Null
try {
  $root=Join-Path $base 'keys';New-Item -ItemType Directory -Path $root|Out-Null
  Set-Content -LiteralPath (Join-Path $base 'approved-steps.txt') @('approved: gcs-apply','approved: gcs-revert')
  $id1='000024e5-facb-11e6-bd58-64006a7986d3';$id2='000024e6-facb-11e6-bd58-64006a7986d3'
  $pre=Join-Path $root $id1;New-Item -ItemType Directory -Path $pre|Out-Null
  $preText='{"ElementName":"pre-existing owner"}';Set-Content -LiteralPath (Join-Path $pre 'values.json') $preText
  & (Join-Path $Scripts 'gcs.ps1') -CanaryDir $base -GcsRootOverride $root -Apply
  $first=Get-Content -LiteralPath (Join-Path $base 'gcs-owned-v2.json') -Raw|ConvertFrom-Json
  if(@($first.entries).Count -ne 1 -or $first.entries[0].id -cne $id2){throw 'pre-existing registration was claimed'}
  $token=$first.entries[0].token
  & (Join-Path $Scripts 'gcs.ps1') -CanaryDir $base -GcsRootOverride $root -Apply
  $again=Get-Content -LiteralPath (Join-Path $base 'gcs-owned-v2.json') -Raw|ConvertFrom-Json
  if(@($again.entries).Count -ne 1 -or $again.entries[0].token -cne $token){throw 'second Apply replaced original ownership'}
  Write-Output 'PASS repeated Apply preserves original ownership'
  $own=Join-Path $root $id2;$values=Get-Content -LiteralPath (Join-Path $own 'values.json') -Raw|ConvertFrom-Json
  $values|Add-Member -NotePropertyName ForeignOwner -NotePropertyValue 'keep-me'
  $values|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $own 'values.json')
  $rejected=$false;try{& (Join-Path $Scripts 'gcs.ps1') -CanaryDir $base -GcsRootOverride $root -Revert -Apply}catch{$rejected=$true}
  if(-not $rejected -or -not (Test-Path -LiteralPath $own)){throw 'foreign change was removed'}
  Write-Output 'PASS Revert preserves foreign registration changes'
  $values.PSObject.Properties.Remove('ForeignOwner');$values|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $own 'values.json')
  & (Join-Path $Scripts 'gcs.ps1') -CanaryDir $base -GcsRootOverride $root -Revert -Apply
  if((Test-Path -LiteralPath $own) -or -not (Test-Path -LiteralPath $pre) -or (Get-Content -LiteralPath (Join-Path $pre 'values.json') -Raw).Trim() -cne $preText){throw 'rollback did not preserve pre-existing key'}
  Write-Output 'PASS Revert removes only journal-owned registration'
  & (Join-Path $Scripts 'gcs.ps1') -CanaryDir $base -GcsRootOverride $root -Revert -Apply
  Write-Output 'PASS repeated Revert is idempotent'
  $denied=$false;try{& (Join-Path $Scripts 'gcs.ps1') -CanaryDir $base -GcsRootOverride 'C:\ProgramData\Enclave' -Apply}catch{$denied=$true}
  if(-not $denied){throw 'fixture mode accepted production path'}
  Write-Output 'PASS fixture mode rejects production paths'
} finally { Remove-Item -LiteralPath $base -Recurse -Force }
Write-Output 'SCRATCH FILES ONLY: no registry changes'
