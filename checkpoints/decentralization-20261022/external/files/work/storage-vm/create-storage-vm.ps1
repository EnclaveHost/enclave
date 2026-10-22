$ErrorActionPreference='Stop'
$name='enclave-storage'
$root='C:\ProgramData\Enclave\storage-vm'
if(Get-VM -Name $name -ErrorAction SilentlyContinue){throw 'Target VM already exists; inspect instead of overwriting'}
$disk=Join-Path $root 'enclave-storage.vhdx'
$seed=Join-Path $root 'seed.iso'
if(!(Test-Path $disk) -or !(Test-Path $seed)){throw 'Prepared disk or seed missing'}
Resize-VHD -Path $disk -SizeBytes 64GB
$baseline=@(Get-VM|Select-Object Id,Name,State)
$baseline|ConvertTo-Json -Depth 4|Set-Content (Join-Path $root 'baseline-vms.json')
$vm=New-VM -Name $name -Generation 2 -MemoryStartupBytes 4GB -VHDPath $disk -SwitchName 'Default Switch' -Path $root
Set-VMProcessor -VMName $name -Count 2
Set-VMMemory -VMName $name -DynamicMemoryEnabled $false
Set-VM -Name $name -AutomaticStartAction Start -AutomaticStartDelay 60 -AutomaticStopAction ShutDown -CheckpointType Disabled
Set-VMFirmware -VMName $name -EnableSecureBoot On -SecureBootTemplate MicrosoftUEFICertificateAuthority
Add-VMDvdDrive -VMName $name -Path $seed
$boot=Get-VMHardDiskDrive -VMName $name
Set-VMFirmware -VMName $name -FirstBootDevice $boot
Start-VM -Name $name
$after=@(Get-VM|Where-Object Name -ne $name|Select-Object Id,Name,State)
foreach($row in $baseline){$match=$after|Where-Object Id -eq $row.Id;if(!$match -or $match.State -ne $row.State){throw 'Existing VM state changed'}}
Get-VM -Name $name|Select-Object Name,Id,State,MemoryAssigned,ProcessorCount,AutomaticStartAction,AutomaticStopAction|ConvertTo-Json -Compress
