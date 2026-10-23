#!/bin/bash
# Scan (unchanged scanners) then commit ONLY this task's files; root's live files stay untracked.
set -euo pipefail
cd "$(dirname "$0")"
FILES="recovery-target.mjs tests/recovery-target.test.mjs RECOVERY-TARGET.md commit-recovery.sh logs/recovery-tests-1.out logs/recovery-tests-1.guard.log logs/recovery-tests-1.rc logs/commit-proofkey-1.out logs/commit-proofkey-1.guard.log logs/commit-proofkey-1.rc"
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
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "metal0 control: exact recovery target (08d1f838, H 9f6d37bd) for the frozen attest/proof-key helpers (source + offline tests)

recovery-target.mjs pins the frozen helpers' bytes, re-ties the pin to all five approved image files (stage or production
copy, every present one), adds exactly TARGETS.recovery in-process; no measurement flag. Proof key stays NOT hardware-bound
(legacy). Tests 5/5 + 5/5."
git log -1 --format='%H %an <%ae>'
