#!/usr/bin/env bash
# s1 (queue 512): a --local --no-hardlinks clone of the control-source repository at ec56a70f (no git am: the commit is final),
# pins, then the reviewed tools/image-inputs.py precheck (relay mode + --chain-verifier-dir).
set -euo pipefail
. "$(dirname "$0")/env.sh"
REPO=/home/steven/Documents/Codex/2026-10-18/wo/work/linux-rpc-consumer-closure-20261023/repo
CS=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/control-source
[ ! -e "$S" ] || { echo "$S exists"; exit 2; }
need "control-source HEAD = $C" [ "$(git -C "$CS" rev-parse HEAD)" = "$C" ]
git clone -q --local --no-hardlinks --no-tags --no-checkout "$REPO" "$S"
git -C "$S" -c advice.detachedHead=false checkout -q --detach "$C"
need "clone HEAD $C" [ "$(git -C "$S" rev-parse HEAD)" = "$C" ]
need "clone tree $TREE" [ "$(git -C "$S" rev-parse HEAD^{tree})" = "$TREE" ]
need "clone tree == control-source HEAD tree" [ "$(git -C "$CS" rev-parse HEAD^{tree})" = "$TREE" ]
need "clone clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
need "927e2acfb (the recipe's commit) is an ancestor" git -C "$S" merge-base --is-ancestor 927e2acfb "$C"
for f in metal/overlay-control-image.py metal/chain-verifier-image.json; do
  echo "[diff 927e2acfb..$C9] $f: $(git -C "$S" diff --stat 927e2acfb "$C" -- $f | tail -1 || true)"
done
echo "[overlay tool] $(git -C "$S" show "$C:metal/overlay-control-image.py" | sha256sum | cut -c1-64)"
pin "$BASE/manifest.json" cc2571bb5b0c85b53b6bcf232331562578335bfd315bd0173c52ad6f80f776e0
pin "$BASE/initramfs.cpio.gz" 516d766d9e31f07c02544d16969c34d3d28c2bca0e4032049225635433f10afc
pin "$BASE/vmlinuz" 1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7
(cd "$V" && sha256sum -c --quiet PINS.sha256) && echo "[ok] chain-verifier-inputs PINS.sha256"
sha256sum "$L/tools/image-inputs.py" "$V/PINS.sha256" "$L/RECIPE-IMAGE.md" | tee "$R/tool-pins.sha256"
python3 -I "$L/tools/image-inputs.py" "$S" "$C" "$V" "$R/inputs-precheck.json"
rm -rf "$S/metal/__pycache__"
python3 - "$R/inputs-precheck.json" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
bad = {k: r[k] for k in ("nativeCollisions", "nonRegularTargets", "doMirrorLiterals") if r[k]}
print("[precheck] ok", r["ok"], "count", r["count"], "empty-lists-violations", bad)
sys.exit(0 if r["ok"] and not bad else 9)
EOF
need "clone still clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
stub_none
echo S1-OK
