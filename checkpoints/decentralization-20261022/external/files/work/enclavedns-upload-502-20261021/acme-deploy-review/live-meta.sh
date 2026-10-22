#!/usr/bin/env bash
# READ-ONLY: live-meta.py on the control VM (sudo python3 -), then the relay journal's [certs] lines since 19:00Z
# (sanitized like ca-fallback/relay-certs-log.sh). No mutation.
cd /home/steven/Documents/Codex/2026-10-18/wo
D=work/enclavedns-upload-502-20261021/acme-deploy-review
S="ssh -p32423 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/control-vm/known_hosts -i /home/steven/.ssh/minipc controladmin@127.0.0.1"
timeout 60 $S "sudo python3 -" < $D/live-meta.py > $D/live-meta.json 2> $D/live-meta.err; echo "meta rc=$?"
timeout 60 $S "sudo journalctl -u enclave-api-relay.service --since '2026-10-21 19:00:00 UTC' -o short-iso-precise --no-pager 2>/dev/null | grep -F '[certs]'" \
 | sed -E 's/(kid|hmac|token|key|secret)([\"=: ]+)[A-Za-z0-9_\-]{16,}/\1\2<redacted>/Ig' > $D/relay-certs-1900.log; echo "journal rc=$?"
echo "certs lines $(wc -l < $D/relay-certs-1900.log)"
