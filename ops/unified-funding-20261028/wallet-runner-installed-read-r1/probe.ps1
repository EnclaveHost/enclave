$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
try {
 $ls=@(Get-CimInstance -Namespace 'root/StandardCimv2' -ClassName MSFT_NetTCPConnection -Filter 'LocalPort=9600 AND State=2' -OperationTimeoutSec 4 | Select-Object -ExpandProperty OwningProcess -Unique)
 if($ls.Count -ne 1){throw 'ambiguous listener'}
 $pidValue=[uint32]$ls[0];$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pidValue) -OperationTimeoutSec 4
 if(-not $p -or [string]$p.CommandLine -notmatch '(?i)(?:^|\s|\")C:\\Program Files\\Enclave\\control\\windows\\node\\agent\.mjs(?:\"|\s|$)'){throw 'unrecognized agent'}
 $o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -OperationTimeoutSec 4
 if($o.ReturnValue -ne 0){throw 'owner unknown'}
 $files=@()
 foreach($name in @('agent.mjs','host.mjs','chain.mjs')){
  $path='C:\Program Files\Enclave\control\windows\node\'+$name
  $i=Get-Item -LiteralPath $path -Force
  if($i.PSIsContainer -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $i.Length -gt 1048576){throw 'file bound'}
  $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {if($stream.Length -gt 1048576){throw 'file bound'};$h=[Security.Cryptography.SHA256]::Create();try{$sha=([BitConverter]::ToString($h.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}finally{$stream.Dispose()}
  $files+=@{name=$name;bytes=$i.Length;sha256=$sha;modified=$i.LastWriteTimeUtc.ToString('o')}
 }
 $p2=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pidValue) -OperationTimeoutSec 4
 if(-not $p2 -or $p2.CreationDate -ne $p.CreationDate -or $p2.CommandLine -cne $p.CommandLine){throw 'process changed'}
 $r=@{readOnly=$true;known=$true;observedAt=[DateTime]::UtcNow.ToString('o');listener=9600;pid=$pidValue;created=$p.CreationDate.ToUniversalTime().ToString('o');ownerSid=[string]$o.Sid;knownAgentEntry=$true;files=$files;limitations='Disk hashes and stable process identity, not proof of loaded module bytes. No code execution in agent, state mutation, key/env access or financial action.'}
 [Console]::Out.WriteLine(($r|ConvertTo-Json -Depth 5 -Compress))
}catch{[Console]::Out.WriteLine('{"readOnly":true,"known":false,"reason":"bounded public source observation refused; raw diagnostics withheld"}');exit 1}
