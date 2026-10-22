#!/bin/bash
# run-ps.sh <script.ps1> <out.json>: ONE bounded ssh session to minipc; the script carries its own watchdog.
cd "$(dirname "$0")"
enc=$(iconv -f UTF-8 -t UTF-16LE "$1" | base64 -w0)
[ ${#enc} -lt 7900 ] || { echo "encoded command too long (${#enc})"; exit 6; }
timeout 300 ssh -n -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 minipc powershell -NoProfile -NonInteractive -EncodedCommand "$enc" 2>"$2.err" | tr -d '\r' > "$2"
rc=${PIPESTATUS[0]}; echo "rc=$rc $(wc -c < "$2") bytes"; grep -v "post-quantum\|vulnerable to\|may need to be upgraded" "$2.err" | head -8; exit $rc
