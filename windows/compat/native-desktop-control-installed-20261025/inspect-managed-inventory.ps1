# Read only. Export public ownership fields for managed candidates, never arbitrary VM Notes.
$ErrorActionPreference='Stop'
$marker='enclave-vbslike-app-domain'
$prefix=$marker+'/manager|'
$rows=@(Get-VM -ErrorAction Stop|Sort-Object Id|ForEach-Object{
  $vm=$_;$notes=[string]$vm.Notes
  $candidate=$vm.Name.StartsWith('enclave-app-') -or $notes -eq $marker -or $notes.StartsWith($prefix)
  $identity=$null
  if($notes.StartsWith($prefix) -and $notes.Length -le 4096){
    try {
      $encoded=$notes.Substring($prefix.Length).Replace('-','+').Replace('_','/')
      $encoded=$encoded.PadRight($encoded.Length+((4-$encoded.Length%4)%4),'=')
      $decoded=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))|ConvertFrom-Json
      if($decoded.v -eq 1 -and $decoded.id -is [string] -and $decoded.id -and $decoded.name -is [string] -and $decoded.name -and $decoded.instanceId -is [string] -and $decoded.instanceId){
        $identity=@{id=$decoded.id;name=$decoded.name;instanceId=$decoded.instanceId;appId=$decoded.appId;imageRole=$decoded.imageRole}
      }
    } catch { $identity=$null }
  }
  @{id=[string]$vm.Id;name=$vm.Name;state=[string]$vm.State;candidate=[bool]$candidate;identity=$identity}
})
ConvertTo-Json -InputObject $rows -Depth 6 -Compress
