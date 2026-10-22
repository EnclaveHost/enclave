$ErrorActionPreference='Stop'
$result=& 'C:\Windows\System32\OpenSSH\ssh-keyscan.exe' -T 10 -t ed25519 172.19.137.173 2>&1
$result|ForEach-Object {$_.ToString()}
