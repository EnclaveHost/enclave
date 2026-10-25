param([Parameter(Mandatory=$true)][string]$Inspector)
$ErrorActionPreference='Stop'
# Shadow Get-VM only in this script's scope. No Hyper-V mutation or real enumeration.
$inventoryFixtureRows=@()
function Get-VM { [CmdletBinding()]param() $inventoryFixtureRows }
function Read-Inventory {
  $text=& $Inspector
  if(-not ([string]$text).StartsWith('[')){throw 'Inventory must always be a JSON array'}
  $parsed=ConvertFrom-Json -InputObject $text
  if($null -eq $parsed){return ,@()}
  return ,([object[]]$parsed)
}
$empty=Read-Inventory
if($empty.Count -ne 0){throw 'Empty inventory failed'}
$id='11111111-0000-0000-0000-000000000001'
$inventoryFixtureRows=@([pscustomobject]@{Id=$id;Name='unrelated';State='Running';Notes='private-unrelated-sentinel'})
$one=Read-Inventory
if($one.Count -ne 1 -or $one[0].candidate -or $one[0].identity){throw 'Unrelated inventory failed'}
if((& $Inspector) -match 'private-unrelated-sentinel'){throw 'Unrelated Notes exported'}
$public=@{v=1;id=('hv'+('1'*32));name='deployment';instanceId='fixture-1';appId=('a'*64);imageRole='desktop';extra='private-extra-sentinel'}|ConvertTo-Json -Compress
$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($public)).TrimEnd('=').Replace('+','-').Replace('/','_')
$inventoryFixtureRows[0].Notes='enclave-vbslike-app-domain/manager|'+$encoded
$owned=Read-Inventory
if(-not $owned[0].candidate -or $owned[0].identity.instanceId -cne 'fixture-1' -or $owned[0].identity.imageRole -cne 'desktop'){throw 'Ownership decoding failed'}
if((& $Inspector) -match 'private-extra-sentinel'){throw 'Unselected Notes field exported'}
foreach($note in @('enclave-vbslike-app-domain','enclave-vbslike-app-domain/manager|bad!',('enclave-vbslike-app-domain/manager|'+('x'*4097)))){
  $inventoryFixtureRows[0].Notes=$note;$row=Read-Inventory
  if(-not $row[0].candidate -or $row[0].identity){throw 'Malformed ownership must remain unattributed'}
}
$inventoryFixtureRows[0].Notes='';$inventoryFixtureRows[0].Name='enclave-app-unmarked'
$row=Read-Inventory
if(-not $row[0].candidate -or $row[0].identity){throw 'Unmarked managed name must remain unattributed'}
@{ok=$true;cases=8;realHyperVEnumeration=$false;productionMutations=$false}|ConvertTo-Json -Compress
