#!/bin/bash
set -u
O=$(dirname "$0")/../evidence/snapshots-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$O"; cd "$O" || exit 2
n=0; for u in https://chain.base.org/api/snapshots https://mainnet-v2-snapshots.base.org/api/snapshots; do n=$((n+1))
  curl -sS -L --proto =https --max-time 20 --max-filesize 4194304 -A fresh-witness-audit -o api-$n.json -w "%{http_code} %{size_download} %{content_type} $u\n" "$u" >> fetch.log 2>&1 || echo "FAIL $u" >> fetch.log
done
sha256sum * > SHA256SUMS; cat fetch.log
