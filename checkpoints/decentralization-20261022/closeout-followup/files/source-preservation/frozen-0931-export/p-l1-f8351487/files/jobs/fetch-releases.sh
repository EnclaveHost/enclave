#!/bin/bash
# Read-only primary-source metadata fetch (GitHub API). Bounded: each request 20 s, 8 MiB max, no retries. No binaries.
set -u
O=$(dirname "$0")/../evidence/releases-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$O"; cd "$O" || exit 2
get() { curl -sS -L --proto =https --max-time 20 --max-filesize 8388608 -A enclave-l1-source-audit -o "$1" -w "%{http_code} %{size_download} $2\n" "$2" >> fetch.log 2>&1 || echo "FAIL $2" >> fetch.log; }
get reth-releases.json "https://api.github.com/repos/paradigmxyz/reth/releases?per_page=8"
get lighthouse-releases.json "https://api.github.com/repos/sigp/lighthouse/releases?per_page=8"
get base-releases.json "https://api.github.com/repos/base/base/releases?per_page=4"
sha256sum * > SHA256SUMS
cat fetch.log
python3 -I - <<'PY'
import json
for f in ('reth-releases.json','lighthouse-releases.json','base-releases.json'):
    try: rel=json.load(open(f))
    except Exception as e: print(f, 'ERR', e); continue
    for r in rel:
        print(f, r['tag_name'], r['published_at'], 'pre' if r['prerelease'] else '', 'draft' if r['draft'] else '', (r.get('name') or '')[:60])
PY
