# Source candidate. Import defines functions only; no task registration or VM action.
Set-StrictMode -Version Latest

function Get-RpcMonotonicMilliseconds {
    $ticks=[decimal][Diagnostics.Stopwatch]::GetTimestamp()
    $frequency=[decimal][Diagnostics.Stopwatch]::Frequency
    if($frequency -le 0){throw 'invalid monotonic frequency'}
    return [long][decimal]::Floor(($ticks*1000)/$frequency)
}

function Assert-RpcProtectedPath {
    param([Parameter(Mandatory=$true)][string]$Path,[switch]$Directory)
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse path refused'}
    if([bool]$item.PSIsContainer -ne [bool]$Directory){throw 'wrong path kind'}
    $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if($owner -notin @('S-1-5-18','S-1-5-32-544')){throw 'untrusted artifact owner'}
    if(-not $acl.AreAccessRulesProtected){throw 'artifact inherits permissions'}
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
        if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
           $rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')){
            throw 'artifact permissions exceed SYSTEM and administrators'
        }
    }
    return $item
}

function Read-RpcOwnedContract {
    param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$ExpectedSha256)
    if($ExpectedSha256 -cnotmatch '^[0-9a-f]{64}$'){throw 'invalid contract digest'}
    $file=Assert-RpcProtectedPath -Path $Path
    if($file.Length -gt 65536){throw 'contract bound'}
    $root=Split-Path -Parent $file.FullName
    $null=Assert-RpcProtectedPath -Path $root -Directory
    # The adapter is for an explicitly prepared attempt root only. No caller-selected
    # program, arbitrary task name, or guest-provided path becomes authority.
    if($root -notmatch '^C:\\ProgramData\\Enclave\\owned-rpc\\[0-9a-f-]{36}$'){
        throw 'unexpected owned root'
    }
    $current=$root
    while($current -and $current -ne [IO.Path]::GetPathRoot($root)){
        $entry=Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse ancestor'}
        $current=Split-Path -Parent $current
    }
    $bytes=[IO.File]::ReadAllBytes($file.FullName)
    if($bytes.Length -gt 65536){throw 'contract grew'}
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$actual=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}
    finally{$sha.Dispose()}
    if($actual -cne $ExpectedSha256){throw 'contract digest mismatch'}
    $utf8=New-Object Text.UTF8Encoding($false,$true)
    $c=$utf8.GetString($bytes)|ConvertFrom-Json -ErrorAction Stop
    if($c.schema -cne 'owned-rpc-windows-contract/1'){throw 'unknown contract schema'}
    if(([guid]$c.attempt).ToString() -cne (Split-Path -Leaf $root)){throw 'attempt/root mismatch'}
    if(([guid]$c.vmGuid).ToString() -cne $c.vmGuid){throw 'noncanonical VM identity'}
    if($c.vmName -cne ('enclave-owned-rpc-'+$c.attempt)){throw 'VM name binding'}
    if($c.vmPath -cne (Join-Path (Join-Path $root 'vm') $c.vmName)){throw 'VM path binding'}
    # A contract cannot contain its own digest. Bind the separate immutable root
    # admission record in VM Notes and pin this contract in the task invocation.
    if($c.admissionSha256 -cnotmatch '^[0-9a-f]{64}$' -or
       $c.ownerNote -cne ('owned-rpc/'+$c.attempt+'/'+$c.admissionSha256)){throw 'ownership marker mismatch'}
    foreach($name in @('originMs','deadlineMs','stopGraceMs','forceGraceMs')){
        $v=$c.$name
        if(($v -isnot [int] -and $v -isnot [long]) -or $v -lt 0){throw 'invalid contract time'}
    }
    if($c.deadlineMs-$c.originMs -ne 900000 -or $c.stopGraceMs -gt 30000 -or
       $c.forceGraceMs -gt 15000 -or $c.stopGraceMs -le 0 -or $c.forceGraceMs -le 0){throw 'unbounded timing contract'}
    $os=Get-CimInstance Win32_OperatingSystem -Property LastBootUpTime -OperationTimeoutSec 3
    if($os.LastBootUpTime.ToUniversalTime().ToString('o') -cne $c.hostBoot){throw 'host rebooted'}
    if([Diagnostics.Stopwatch]::Frequency -ne $c.stopwatchFrequency){throw 'clock frequency changed'}
    $null=Assert-RpcProtectedPath -Path $Path
    return $c
}

function Get-RpcOwnedVm {
    param([Parameter(Mandatory=$true)]$Contract)
    $vm=Get-VM -Id ([guid]$Contract.vmGuid) -ErrorAction Stop
    if($vm.Id.ToString() -cne $Contract.vmGuid -or $vm.Name -cne $Contract.vmName -or
       $vm.Notes -cne $Contract.ownerNote -or
       [IO.Path]::GetFullPath($vm.Path).TrimEnd('\') -cne [IO.Path]::GetFullPath($Contract.vmPath).TrimEnd('\')){
        throw 'original owned VM identity cannot be revalidated'
    }
    return $vm
}

function Get-RpcOwnedVmObservation {
    param([Parameter(Mandatory=$true)][string]$ContractPath,[Parameter(Mandatory=$true)][string]$ExpectedSha256)
    $Contract=Read-RpcOwnedContract -Path $ContractPath -ExpectedSha256 $ExpectedSha256
    $vm=Get-RpcOwnedVm -Contract $Contract
    $os=Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory,LastBootUpTime -OperationTimeoutSec 3
    $disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -Property FreeSpace -OperationTimeoutSec 3
    if($os.LastBootUpTime.ToUniversalTime().ToString('o') -cne $Contract.hostBoot){throw 'host boot changed'}
    return [pscustomobject]@{vmGuid=$vm.Id.ToString();state=[string]$vm.State;
        assignedMemoryBytes=[long]$vm.MemoryAssigned;physicalFreeBytes=([long]$os.FreePhysicalMemory*1024);
        diskFreeBytes=[long]$disk.FreeSpace;monotonicMs=(Get-RpcMonotonicMilliseconds);
        originalOwnershipRevalidated=$true}
}

function Invoke-RpcOwnedStopRequest {
    param([Parameter(Mandatory=$true)][string]$ContractPath,[Parameter(Mandatory=$true)][string]$ExpectedSha256,[switch]$TurnOff)
    $Contract=Read-RpcOwnedContract -Path $ContractPath -ExpectedSha256 $ExpectedSha256
    # Returns the exact local PowerShell job. The caller must keep it, bound waits,
    # inspect its terminal result and preserve pending state if any ambiguity remains.
    # No synchronous/unbounded Wait-Job or Save-VM path exists here.
    $vm=Get-RpcOwnedVm -Contract $Contract
    if($TurnOff){return Stop-VM -VM $vm -TurnOff -AsJob -Confirm:$false -ErrorAction Stop}
    return Stop-VM -VM $vm -AsJob -Confirm:$false -ErrorAction Stop
}

function Get-RpcOwnedStopEvidence {
    param([Parameter(Mandatory=$true)][string]$ContractPath,[Parameter(Mandatory=$true)][string]$ExpectedSha256,[Parameter(Mandatory=$true)]$StopJob)
    $allowed=@('Completed','Failed','Stopped')
    $observation=Get-RpcOwnedVmObservation -ContractPath $ContractPath -ExpectedSha256 $ExpectedSha256
    $job=Get-Job -InstanceId $StopJob.InstanceId -ErrorAction Stop
    return [pscustomobject]@{vm=$observation;stopJobInstance=[string]$job.InstanceId;
        stopJobTerminal=([string]$job.State -in $allowed);stopJobState=[string]$job.State;
        observedOff=($observation.state -ceq 'Off' -and $observation.assignedMemoryBytes -eq 0);
        # Terminating a PowerShell job does NOT prove its submitted Hyper-V request
        # cannot finish later. A separately qualified native job fence is mandatory.
        lateStartFenced=$false;reservationMayRelease=$false}
}

Export-ModuleMember -Function Get-RpcMonotonicMilliseconds,Read-RpcOwnedContract,Get-RpcOwnedVmObservation,Invoke-RpcOwnedStopRequest,Get-RpcOwnedStopEvidence
