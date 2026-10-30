$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$rows=@();$files=@();$seen=@{}
$vms=@(Get-VM);if($vms.Count-gt 16){throw 'VM bound'}
foreach($v in $vms){
 $rows+=@{id=[string]$v.Id;state=[string]$v.State;version=[string]$v.Version;memoryAssigned=[int64]$v.MemoryAssigned;automaticStop=[string]$v.AutomaticStopAction;automaticCheckpoints=[bool]$v.AutomaticCheckpointsEnabled;checkpointType=[string]$v.CheckpointType;configLocation=[string]$v.ConfigurationLocation;snapshotLocation=[string]$v.SnapshotFileLocation;smartPagingLocation=[string]$v.SmartPagingFilePath;path=[string]$v.Path}
 foreach($root in @($v.ConfigurationLocation,$v.SnapshotFileLocation,$v.SmartPagingFilePath,$v.Path)){
  if(-not $root){continue}
  if(-not ([string]$root).StartsWith('C:'+([char]92)+'ProgramData'+([char]92))){throw 'root outside ProgramData'}
  $dirs=@([string]$root,(Join-Path $root 'Virtual Machines'),(Join-Path $root ([string]$v.Id)),(Join-Path (Join-Path $root 'Virtual Machines') ([string]$v.Id)))
  foreach($d in $dirs){
   if($seen.ContainsKey($d)){continue};$seen[$d]=$true
   if(-not(Test-Path -LiteralPath $d -PathType Container)){continue}
   $di=Get-Item -LiteralPath $d -Force;if($di.Attributes-band [IO.FileAttributes]::ReparsePoint){throw 'reparse directory'}
   $entries=@(Get-ChildItem -LiteralPath $d -Force -File|Select-Object -First 65);if($entries.Count-gt 64){throw 'file bound'}
   foreach($f in $entries){if($f.Extension-in @('.vmrs','.vmgs','.vmcx','.bin','.vsv','.slp')){$files+=@{path=$f.FullName;bytes=[int64]$f.Length;attributes=[string]$f.Attributes;modifiedUtc=$f.LastWriteTimeUtc.ToString('o')}}}
  }
 }
}
@{atUtc=[DateTime]::UtcNow.ToString('o');vms=$rows;files=$files;readOnly=$true;fileContentsRead=$false;futureMaximumProven=$false}|ConvertTo-Json -Depth 7 -Compress
