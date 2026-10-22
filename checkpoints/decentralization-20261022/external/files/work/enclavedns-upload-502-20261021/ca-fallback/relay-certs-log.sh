#!/usr/bin/env bash
# READ-ONLY: enclave-api-relay journal since 18:30Z, ONLY "[certs]" lines, with timestamps; URLs keep host+path (ACME
# order/challenge URLs are public); any 'kid'/'hmac'/'token'/'key' value-looking text is redacted. Plus counts.
cd /home/steven/Documents/Codex/2026-10-18/wo
timeout 60 ssh -p32423 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/control-vm/known_hosts -i /home/steven/.ssh/minipc controladmin@127.0.0.1 \
 "sudo journalctl -u enclave-api-relay.service --since '2026-10-21 18:30:00 UTC' -o short-iso-precise --no-pager 2>/dev/null | grep -F '[certs]'" \
 | sed -E 's/(kid|hmac|token|key|secret)([\"=: ]+)[A-Za-z0-9_\-]{16,}/\1\2<redacted>/Ig' > work/enclavedns-upload-502-20261021/ca-fallback/relay-certs.log
cd work/enclavedns-upload-502-20261021/ca-fallback
echo "lines $(wc -l < relay-certs.log)"
for p in 'ef514ed3' 'cooling this CA off' 'global pace reached' 'issuance failed' 'failed at the CA' 'second chance' 'resuming order' 'letsencrypt: refused' 'backoff after' 'issued by\|issued ' ; do printf '%-26s %s\n' "$p" "$(grep -c -- "$p" relay-certs.log)"; done
