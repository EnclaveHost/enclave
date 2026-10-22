$ErrorActionPreference='Stop'
Get-ChildItem 'C:\ProgramData\Enclave\logs\partitions' -Recurse|Where-Object{$_.Name -match '4ebb|ef514|egress'}|Select-Object FullName,LastWriteTime|ConvertTo-Json -Compress
Get-Content 'C:\ProgramData\Enclave\logs\shield.log' -Tail 2000|Select-String 'egress refused:|egress failed:|\[egress\]'|ForEach-Object{[regex]::Matches($_.Line,'refused:[a-z-]+|failed:[a-z-]+|SOCKS upstream refused destination|ENOTFOUND|ETIMEDOUT')|ForEach-Object{$_.Value}}|Group-Object|Select-Object Name,Count|ConvertTo-Json -Compress
