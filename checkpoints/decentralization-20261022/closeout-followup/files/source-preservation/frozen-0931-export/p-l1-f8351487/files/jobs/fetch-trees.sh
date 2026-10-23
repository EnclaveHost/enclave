#!/bin/bash
# Read-only: resolve tag commits and recursive file listings (GitHub API). Bounded 20 s / 8 MiB per request.
set -u
O=$(dirname "$0")/../evidence/trees-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$O"; cd "$O" || exit 2
get() { curl -sS -L --proto =https --max-time 20 --max-filesize 8388608 -A enclave-l1-source-audit -o "$1" -w "%{http_code} %{size_download} $2\n" "$2" >> fetch.log 2>&1 || echo "FAIL $2" >> fetch.log; }
get lighthouse-v8.3.2-commit.json https://api.github.com/repos/sigp/lighthouse/commits/v8.3.2
get reth-v2.8.0-commit.json https://api.github.com/repos/paradigmxyz/reth/commits/v2.8.0
for r in lighthouse:sigp/lighthouse:v8.3.2 reth:paradigmxyz/reth:v2.8.0; do
  n=${r%%:*}; rest=${r#*:}; repo=${rest%:*}; tag=${rest##*:}
  sha=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['sha'])" $n-$tag-commit.json 2>/dev/null)
  echo "$n $tag $sha" >> fetch.log
  get $n-$tag-tree.json "https://api.github.com/repos/$repo/git/trees/$sha?recursive=1"
done
sha256sum * > SHA256SUMS; cat fetch.log
