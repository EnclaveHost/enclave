$ErrorActionPreference='Stop'
Get-CimInstance Win32_Process|Where-Object { $_.CommandLine -match 'sia-cert-oneoff|run-oneoff' -and $_.Name -ne 'powershell.exe' }|ForEach-Object { "PROC name=$($_.Name) pid=$($_.ProcessId) parent=$($_.ParentProcessId) start=$($_.CreationDate)" }
$p='C:\ProgramData\Enclave\node-config.local.cmd'; if(Test-Path $p){ foreach($s in Get-Content $p){ if($s -match '^\s*set\s+([^=]+)='){ "SET $($matches[1])" } elseif($s -match '^\s*(@?echo|rem|::|$)'){} else { "OTHER $($s.Length)" } } }
