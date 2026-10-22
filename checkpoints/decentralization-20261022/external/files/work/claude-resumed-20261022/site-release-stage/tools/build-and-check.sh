#!/usr/bin/env bash
# build-and-check.sh: ROOT runs this ONCE, through the queue (512 MiB), AFTER applying the reviewed config-read patch to src/.
# Offline: no install, no network (npx resolves the staged node_modules/.bin), no commit, no upload, no publish, no signature.
#   1. build   node scripts/build-site.mjs, with the PRIVATE git view (bare upstream.git HEAD 7752a4239, private index, worktree
#              = src): the footer stamp is "7752a423* · <date>" (dirty: the stage differs from published main)
#   2. prepare scripts/site-release/cli.mjs prepare --commit 7752a423 --dirty --base <hotfix bafybeig3rai3> (no --base-built-at:
#              every inherited chunk and CSP hash is dated to this build and kept 48h)
#   3. review + verify the prepared release, then tools/release-check.mjs (pages, pins, closure, media, moderation, wording,
#      retention of all 650 base chunks + CSP hashes, no new remote origin, stamp)
set -euo pipefail
S=$(cd "$(dirname "$0")/.." && pwd); W=/home/steven/Documents/Codex/2026-10-18/wo/work
B=$W/resume-20261021/reconciliation/upstream.git; BASE=$W/logo-site-hotfix/final
[ -e "$S/release" ] && { echo "$S/release exists: one build per stage"; exit 1; }
export GIT_DIR="$B" GIT_WORK_TREE="$S/src" GIT_INDEX_FILE="$S/git/index" GIT_OPTIONAL_LOCKS=0 npm_config_offline=true
[ "$(git rev-parse HEAD)" = 7752a4239b3bec2cf452491cd1b95164a8c2bdb8 ] || { echo "bare HEAD is not 7752a4239"; exit 1; }
cd "$S/src"
node scripts/build-site.mjs
node scripts/site-release/cli.mjs prepare --dist site/dist --installers cli --commit 7752a423 --dirty --out "$S/release" --base "$BASE" | tee "$S/logs/prepare.out"
DIR=$(sed -n 's/^release dir: //p' "$S/logs/prepare.out"); CID=$(basename "$DIR"); [[ "$CID" =~ ^b[a-z2-7]{58}$ ]] || { echo "no release dir in the prepare output"; exit 1; }
grep -q 'dropped as expired: 0 chunks, 0 CSP hashes' "$S/logs/prepare.out" || { echo "prepare dropped base chunks or CSP hashes"; exit 1; }
node scripts/site-release/cli.mjs review "$S/release/$CID"
node scripts/site-release/cli.mjs verify "$S/release/$CID"
node "$S/tools/release-check.mjs" "$S/release/$CID" "$S/src" "$BASE" "$S/check"
echo "PREPARED $CID (not uploaded, not published)"
