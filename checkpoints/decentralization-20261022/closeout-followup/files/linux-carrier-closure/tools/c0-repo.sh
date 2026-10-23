#!/usr/bin/env bash
# c0 (queue 512): the NEW candidate repo for the Linux carrier closure, from the IMMUTABLE fec43a6a (linux-runtime-release/src,
# only read: --local --no-hardlinks copies its objects), on branch linux-carrier-closure. Then the immutable reconciliation
# inputs are fetched as objects only (read-only upload-pack from their repos; nothing written there):
#   A 71448f63 (rpc-priority/repo), B deadline 8d110101 (rpc-verifier-deadline/repo), ROOT fd6a1762 (verified-snapshot-lifecycle-fix).
set -euo pipefail
. "$(dirname "$0")/env.sh"
W=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022
C=fec43a6a08da2ac287fb3a5c42de89f096f4f678; R=$B/repo
[ ! -e "$R" ] || { echo "repo exists"; exit 2; }
git clone -q --local --no-hardlinks --no-checkout "$W/linux-runtime-release/src" "$R"
git -C "$R" remote remove origin
git -C "$R" -c advice.detachedHead=false checkout -q -b linux-carrier-closure "$C"
[ "$(git -C "$R" rev-parse HEAD)" = "$C" ] && [ "$(git -C "$R" rev-parse HEAD^{tree})" = 13e18b0895e37a7baa5bc9e11ad1fdcf337daac0 ]
for spec in "rpc-priority/repo 71448f63ba189b1f61153e7df766f9421b350205" "rpc-verifier-deadline/repo 8d110101f6cdd5a03ffa16f52e6afb1ea8c6f346" \
            "verified-snapshot-lifecycle-fix fd6a1762ed1218d5d32fb43df2ccb97caa2b17e4"; do
  set -- $spec
  git -C "$R" fetch -q --no-tags "$W/$1" "$2"
  git -C "$R" cat-file -e "$2^{commit}" && echo "[ok] fetched $2 from $1 (objects only)"
done
git -C "$R" log --oneline -1
[ -z "$(git -C "$R" status --porcelain --untracked-files=all)" ] && echo "[ok] clean"
n=$(( $(wc -l < "$B/stub/invocations.log") - STUB_BASE )); [ "$n" -eq 0 ] || exit 5
echo C0-OK
