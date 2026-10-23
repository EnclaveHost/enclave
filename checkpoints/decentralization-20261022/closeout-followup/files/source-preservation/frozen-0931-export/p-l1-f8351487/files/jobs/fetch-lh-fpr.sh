#!/bin/bash
# Official statements of the Lighthouse release-signing fingerprint: release workflow + SECURITY.md at the pinned commit,
# and the v8.3.2 release body (GitHub API, reduced to a non-secret summary). Read-only, bounded.
set -u
cd "$(dirname "$0")/.." || exit 2
LH=a376defa30470923556d91bdeb15a802e297f31f; FPR=15E66D941F697E28F49381F426416DC3F30674B0
O=$(ls -d evidence/lighthouse-binary-* | tail -1)
get() { curl -sS -L --proto =https --max-time 30 --max-filesize 4194304 -A enclave-l1-source-audit -o "$1" -w "%{http_code} %{size_download} $2\n" "$2" >> "$O/fetch.log" 2>&1 || echo "FAIL $2" >> "$O/fetch.log"; }
get "$O/release.yml" "https://raw.githubusercontent.com/sigp/lighthouse/$LH/.github/workflows/release.yml"
get "$O/SECURITY.md" "https://raw.githubusercontent.com/sigp/lighthouse/$LH/SECURITY.md"
R=$(mktemp); get "$R" https://api.github.com/repos/sigp/lighthouse/releases/tags/v8.3.2
python3 -I - "$R" "$FPR" > "$O/release-v8.3.2-signing-statement.json" <<'PY'
import hashlib, json, re, sys
r = json.load(open(sys.argv[1])); b = r.get('body') or ''
line = next((l.strip() for l in b.splitlines() if sys.argv[2] in l), None)
print(json.dumps({'tag': r['tag_name'], 'id': r['id'], 'author': r['author']['login'], 'bodySha256': hashlib.sha256(b.encode()).hexdigest(),
                  'fingerprintInBody': line is not None, 'statementPrefix': re.sub(r'`.*', '', line or '').strip(),
                  'fingerprint': sys.argv[2]}, indent=1))
PY
rm -f "$R"
echo "== release.yml"; grep -n -i "$FPR\|gpg\|sign" "$O/release.yml" | head -20
echo "== SECURITY.md"; grep -n -i "$FPR\|15E6\|pgp\|gpg" "$O/SECURITY.md" | head
cat "$O/release-v8.3.2-signing-statement.json"; tail -3 "$O/fetch.log"
