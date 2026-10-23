#!/usr/bin/env bash
# build-and-check.sh: ONE offline build + prepare of the custody v2 dashboard site release (queue, <=1024 MiB).
# No install, no network, no commit, no upload, no mirror, no publish, no signature.
#   0. src/ = clone of work/custody-v2-dashboard-20261023/repo at a942a61fd (e24a47fb2 + docs 2d3839c54 + media 04836638 + config-read r4; clean); base = the LIVE front release
#      bafybeig3rai3 (work/logo-site-hotfix/final; enclave.host index.html d253ac83… / dashboard.html 0da63cbf… match it,
#      evidence/public-read.json 2026-10-23T20:20Z). No --no-base, no --base-built-at (a ledgerless base: every inherited
#      chunk and CSP hash dated to this build and kept 48 h).
#   1. node scripts/build-custody-v2-vendor.mjs --check   (the committed vendor bundle == a fresh build)
#   2. node scripts/build-site.mjs; record whether it changed tracked files (generated artifacts)
#   3. prepare --commit <8> [--dirty iff tracked site/installer files changed, as site/deploy.sh does] --base <live>
#      refusing unless "dropped as expired: 0 chunks, 0 CSP hashes"
#   4. review + verify; tools/release-check.mjs (r4-custody-composed)
set -euo pipefail
S=$(cd "$(dirname "$0")/.." && pwd); W=/home/steven/Documents/Codex/2026-10-18/wo/work
BASE=$W/logo-site-hotfix/final
[ -e "$S/release" ] && { echo "$S/release exists: one build per stage"; exit 1; }
export npm_config_offline=true GIT_OPTIONAL_LOCKS=0
cd "$S/src"
[ "$(git rev-parse HEAD)" = a942a61fde4a07e6237b859f6ca5f0e1e22e8c33 ] || { echo "src HEAD is not a942a61fd"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "src is not clean before the build"; git status --porcelain; exit 1; }
[ "$(cat $BASE/cid.txt)" = bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y ] || { echo "base cid.txt changed"; exit 1; }
[ "$(sha256sum < $BASE/site/index.html | cut -d' ' -f1)" = d253ac834b95b211facdff6e45458983970ce1b71457731c262d658d663c7e25 ] || { echo "base index.html is not the live one"; exit 1; }
node scripts/build-custody-v2-vendor.mjs --check
node scripts/build-site.mjs > "$S/logs/build-site.out" 2>&1 || { tail -30 "$S/logs/build-site.out"; exit 1; }
tail -3 "$S/logs/build-site.out"
git status --porcelain > "$S/logs/post-build-status.txt"; git diff --stat > "$S/logs/post-build-diffstat.txt"
cat "$S/logs/post-build-status.txt"
commit=$(git rev-parse --short=8 HEAD); dirty=(); EXPECT_DIRTY=0
[ -z "$(git status --porcelain -- site cli/install.sh cli/install.ps1 cli/host.ps1)" ] || { dirty=(--dirty); EXPECT_DIRTY=1; }
node scripts/site-release/cli.mjs prepare --dist site/dist --installers cli --commit "$commit" "${dirty[@]}" --out "$S/release" --base "$BASE" | tee "$S/logs/prepare.out"
DIR=$(sed -n 's/^release dir: //p' "$S/logs/prepare.out"); CID=$(basename "$DIR"); [[ "$CID" =~ ^b[a-z2-7]{58}$ ]] || { echo "no release dir in the prepare output"; exit 1; }
grep -q 'dropped as expired: 0 chunks, 0 CSP hashes' "$S/logs/prepare.out" || { echo "prepare dropped base chunks or CSP hashes"; exit 1; }
node scripts/site-release/cli.mjs review "$S/release/$CID" > "$S/logs/review.out"
node scripts/site-release/cli.mjs verify "$S/release/$CID" | tee "$S/logs/verify.out"
EXPECT_COMMIT=$commit EXPECT_DIRTY=$EXPECT_DIRTY node "$S/tools/release-check.mjs" "$S/release/$CID" "$S/src" "$BASE" "$S/check" > "$S/logs/release-check.out"
tail -2 "$S/logs/release-check.out"
echo "PREPARED $CID (commit $commit dirty=$EXPECT_DIRTY; not uploaded, not published)"
