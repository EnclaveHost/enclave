# Source candidate. Import defines functions only; no task registration or VM action.
Set-StrictMode -Version Latest
$script:OwnedStopRequests=@{}

function Assert-RpcObservationWindow {
    param([long]$StartedMs,[long]$EndedMs,[long]$MaximumMs)
    if($MaximumMs -le 0 -or $MaximumMs -gt 2000 -or $EndedMs -lt $StartedMs -or
       $EndedMs-$StartedMs -gt $MaximumMs){throw 'observation exceeded aggregate freshness budget'}
}

function Assert-RpcMutationWorker {
    # Deliberate activation gate. AsJob only bounds work after submission; synchronous
    # contract/CIM/Get-VM/submission calls need an independent native worker deadline.
    # No qualified Windows job-object/deadline adapter is installed by this module.
    throw 'native bounded mutation worker is not qualified; no VM mutation submitted'
}

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

function Open-RpcOwnedContract {
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
    $ancestry=@()
    while($current){
        $entry=Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse ancestor'}
        $acl=Get-Acl -LiteralPath $current -ErrorAction Stop
        # Require independently reviewed ACL hashes for every ancestor, including
        # the fixed owned-rpc parent and volume root. Merely protecting a child
        # cannot neutralize delete-child/rename authority on its parent.
        $ancestry+=@{path=$entry.FullName;sddl=$acl.Sddl}
        if($current -eq [IO.Path]::GetPathRoot($root)){break}
        $current=Split-Path -Parent $current
    }
    # Deny writers and delete/rename sharing; all subsequent bytes and ACL checks
    # refer to this held file handle until the entire caller operation finishes.
    $stream=[IO.File]::Open($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
    if($stream.Length -gt 65536){throw 'contract grew'}
    $heldAcl=$stream.GetAccessControl()
    if(-not $heldAcl.AreAccessRulesProtected -or $heldAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')){throw 'held contract ACL mismatch'}
    foreach($rule in $heldAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
        if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
           $rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')){throw 'held contract grants foreign access'}
    }
    $bytes=New-Object byte[] ([int]$stream.Length)
    $offset=0
    while($offset -lt $bytes.Length){$n=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($n -le 0){throw 'short contract read'};$offset+=$n}
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
    if($c.ancestryQualificationSha256 -cnotmatch '^[0-9a-f]{64}$' -or
       @($c.ancestryAclPins).Count -ne $ancestry.Count){throw 'ancestor ACL qualification missing'}
    foreach($entry in $ancestry){
        $pins=@($c.ancestryAclPins|Where-Object{$_.path -ceq $entry.path})
        if($pins.Count -ne 1 -or $pins[0].sddl -cne $entry.sddl){throw 'ancestor permissions changed'}
        # Pins are a reviewed policy prerequisite, not a substitute for that review.
        # Re-read after opening the no-delete file handle to detect namespace drift.
        $again=Get-Item -LiteralPath $entry.path -Force -ErrorAction Stop
        if(($again.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
           (Get-Acl -LiteralPath $entry.path -ErrorAction Stop).Sddl -cne $entry.sddl){throw 'ancestor changed during contract open'}
    }
    foreach($name in @('originMs','deadlineMs','stopGraceMs','forceGraceMs')){
        $v=$c.$name
        if(($v -isnot [int] -and $v -isnot [long]) -or $v -lt 0){throw 'invalid contract time'}
    }
    if($c.deadlineMs-$c.originMs -ne 900000 -or $c.stopGraceMs -gt 30000 -or
       $c.forceGraceMs -gt 15000 -or $c.stopGraceMs -le 0 -or $c.forceGraceMs -le 0){throw 'unbounded timing contract'}
    $os=Get-CimInstance Win32_OperatingSystem -Property LastBootUpTime -OperationTimeoutSec 1
    if($os.LastBootUpTime.ToUniversalTime().ToString('o') -cne $c.hostBoot){throw 'host rebooted'}
    if([Diagnostics.Stopwatch]::Frequency -ne $c.stopwatchFrequency){throw 'clock frequency changed'}
    return [pscustomobject]@{Contract=$c;Handle=$stream;ContractSha256=$ExpectedSha256}
    }catch{$stream.Dispose();throw}
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
    $started=Get-RpcMonotonicMilliseconds
    $lease=Open-RpcOwnedContract -Path $ContractPath -ExpectedSha256 $ExpectedSha256
    try{
    $Contract=$lease.Contract
    if($Contract.maximumObservationMs -isnot [int] -or $Contract.maximumObservationMs -le 0 -or $Contract.maximumObservationMs -gt 2000){throw 'invalid observation policy'}
    $vm=Get-RpcOwnedVm -Contract $Contract
    $os=Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory,LastBootUpTime -OperationTimeoutSec 1
    $disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -Property FreeSpace -OperationTimeoutSec 1
    if($os.LastBootUpTime.ToUniversalTime().ToString('o') -cne $Contract.hostBoot){throw 'host boot changed'}
    $lastVm=Get-RpcOwnedVm -Contract $Contract
    if($lastVm.State -ne $vm.State -or $lastVm.MemoryAssigned -ne $vm.MemoryAssigned){throw 'VM state changed during observation'}
    $ended=Get-RpcMonotonicMilliseconds
    Assert-RpcObservationWindow -StartedMs $started -EndedMs $ended -MaximumMs $Contract.maximumObservationMs
    return [pscustomobject]@{vmGuid=$vm.Id.ToString();state=[string]$vm.State;
        assignedMemoryBytes=[long]$vm.MemoryAssigned;physicalFreeBytes=([long]$os.FreePhysicalMemory*1024);
        diskFreeBytes=[long]$disk.FreeSpace;monotonicMs=$started;sampleStartedMs=$started;sampleEndedMs=$ended;
        originalOwnershipRevalidated=$true}
    }finally{$lease.Handle.Dispose()}
}

function Invoke-RpcOwnedStopRequest {
    param([Parameter(Mandatory=$true)][string]$ContractPath,[Parameter(Mandatory=$true)][string]$ExpectedSha256,[switch]$TurnOff)
    Assert-RpcMutationWorker
    $lease=Open-RpcOwnedContract -Path $ContractPath -ExpectedSha256 $ExpectedSha256
    try{
    $Contract=$lease.Contract
    # Returns the exact local PowerShell job. The caller must keep it, bound waits,
    # inspect its terminal result and preserve pending state if any ambiguity remains.
    # No synchronous/unbounded Wait-Job or Save-VM path exists here.
    $vm=Get-RpcOwnedVm -Contract $Contract
    $requestId=[guid]::NewGuid().ToString()
    $process=[Diagnostics.Process]::GetCurrentProcess()
    # Reserve an in-process request identity BEFORE submission. If submission loses
    # its return value, it remains ambiguous. No reconstruction from broad job scans.
    $record=@{requestId=$requestId;contractSha256=$ExpectedSha256;vmGuid=$Contract.vmGuid;
        attempt=$Contract.attempt;hostBoot=$Contract.hostBoot;pid=$PID;
        processStartUtc=$process.StartTime.ToUniversalTime().ToString('o');job=$null;
        submittedAtMs=(Get-RpcMonotonicMilliseconds);ambiguous=$true}
    $script:OwnedStopRequests.Add($requestId,$record)
    if($TurnOff){$job=Stop-VM -VM $vm -TurnOff -AsJob -Confirm:$false -ErrorAction Stop}
    else{$job=Stop-VM -VM $vm -AsJob -Confirm:$false -ErrorAction Stop}
    $record.job=$job;$record.ambiguous=$false
    return [pscustomobject]@{requestId=$requestId;jobInstance=[string]$job.InstanceId;
        durableAssociation=$false;reservationMayRelease=$false}
    }finally{$lease.Handle.Dispose()}
}

function Get-RpcOwnedStopEvidence {
    param([Parameter(Mandatory=$true)][string]$ContractPath,[Parameter(Mandatory=$true)][string]$ExpectedSha256,[Parameter(Mandatory=$true)][string]$RequestId)
    $allowed=@('Completed','Failed','Stopped')
    $observation=Get-RpcOwnedVmObservation -ContractPath $ContractPath -ExpectedSha256 $ExpectedSha256
    if(-not $script:OwnedStopRequests.ContainsKey($RequestId)){throw 'unknown stop request; cannot reconstruct from caller job'}
    $record=$script:OwnedStopRequests[$RequestId]
    $process=[Diagnostics.Process]::GetCurrentProcess()
    if($record.ambiguous -or $null -eq $record.job -or $record.contractSha256 -cne $ExpectedSha256 -or
       $record.vmGuid -cne $observation.vmGuid -or $record.pid -ne $PID -or
       $record.processStartUtc -cne $process.StartTime.ToUniversalTime().ToString('o')){throw 'stop request ownership mismatch'}
    $job=Get-Job -InstanceId $record.job.InstanceId -ErrorAction Stop
    if(-not [object]::ReferenceEquals($job,$record.job)){throw 'job object changed'}
    return [pscustomobject]@{vm=$observation;stopJobInstance=[string]$job.InstanceId;
        stopJobTerminal=([string]$job.State -in $allowed);stopJobState=[string]$job.State;
        observedOff=($observation.state -ceq 'Off' -and $observation.assignedMemoryBytes -eq 0);
        # Terminating a PowerShell job does NOT prove its submitted Hyper-V request
        # cannot finish later. A separately qualified native job fence is mandatory.
        wrapperOutcomeOnly=$true;jobErrorCount=@($job.Error).Count;
        durableAssociation=$false;lateStartFenced=$false;reservationMayRelease=$false}
}

Export-ModuleMember -Function Get-RpcMonotonicMilliseconds,Get-RpcOwnedVmObservation,Invoke-RpcOwnedStopRequest,Get-RpcOwnedStopEvidence
