#!/bin/bash
# Scan (unchanged scanners) then commit ONLY the kit's source, docs and test logs; root runtime files, approvals, build/plan/
# admission/funding evidence, private files and H's review files are never staged.
set -euo pipefail
cd "$(dirname "$0")"
sha256sum -c --quiet TESTED-SOURCE.sha256
FILES="$(awk '{print $2}' TESTED-SOURCE.sha256) TESTED-SOURCE.sha256 HANDOFF.md STATUS.txt commit.sh $(ls logs/t*.out logs/t*.guard.log logs/t*.rc 2>/dev/null) logs/commit-1.out logs/commit-1.guard.log logs/commit-1.rc"
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
bad=$(git diff --cached --name-only | grep -E '(^|/)(ROOT-|APPROVED-BUILD|build\.json|plan\.json|admission|measurement\.env|result\.json|apps-health|gate\.json|private|H-REVIEW|h-review|evidence/(boot-funding|lease-preflight|guestd))' || true)
[ -z "$bad" ] || { echo "refusing: runtime files staged: $bad"; exit 1; }
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "metal0 control: third image-only activation kit for the boot GPU-price build (7dd3acd0 -> b007d471), source only

From frozen 86c5fee. Build-folder source re-derivation + root-approved build.json; 37->38 additive admission; funding decision
setProofKey both pending (null) and discovered (1667); config-derived shielded-GPU expectation; cutover > 1440 s; fresh pre-gate
lease read seeding a watchdog around the UNCHANGED gate v4 (absolute 105 s block age, holder, 600 s floor, stops only its own
group); > 480 s after PASS; signals fail into the safe rollback; strict attest-price.mjs priceRecovery verdict for keep.
Root's final run: python 47/47, node 14/14, mutants 78/78, scans clean; tested source digest 2fb95679."
git log -1 --format='%H %an <%ae>'
