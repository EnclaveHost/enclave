#!/bin/bash
# Scan (unchanged scanners) then commit ONLY the approval-gated build template + its refusal tests and logs.
set -euo pipefail
cd "$(dirname "$0")"
FILES="build-approved.sh refusal-tests/run.sh commit-approved.sh logs/build-approved-refusal-1.out logs/build-approved-refusal-1.guard.log logs/build-approved-refusal-1.rc logs/build-approved-refusal-2.out logs/build-approved-refusal-2.guard.log logs/build-approved-refusal-2.rc logs/build-approved-refusal-2.try2.out"
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
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "approval-gated bounded build template for H's boot-registration fix on a6b1378c (not run; refusals 6/6)

Refuses without root's APPROVED-COMMIT.txt. Then: delta only supervisor.js + approved extras + tests, builder unchanged; a6
control == staged ee5df6b8; candidate twice identical; exact manifest/entry delta computed from the records; image bytes =
commit source; measurement recipe reproduces ed918e4b and ee5df6b8 first."
git log -1 --format='%H %an <%ae>'
