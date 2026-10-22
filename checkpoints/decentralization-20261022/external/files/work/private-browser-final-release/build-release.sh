#!/usr/bin/env bash
# Build the composed site (main + frozen private-browser patch + live-edit test) and prepare ONE release. No publication.
set -euo pipefail
cd "$(dirname "$0")/tree"
export GIT_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git GIT_WORK_TREE="$PWD" GIT_OPTIONAL_LOCKS=0
export npm_config_offline=true
node scripts/build-site.mjs
mkdir -p ../release
node scripts/site-release/cli.mjs prepare --dist site/dist --installers cli --commit e762a9c5 --dirty --out ../release \
  --base /home/steven/Documents/Codex/2026-10-18/wo/work/logo-site-hotfix/final --base-built-at 2026-10-20T02:14:19.960Z
echo BUILD-RELEASE-OK
