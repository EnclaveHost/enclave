$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$root='C:\EnclaveRpcVm-7a8586db00c64f6f8ab024ae134fe641\7a8586db00c64f6f8ab024ae134fe641'
$rows=@(foreach($name in @('definition.native','definition.native.pending','definition.invoke','definition.invoke.pending','definition.receipt','definition.receipt.pending','definition.job','definition.terminal','definition.system','definition.off')){
 $path=Join-Path $root $name;$exists=[IO.File]::Exists($path);$bytes=$null;$sha256=$null;$content=$null
 if($exists){if([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse refused'};$f=New-Object IO.FileStream($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{if($f.Length -gt 8192){throw 'Bound'};$bytes=$f.Length;$r=New-Object IO.StreamReader($f,[Text.Encoding]::UTF8);$content=$r.ReadToEnd();$r.Dispose()}finally{$f.Dispose()}}
 @{name=$name;exists=$exists;bytes=$bytes;text=$content}
})
[pscustomobject]@{success=$true;root=$root;records=$rows;atUtc=[DateTime]::UtcNow.ToString('o');readOnly=$true;providerSettlementProven=$false;reservationMayRelease=$false}|ConvertTo-Json -Depth 5 -Compress
