#!/usr/bin/env bash
# t4 (queue 1024): the final HEAD after the test-only boundary extension: the carrier suite (forge subset + the real-chain rig),
# then the range scans and the review patches for fec43a6a..HEAD (as t3).
set -uo pipefail
. "$(dirname "$0")/env.sh"
set -e
R=$B/repo; X=$B/tmp/t4; D=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-wallet-unknown/candidate
OLD=fec43a6a08da2ac287fb3a5c42de89f096f4f678; H=$(git -C "$R" rev-parse HEAD)
CFG=/home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo/.gitleaks.toml
export PATH="$PATH:/home/steven/.foundry/bin"
need() { local what=$1; shift; if "$@"; then echo "[ok] $what"; else echo "[FAIL] $what"; exit 9; fi; }
need "repo clean" [ -z "$(git -C "$R" status --porcelain --untracked-files=all)" ]
[ ! -e "$X" ] || { echo "$X exists"; exit 2; }
git clone -q --local --no-hardlinks "$R" "$X"; for d in . network relay; do ln -s "$D/$d/node_modules" "$X/$d/node_modules"; done
( cd "$X" && for s in "contracts/EnclaveRegistry.sol contracts/PaymentRouter.sol contracts/PinnedSessionVaultFactory.sol" contracts/EnclaveDeployments.sol \
    "contracts/EnclaveAppCatalog.sol contracts/foundry/test/mocks/SessionMocks.sol contracts/foundry/test/EnclaveDeployments.multicallValue.t.sol" \
    "contracts/EnclaveAddressBook.sol contracts/EnclaveHostOwnership.sol"; do forge build --offline -j 1 $s >/dev/null; done )
echo "=== H1-carriers ($H)"; set +e
( cd "$X" && timeout -k 10 900 unshare --pid --fork --kill-child --mount-proc node --test --test-timeout=300000 --test-concurrency=1 --test-reporter=spec test/relay-policy-carriers.test.mjs ); rc=$?
set -e; echo "[t4] H1-carriers exit=$rc"; echo "$rc" > "$B/receipts/t4-H1-carriers.rc"
( cd "$R" && timeout -k 5 300 python3 .githooks/scan-crypto-keys.py --range "$OLD..$H" ); echo "[scan] scan-crypto-keys rc=$?"
timeout -k 5 300 /home/steven/.local/bin/gitleaks git "$R" --config "$CFG" --log-opts="$OLD..$H" --no-banner --redact --exit-code 1 \
  --report-format json --report-path "$B/receipts/gitleaks-range.json"; echo "[scan] gitleaks rc=$?"
rm -rf "$B/patches"; git -C "$R" format-patch -q --full-index --no-renames --no-signature -o "$B/patches" "$OLD..$H"
( cd "$B/patches" && sha256sum *.patch ) > "$B/receipts/patches.sha256"; wc -l < "$B/receipts/patches.sha256"
git -C "$R" log --format='%H %T %an <%ae> | %cn <%ce> %s' "$OLD..$H" > "$B/receipts/commits.txt"
rm -rf "$X"
n=$(grep -vc " -V stub-proof$" "$B/stub/invocations.log" || true); need "no ssh/scp/sftp invocation ($n)" [ "$n" -eq 0 ]
[ "$rc" = 0 ] && echo T4-DONE || { echo "T4: carrier suite failed"; exit 8; }
