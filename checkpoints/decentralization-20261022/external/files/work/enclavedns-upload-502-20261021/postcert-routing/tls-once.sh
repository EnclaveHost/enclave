#!/usr/bin/env bash
# ONE verified TLS GET of the public health route (system CA store, normal DNS); handshake trace lines only.
date -u +%TZ
curl -sS -v --max-time 25 https://ef514ed3.app.enclave.host/healthz -o /tmp/hz.$$ -w '\nRESULT http=%{http_code} ip=%{remote_ip} verify=%{ssl_verify_result} tls=%{time_appconnect} total=%{time_total}\n' 2>&1 \
  | grep -E '^\* (Connected|  Trying|SSL connection|ALPN|Server certificate|  subject|  issuer|  expire|  SSL certificate verify|TLSv|OpenSSL|.*(error|Recv failure|reset|EOF))|^RESULT|^curl:' | head -30
echo "BODY $(head -c 300 /tmp/hz.$$ 2>/dev/null)"; rm -f /tmp/hz.$$
