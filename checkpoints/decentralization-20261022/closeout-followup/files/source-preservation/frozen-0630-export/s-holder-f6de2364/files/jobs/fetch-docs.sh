#!/bin/bash
set -u
O=$(dirname "$0")/../evidence/docs-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$O"; cd "$O" || exit 2
for p in performance-tuning snapshots run-a-node; do
  curl -sS -L --proto =https --max-time 20 --max-filesize 4194304 -A fresh-witness-audit -o $p.md -w "%{http_code} %{size_download} $p\n" "https://docs.base.org/specifications/node-operators/$p.md" >> fetch.log 2>&1 || echo "FAIL $p" >> fetch.log
done
sha256sum * > SHA256SUMS; cat fetch.log
