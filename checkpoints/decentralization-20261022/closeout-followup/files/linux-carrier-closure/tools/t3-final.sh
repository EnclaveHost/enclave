#!/usr/bin/env bash
# t3 (queue 512): read-only finishing checks of the candidate HEAD (repo/, branch linux-carrier-closure):
#   1. exact union of the composition at HEAD~1 (before the bundle rebuild commit); the rebuild commit touches only the two
#      host-admission/host-policy bundles, and their --check passes at HEAD
#   2. the FULL --check output of every bundle still stale at HEAD (the remaining build-input closure)
#   3. the relay and direct image-input closure of HEAD and of carrier-closure-on-fec, vs fec43a6a (tools/input-closure.py)
#   4. scans of fec43a6a..HEAD: the repo's own .githooks/scan-crypto-keys.py --range and gitleaks (the checkpoint's config)
#   5. the review patches (format-patch fec43a6a..HEAD) with sha256
set -uo pipefail
. "$(dirname "$0")/env.sh"
set -e
R=$B/repo; X=$B/tmp/final; D=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-wallet-unknown/candidate
OLD=fec43a6a08da2ac287fb3a5c42de89f096f4f678; H=$(git -C "$R" rev-parse HEAD); F=$(git -C "$R" rev-parse carrier-closure-on-fec)
CFG=/home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo/.gitleaks.toml
need() { local what=$1; shift; if "$@"; then echo "[ok] $what"; else echo "[FAIL] $what"; exit 9; fi; }
need "repo clean" [ -z "$(git -C "$R" status --porcelain --untracked-files=all)" ]
echo "== 1 union"
python3 -u "$B/tools/union-check.py" "$R" HEAD~1 "$B/receipts/union-check-final.json"
need "the rebuild commit changes exactly the two policy bundles" [ "$(git -C "$R" diff --name-only HEAD~1 HEAD | tr '\n' ' ')" = "metal/guest/host-policy.bundle.mjs windows/node/host-admission.bundle.mjs " ]
[ ! -e "$X" ] || { echo "$X exists"; exit 2; }
git clone -q --local --no-hardlinks "$R" "$X"; for d in . network relay; do ln -s "$D/$d/node_modules" "$X/$d/node_modules"; done
echo "== 2 bundle currency at HEAD (full output)"
cd "$X"
for s in "build-host-admission.mjs --check" "build-metal-lease-gas.mjs --check" "build-windows-lease-runtime.mjs --check" \
         "build-mcp-guest-bundle.mjs --check" "build-platform-api-guest-bundle.mjs --check" "build-host-service-packages.mjs --check"; do
  set +e; out=$(timeout -k 5 300 node scripts/$s 2>&1); rc=$?; set -e
  echo "--- scripts/$s rc=$rc"; printf '%s\n' "$out" | grep -v '^    at ' | head -12
done
need "the checks wrote nothing" [ -z "$(git status --porcelain --untracked-files=no)" ]
cd "$B"
echo "== 3 image-input closure"
set +e
python3 -u "$B/tools/input-closure.py" "$R" HEAD "$B/receipts/input-closure-head.json"; echo "[t3] closure HEAD rc=$?"
python3 -u "$B/tools/input-closure.py" "$R" "$F" "$B/receipts/input-closure-carrier-only.json"; echo "[t3] closure carrier-only rc=$?"
set -e
echo "== 4 scans of $OLD..$H"
( cd "$R" && timeout -k 5 300 python3 .githooks/scan-crypto-keys.py --range "$OLD..$H" ); echo "[scan] scan-crypto-keys rc=$?"
timeout -k 5 300 /home/steven/.local/bin/gitleaks git "$R" --config "$CFG" --log-opts="$OLD..$H" --no-banner --redact --exit-code 1 \
  --report-format json --report-path "$B/receipts/gitleaks-range.json"; echo "[scan] gitleaks rc=$?"
echo "== 5 review patches"
rm -rf "$B/patches"; git -C "$R" format-patch -q --full-index --no-renames --no-signature -o "$B/patches" "$OLD..$H"
( cd "$B/patches" && sha256sum *.patch ) | tee "$B/receipts/patches.sha256" | wc -l
git -C "$R" log --format='%H %T %an <%ae> | %cn <%ce> %s' "$OLD..$H" > "$B/receipts/commits.txt"
rm -rf "$X"
n=$(grep -vc " -V stub-proof$" "$B/stub/invocations.log" || true); need "no ssh/scp/sftp invocation ($n)" [ "$n" -eq 0 ]
echo T3-DONE
