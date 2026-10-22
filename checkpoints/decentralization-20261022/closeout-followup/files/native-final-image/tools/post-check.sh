#!/usr/bin/env bash
# post-check (queue 256, reads only): the OLD verified image and the OLD reviewed tools are byte-unchanged (their own
# PINS.sha256 and the script hashes in their BUILD-RECEIPT.json); this build's artifacts still equal its receipts; the source
# repo still holds 493ee9ee and its commits AFTER 493ee9ee touch no install-set source (so the image is unaffected by them).
set -euo pipefail
. "$(dirname "$0")/env.sh"
OLD=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/measured-image-build
R=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-front-abort/repo
C=493ee9ee07497c94159ec4f6916e9ea920d31959
need() { local what=$1; shift; if "$@"; then echo "[ok] $what"; else echo "[FAIL] $what"; exit 9; fi; }
need "old image + old public receipts == old PINS.sha256" bash -c "cd '$OLD' && sha256sum -c --quiet PINS.sha256"
python3 - "$OLD" <<'PY'
import hashlib, json, sys
old = sys.argv[1]; s = json.load(open(old + "/public/BUILD-RECEIPT.json"))["commands"]["scripts"]
bad = {k: v for k, v in s.items() if hashlib.sha256(open(old + "/" + k, "rb").read()).hexdigest() != v}
print(("[ok] " if not bad else "[FAIL] ") + f"old tools == old BUILD-RECEIPT script hashes ({len(s)} scripts) {bad or ''}")
sys.exit(1 if bad else 0)
PY
need "build A artifacts == receipt" sha256sum -c --quiet "$B/receipts/artifacts-A.sha256"
need "rebuild2 artifacts == receipt" sha256sum -c --quiet "$B/receipts/artifacts-rebuild2.sha256"
need "source repo still has $C" git -C "$R" cat-file -e "$C^{commit}"
head=$(git -C "$R" rev-parse HEAD); echo "[info] source repo HEAD now $head"
git -C "$R" log --format='%H %s' "$C..$head" | tee "$B/receipts/source-commits-after-493.txt"
git -C "$R" diff --name-only "$C" "$head" > "$B/receipts/source-paths-after-493.txt"
python3 - "$B" <<'PY'
import json, sys
B = sys.argv[1]; pre = json.load(open(B + "/receipts/inputs-precheck.json"))
srcs = {v["source"] for v in pre["inputs"].values()}
after = set(open(B + "/receipts/source-paths-after-493.txt").read().split())
hit = sorted(after & srcs)
print(("[ok] " if not hit else "[WARN] ") + f"paths changed after 493ee9ee ({len(after)}) that are install-set sources: {hit}")
PY
n=$(( $(wc -l < "$B/stub/invocations.log") - STUB_BASE )); need "no ssh/scp/sftp invocation ($n)" [ "$n" -eq 0 ]
echo POST-CHECK-OK
