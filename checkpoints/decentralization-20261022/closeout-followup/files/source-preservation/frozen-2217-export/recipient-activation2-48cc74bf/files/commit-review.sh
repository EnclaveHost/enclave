#!/bin/bash
# Scan (unchanged scanners) then commit ONLY this review's files; root's live files stay untracked.
set -euo pipefail
cd "$(dirname "$0")"
FILES="check-recovery-verdict.py tests/test_recovery_verdict.py REVIEW-RECOVERY.md review-progress.txt commit-review.sh logs/recovery-verdict-tests-1.out logs/recovery-verdict-tests-1.guard.log logs/recovery-verdict-tests-1.rc logs/commit-recovery-1.out logs/commit-recovery-1.guard.log logs/commit-recovery-1.rc"
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
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "review of the boot-registration activation: GPU-price boot race (critical), strict recovery verdict check

REVIEW-RECOVERY.md: gsup GPU_COUNT=0 -> SELL_GPU_PRICE6=0 before shielded discovery -> full register(gpu=0) instead of
setProofKey (root stopped the cutover); funding/sender/baseline/gate/rollback notes. check-recovery-verdict.py: exact
structured acceptance of the recovery-target attest verdict (08d1f838, post-attach, <=900 s, raw 0600). Tests 7/7 + 5/5."
git log -1 --format='%H %an <%ae>'
