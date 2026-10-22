# READ-ONLY: verify the actual Hyper-V partition against the durable canary creation record before deletion.
param([Parameter(Mandatory)][string]$VmId, [Parameter(Mandatory)][string]$VmName,
      [Parameter(Mandatory)][string]$RecordId, [Parameter(Mandatory)][string]$Deployment,
      [Parameter(Mandatory)][string]$InstanceId)
$ErrorActionPreference = 'Stop'
if ($VmId -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' -or $RecordId -notmatch '^hv[0-9a-f]{32}$' -or
    -not $VmName.StartsWith('enclave-canary-') -or $Deployment -notmatch '^0x[0-9a-f]{64}$') { throw 'invalid canary identity' }
$v = Get-VM -Id $VmId -ErrorAction Stop
if ($v.Name -cne $VmName) { throw 'Hyper-V name differs from journal' }
$prefix = 'enclave-canary-vbslike-domain/manager|'
if (-not ([string]$v.Notes).StartsWith($prefix, [StringComparison]::Ordinal)) { throw 'Hyper-V Notes are not the canary marker' }
$b64 = ([string]$v.Notes).Substring($prefix.Length).Replace('-', '+').Replace('_', '/')
$b64 = $b64.PadRight($b64.Length + ((4 - $b64.Length % 4) % 4), '=')
$n = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) | ConvertFrom-Json
if ($n.v -ne 1 -or $n.id -cne $RecordId -or $n.name -cne $Deployment -or $n.instanceId -cne $InstanceId) { throw 'Hyper-V Notes differ from durable creation intent' }
[ordered]@{ verified = $true; vmId = $v.Id.Guid; vmName = $v.Name; recordId = $n.id } | ConvertTo-Json -Compress
