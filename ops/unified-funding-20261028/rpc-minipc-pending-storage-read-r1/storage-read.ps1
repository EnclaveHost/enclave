# PREPARED ONLY; no execution/syntax qualification. Metadata only, no disk mount or content read.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$started=[DateTime]::UtcNow.ToString('o')
$vms=@(Get-VM -ErrorAction Stop)
if($vms.Count -gt 64){throw 'VM bound exceeded'}
$attachments=@();$paths=@{}
foreach($v in $vms){
  $drives=@(Get-VMHardDiskDrive -VM $v -ErrorAction Stop)
  if($drives.Count -gt 16 -or ($attachments.Count+$drives.Count) -gt 128){throw 'attachment bound exceeded'}
  foreach($d in $drives){
    $attachments+=@{vmId=[string]$v.Id;vmName=$v.Name;controller=[string]$d.ControllerType;controllerNumber=$d.ControllerNumber;location=$d.ControllerLocation;path=$d.Path;diskNumber=$d.DiskNumber}
    if($d.Path){$paths[[string]$d.Path]=$true}
  }
}
if($paths.Count -gt 64){throw 'VHD bound exceeded'}
$vhds=@();foreach($p in $paths.Keys){
  # Get-VHD reads format metadata, not filesystem/chain database contents.
  $h=Get-VHD -Path $p -ErrorAction Stop
  $vhds+=@{path=$h.Path;type=[string]$h.VhdType;format=[string]$h.VhdFormat;virtualBytes=[uint64]$h.Size;fileBytes=[uint64]$h.FileSize;parentPath=$h.ParentPath;attached=[bool]$h.Attached;diskNumber=$h.DiskNumber;fragmentationPercent=$h.FragmentationPercentage}
}
$disks=@(Get-Disk -ErrorAction Stop);if($disks.Count -gt 32){throw 'disk bound exceeded'}
$diskRows=@($disks|ForEach-Object{@{number=$_.Number;name=$_.FriendlyName;bus=[string]$_.BusType;sizeBytes=[uint64]$_.Size;offline=[bool]$_.IsOffline;readOnly=[bool]$_.IsReadOnly;partitionStyle=[string]$_.PartitionStyle;health=[string]$_.HealthStatus}})
$parts=@(Get-Partition -ErrorAction Stop);if($parts.Count -gt 128){throw 'partition bound exceeded'}
$partRows=@($parts|ForEach-Object{@{diskNumber=$_.DiskNumber;partitionNumber=$_.PartitionNumber;drive=[string]$_.DriveLetter;accessPaths=@($_.AccessPaths);sizeBytes=[uint64]$_.Size}})
$vols=@(Get-Volume -ErrorAction Stop);if($vols.Count -gt 32){throw 'volume bound exceeded'}
$volRows=@($vols|ForEach-Object{@{drive=[string]$_.DriveLetter;path=$_.Path;fs=$_.FileSystem;sizeBytes=[uint64]$_.Size;freeBytes=[uint64]$_.SizeRemaining;health=[string]$_.HealthStatus}})
$pd=@(Get-PhysicalDisk -ErrorAction Stop);if($pd.Count -gt 32){throw 'physical disk bound exceeded'}
$pdRows=@($pd|ForEach-Object{@{deviceId=$_.DeviceId;name=$_.FriendlyName;bus=[string]$_.BusType;media=[string]$_.MediaType;sizeBytes=[uint64]$_.Size;health=[string]$_.HealthStatus}})
$r=@{schema='minipc-storage-placement-read/1';startedAt=$started;finishedAt=[DateTime]::UtcNow.ToString('o');attachments=$attachments;vhds=$vhds;disks=$diskRows;partitions=$partRows;volumes=$volRows;physicalDisks=$pdRows;readOnly=$true;capacityAdmitted=$false}
$j=ConvertTo-Json -InputObject $r -Depth 7 -Compress
if([Text.Encoding]::UTF8.GetByteCount($j) -gt 262144){throw 'output bound exceeded'}
$j
