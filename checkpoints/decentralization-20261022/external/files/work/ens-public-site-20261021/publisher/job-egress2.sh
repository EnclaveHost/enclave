#!/bin/bash
# READ-ONLY, bounded: one ssh session to minipc running egress/remote2.ps1 (agent loopback health + the ONE deployment's
# log endpoint, filtered/redacted remotely; two public GETs). Watchdog inside (150 s / 512 MB); local timeout 200 s.
cd /home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/publisher/egress
enc=$(iconv -f UTF-8 -t UTF-16LE remote2.ps1 | base64 -w0)
timeout 200 ssh -n -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 minipc powershell -NoProfile -NonInteractive -EncodedCommand "$enc" 2>stderr2.txt | tr -d '\r' > remote2-out.json
rc=${PIPESTATUS[0]}; echo "rc=$rc bytes=$(wc -c < remote2-out.json)"; grep -v "post-quantum\|vulnerable to\|may need to be upgraded" stderr2.txt | head -5; exit $rc
