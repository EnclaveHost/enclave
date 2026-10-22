#!/usr/bin/env bash
# READ-ONLY: verifying HTTPS to 59f1273d / 7ae476a3 pinned to the addresses the authoritative DNS gives (bypassing a stale
# negative cache; full CA + hostname verification), plus the node's newest renewal/isolation lines for both (scoped).
cd "$(dirname "$0")"
for h in 59f1273d 7ae476a3; do
  ips=$(dig +short +norec A $h.app.enclave.host @ns-us-west.enclave.host | grep -E '^[0-9.]+$')
  echo "== $h authoritative A: ${ips:-none}"
  for ip in $ips; do
    curl -sS -m 15 -o /tmp/claude-1000/v59.body -w "   $ip: HTTP %{http_code} verify=%{ssl_verify_result} %{http_version}\n" --resolve "$h.app.enclave.host:443:$ip" "https://$h.app.enclave.host/" 2>&1 | tail -1
    echo | timeout 10 openssl s_client -connect "$ip:443" -servername "$h.app.enclave.host" -verify_return_error 2>/dev/null | openssl x509 -noout -issuer -enddate -ext subjectAltName 2>/dev/null | tr '\n' ' ' | sed 's/^/      /'; echo
  done
done
python3 - <<'PY'
import subprocess, base64
ps = r'''$ProgressPreference='SilentlyContinue'; $nl=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 1500)
foreach($i in '59f1273d','7ae476a3'){ "== node $i"; @($nl | Where-Object { $_ -match $i -and $_ -match 'renew|serving|isolation|retired|spawned|held|claimed' -and $_ -notmatch 'adopted' } | Select-Object -Last 5) | ForEach-Object { $s=[string]$_; if($s.Length -gt 220){$s.Substring(0,220)}else{$s} } }'''
r = subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','minipc','powershell','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(ps.encode('utf-16le')).decode()],capture_output=True,timeout=90)
print(r.stdout.decode('utf-8','replace'))
PY
