import importlib.util,json
from pathlib import Path
from datetime import datetime,timezone
spec=importlib.util.spec_from_file_location('native', 'work/nucbox-tls-20261021/root-activate-reviewed.py')
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
script="""[Console]::OutputEncoding=[Text.UTF8Encoding]::new();
$o=Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 15;
$c=Get-CimInstance Win32_ComputerSystem -OperationTimeoutSec 15;
$d=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -OperationTimeoutSec 15|ForEach-Object{[ordered]@{drive=$_.DeviceID;filesystem=$_.FileSystem;sizeBytes=[long]$_.Size;freeBytes=[long]$_.FreeSpace}});
[ordered]@{totalVisibleKiB=[long]$o.TotalVisibleMemorySize;freePhysicalKiB=[long]$o.FreePhysicalMemory;logicalProcessors=[int]$c.NumberOfLogicalProcessors;disks=$d}|ConvertTo-Json -Compress -Depth 4
"""
result={'observedAt':datetime.now(timezone.utc).isoformat(),'alias':'minipc','readOnly':True,'inventory':native.ps(script,45),
 'scope':'Current capacity only, no VM changes, no filesystem writes or allocation on the remote. Does not prove that HDD array is accessible, native Base compatibility, or available resources for deployment.'}
Path('outputs/decentralization-audit/rpc-minipc-capacity-20261023.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
