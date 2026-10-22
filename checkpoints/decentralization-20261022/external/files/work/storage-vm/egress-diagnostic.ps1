$ErrorActionPreference='Stop'
$p='C:\ProgramData\Enclave\network\state\egress-routes.json'
$m=Get-Content -Raw $p|ConvertFrom-Json
$a=$m.apps.'0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238'
[pscustomobject]@{expiresAt=$m.expiresAt;dns=$a.dns;proxyCount=$a.proxies.Count}|ConvertTo-Json -Compress
foreach($proxy in $a.proxies){& curl.exe --socks5-hostname $proxy --connect-timeout 20 --max-time 25 -sS -o NUL -w '%{http_code}\n' https://sia.enclave.host/}
