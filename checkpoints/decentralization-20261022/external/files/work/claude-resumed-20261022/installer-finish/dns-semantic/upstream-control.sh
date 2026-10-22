#!/usr/bin/env bash
# READ-ONLY control: do the two configured DoH upstreams answer from THIS workstation (a different network path from the
# EnclaveDNS host)? One RFC 8484 GET each for example.com A, TLS verified.
q=$(python3 -c 'import dns.message,base64;print(base64.urlsafe_b64encode(dns.message.make_query("example.com","A").to_wire()).decode().rstrip("="))')
for u in https://cloudflare-dns.com/dns-query https://dns.quad9.net/dns-query; do
  echo "$(date -u +%FT%T.%3NZ) $u: $(timeout 20 curl -sS -m 15 -o /tmp/claude-1000/uc.bin -w 'http=%{http_code} verify=%{ssl_verify_result} %{http_version} t=%{time_total}' -H 'accept: application/dns-message' "$u?dns=$q" 2>&1) $(python3 -c 'import dns.message;m=dns.message.from_wire(open("/tmp/claude-1000/uc.bin","rb").read());print(dns.rcode.to_text(m.rcode()),[r.to_text() for r in m.answer])' 2>&1 | tail -1)"
done
