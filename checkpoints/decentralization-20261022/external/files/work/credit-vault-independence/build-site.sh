#!/usr/bin/env bash
# The REAL scripts/build-site.mjs on a scratch copy of the candidate tree (the build stamps from git and rewrites
# site/css, site/js/gen and site/dist, which must not touch tree/). Output: artifacts/site-dist. Nothing is published.
set -euo pipefail
C="$(cd "$(dirname "$0")" && pwd)"; B="$C/build/repo"; A="$C/artifacts"
rm -rf "$C/build" "$A/site-dist"; mkdir -p "$B" "$A"
rsync -a --exclude=/site/dist --exclude=/node_modules --exclude=/.claude "$C/tree/" "$B/"
ln -s "$C/tree/node_modules" "$B/node_modules"
( cd "$B" && git init -q && git add -A && git -c user.name=scratch -c user.email=scratch@localhost -c commit.gpgsign=false commit -q -m "scratch snapshot (build stamp only)" )
cd "$B"
node scripts/build-site.mjs
for f in credit/index.html credit/credit.js credit/credit-config.json vendor/credit-vault.js recover/recover.js; do test -s "site/dist/$f" || { echo "missing $f"; exit 1; }; done
if grep -qE 'from"\.\.?/|import\("\.\.?/' site/dist/credit/credit.js; then echo "credit.js is not self-contained"; exit 1; fi
cmp site/dist/credit/credit-config.json "$C/tree/site/credit/credit-config.json"
cp -a site/dist "$A/site-dist"
echo "[build-site] ok: $(ls site/dist | wc -l) entries; credit.js $(wc -c < site/dist/credit/credit.js) bytes"
