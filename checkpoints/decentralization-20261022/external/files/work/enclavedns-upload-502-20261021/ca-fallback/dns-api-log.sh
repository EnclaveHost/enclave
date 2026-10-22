#!/usr/bin/env bash
# READ-ONLY: enclave-dns.service journal since 18:30Z, only lines naming ef514ed3 or txt/refus/403/U7/eligible, 260 chars.
cd /home/steven/Documents/Codex/2026-10-18/wo
timeout 60 ssh -p32423 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/control-vm/known_hosts -i /home/steven/.ssh/minipc controladmin@127.0.0.1 \
 "sudo journalctl -u enclave-dns.service --since '2026-10-21 18:30:00 UTC' -o short-iso --no-pager 2>/dev/null | grep -iE 'ef514ed3|/v1/txt|refus|403|U7|eligible|txt ' | cut -c1-260 | tail -60; echo; echo total-lines-since: \$(sudo journalctl -u enclave-dns.service --since '2026-10-21 18:30:00 UTC' --no-pager 2>/dev/null | wc -l)" \
 > work/enclavedns-upload-502-20261021/ca-fallback/dns-api.log 2>&1
cat work/enclavedns-upload-502-20261021/ca-fallback/dns-api.log
