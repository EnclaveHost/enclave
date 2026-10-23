#!/bin/bash
# Scan (unchanged scanners) then commit ONLY the approved-build record: pins, source patch, root's build log, public inventory.
set -euo pipefail
cd "$(dirname "$0")"
FILES="BUILD-APPROVED-RESULT.md APPROVED-COMMIT.txt .gitignore stage-approved/INVENTORY.sha256 stage-approved/entries-vs-a6.jsonl stage-approved/entries-vs-production.jsonl stage-approved/h-9f6d37bd-on-a6b1378c.patch logs/root-build-approved.out logs/root-build-approved.guard.log commit-result.sh logs/commit-approved-1.out logs/commit-approved-1.guard.log logs/commit-approved-1.rc"
CKR=/home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo
st=$(mktemp -d); for f in $FILES; do mkdir -p "$st/$(dirname $f)"; cp "$f" "$st/$f"; done
cfg=$(mktemp); git -C "$CKR" show HEAD:.gitleaks.toml > "$cfg"
/home/steven/.local/bin/gitleaks dir "$st" --config "$cfg" --no-banner --redact --exit-code 1 --report-format json --report-path /dev/null
find "$st" -type f -print0 | xargs -0 python3 "$CKR/.githooks/scan-crypto-keys.py" --files
python3 - "$st" <<'PY'
import pathlib, sys
OLD = bytes.fromhex('54696e666f696c'); bad = [str(p) for p in pathlib.Path(sys.argv[1]).rglob('*') if p.is_file() and (OLD in p.read_bytes() or OLD.lower() in p.read_bytes())]
assert not bad, bad; print('literal: none')
PY
rm -rf "$st" "$cfg"; echo "[scan] clean"
git add -- $FILES
[ -z "$(git diff --cached --name-only | grep '^stage-approved/dist-')" ] || { echo "binary staged"; exit 1; }
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "approved boot-registration build: record root's PASS (H 9f6d37bd on a6b1378c -> measurement 08d1f838)

Root ran build-approved.sh 21:50-21:54Z: a6 control identical to ee5df6b8, candidate twice identical, delta exactly
app/supervisor.js (+manifest; +gsup vs production), image files = commit bytes, recipe reproduces ed918e4b and ee5df6b8.
Commits the approval, source patch, root's log and public inventory; no image binaries."
git log -1 --format='%H %an <%ae>'
