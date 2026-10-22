# Add only absent canary services. Durable ownership survives repeated Apply and partial failures.
# Revert refuses registrations changed by another actor and never touches pre-existing registrations.
param([Parameter(Mandatory)][string]$CanaryDir, [switch]$Apply, [switch]$Revert, [string]$GcsRootOverride = '')
. (Join-Path $PSScriptRoot 'lib.ps1')
$step = if ($Revert) { 'gcs-revert' } else { 'gcs-apply' }
if ((Require-Approval $CanaryDir $step -Apply:$Apply) -ne $true) { return }
$fixture = [bool]$GcsRootOverride
if ($fixture) {
  $temp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
  $GcsRoot = [IO.Path]::GetFullPath($GcsRootOverride)
  if (-not $GcsRoot.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase)) { throw 'fixture registry must be a scratch directory under TEMP' }
} else {
  $stage = Get-Content -LiteralPath (Join-Path $CanaryDir 'stage.json') -Raw | ConvertFrom-Json
  if ($stage.format -cne 'enclave-shield-hardware-canary-stage/2' -or $stage.commit -cnotmatch '^[0-9a-f]{40}$' -or
      $stage.canaryDir -cne $CanaryDir -or $CanaryDir -cne "C:\ProgramData\Enclave\staging\canary-$($stage.commit.Substring(0,8))") { throw 'invalid canary stage' }
}
function SaveJournal {
  $tmp = $rec + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  $bytes = [Text.Encoding]::UTF8.GetBytes(($journal | ConvertTo-Json -Depth 8))
  $stream = [IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  if (Test-Path -LiteralPath $rec) { [IO.File]::Replace($tmp,$rec,($rec+'.previous')); Remove-Item -LiteralPath ($rec+'.previous') -Force } else { [IO.File]::Move($tmp,$rec) }
}
function ValuesOf([string]$key) {
  if ($fixture) {
    $file = Join-Path $key 'values.json'
    if (-not (Test-Path -LiteralPath $file)) { return @{} }
    $v = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json; $values=@{}
    foreach ($property in $v.PSObject.Properties) { $values[$property.Name]=$property.Value }; return $values
  }
  $item = Get-Item -LiteralPath $key; $values=@{}
  foreach ($name in $item.GetValueNames()) {
    if ($item.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'registration has a foreign value type' }
    $values[$name]=$item.GetValue($name)
  }
  return $values
}
function SetValue([string]$key,[string]$name,[string]$value) {
  if ($fixture) { $values=ValuesOf $key; $values[$name]=$value; $values|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $key 'values.json') -Encoding UTF8 }
  else { New-ItemProperty -LiteralPath $key -Name $name -PropertyType String -Value $value -Force | Out-Null }
}
function RequireOwned([string]$key,$entry) {
  $values=ValuesOf $key
  if ($values.EnclaveCanaryRun -cne $entry.token -or
      @($values.Keys | Where-Object { $_ -cne 'EnclaveCanaryRun' -and $_ -cne 'ElementName' }).Count -or
      ($values.ContainsKey('ElementName') -and $values.ElementName -cne $CanaryServices[$entry.id])) { throw "registration changed or ownership unproved: $($entry.id)" }
  if ($fixture) { $foreign=@(Get-ChildItem -LiteralPath $key | Where-Object { $_.Name -cne 'values.json' }) }
  else { $foreign=@(Get-ChildItem -LiteralPath $key) }
  if ($foreign.Count) { throw 'registration has foreign children; left untouched' }
}
$rec=Join-Path $CanaryDir 'gcs-owned-v2.json'
if (Test-Path -LiteralPath (Join-Path $CanaryDir 'gcs-added.json')) { throw 'legacy registration journal needs review before using this protocol' }
$lock=[IO.File]::Open((Join-Path $CanaryDir 'gcs-journal.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
  if (Test-Path -LiteralPath $rec) { $journal=Get-Content -LiteralPath $rec -Raw|ConvertFrom-Json }
  else { $journal=[pscustomobject]@{format='enclave-canary-gcs/2';root=$GcsRoot;entries=@()} }
  if ($journal.format -cne 'enclave-canary-gcs/2' -or $journal.root -cne $GcsRoot) { throw 'registration journal belongs to another root' }
  $seen=@{}
  foreach ($entry in @($journal.entries)) {
    if (-not $CanaryServices.Contains($entry.id) -or $seen.ContainsKey($entry.id) -or $entry.token -cnotmatch '^[0-9a-f]{32}$' -or
        @('planned','owned','removed') -notcontains $entry.state) { throw 'invalid registration journal' }
    $seen[$entry.id]=$true
  }
  if ($Revert) {
    foreach ($entry in @($journal.entries | Where-Object { $_.state -ne 'removed' })) {
      $key=Join-Path $GcsRoot $entry.id
      if (Test-Path -LiteralPath $key) { RequireOwned $key $entry; Remove-Item -LiteralPath $key -Recurse -Force }
      $entry.state='removed'; SaveJournal
      Write-Output "reverted owned registration $($entry.id)"
    }
    return
  }
  foreach ($id in $CanaryServices.Keys) {
    $key=Join-Path $GcsRoot $id
    $entry=@($journal.entries|Where-Object {$_.id -ceq $id})|Select-Object -First 1
    if ($entry -and $entry.state -eq 'removed') { throw 'a reverted canary stage cannot be reapplied; prepare a fresh stage' }
    if (-not $entry) {
      if (Test-Path -LiteralPath $key) { Write-Output "pre-existing registration preserved $id"; continue }
      $entry=[pscustomobject]@{id=$id;token=[guid]::NewGuid().ToString('N');state='planned'}
      $journal.entries=@($journal.entries)+$entry; SaveJournal
      if ($fixture) { New-Item -ItemType Directory -Path $key -ErrorAction Stop|Out-Null }
      else { New-Item -Path $key -ErrorAction Stop|Out-Null }
      SetValue $key 'EnclaveCanaryRun' $entry.token
    }
    if (-not (Test-Path -LiteralPath $key)) { throw "planned registration $id is absent; review the interrupted creation before retrying" }
    RequireOwned $key $entry
    SetValue $key 'ElementName' $CanaryServices[$id]
    $entry.state='owned'; SaveJournal
    Write-Output "owned registration present $id"
  }
} finally { $lock.Dispose() }
