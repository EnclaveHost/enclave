#!/bin/bash
# Snapshot MANIFEST metadata only (no snapshot data). One request, 20 s, 32 MiB cap.
set -u
O=$(dirname "$0")/../evidence/manifest-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$O"; cd "$O" || exit 2
u=https://mainnet-v2-snapshots.base.org/1792713607/manifest.json
curl -sS -L --proto =https --max-time 30 --max-filesize 33554432 -A fresh-witness-audit -o manifest.json -w "%{http_code} %{size_download} %{content_type} $u\n" "$u" >> fetch.log 2>&1 || echo "FAIL $u" >> fetch.log
sha256sum * > SHA256SUMS; cat fetch.log
