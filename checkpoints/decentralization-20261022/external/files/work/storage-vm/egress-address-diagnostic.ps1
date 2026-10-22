$ErrorActionPreference='Stop'
$p='C:\ProgramData\Enclave\network\state\egress-routes.json'
$m=Get-Content -Raw $p|ConvertFrom-Json
$a=$m.apps.'0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238'
[pscustomobject]@{expiresAt=$m.expiresAt;dns=$a.dns;proxyCount=$a.proxies.Count}|ConvertTo-Json -Compress
foreach($proxy in $a.proxies){
foreach($ip in @('134.199.235.187','134.209.248.172','165.245.191.129','146.190.246.39')){Write-Output $ip; & curl.exe --socks5 $proxy --resolve "sia.enclave.host:443:$ip" --connect-timeout 10 --max-time 15 -sS -o NUL -w '%{http_code}\n' https://sia.enclave.host/}
& curl.exe --socks5 $proxy --resolve 'cloudflare-dns.com:443:1.1.1.1' --connect-timeout 10 --max-time 15 -sS -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=sia.enclave.host&type=A'
}
