#!/usr/bin/env bash
# The unmodified main snapshot (base/) built by its own scripts/build-site.mjs, to compare with the candidate's default build.
set -uo pipefail
C="$(cd "$(dirname "$0")/.." && pwd)"; B="$C/build/base-repo"
rm -rf "$B" "$C/artifacts/base-dist"; mkdir -p "$B"
rsync -a --exclude=/site/dist --exclude=/node_modules "$C/base/" "$B/"
ln -s "$(readlink "$C/tree/node_modules")" "$B/node_modules"
( cd "$B" && git init -q && git add -A && git -c user.name=scratch -c user.email=scratch@localhost -c commit.gpgsign=false commit -q -m "scratch snapshot of main (build stamp only)" ) || exit 1
cd "$B" && node scripts/build-site.mjs || exit 1
cp -a site/dist "$C/artifacts/base-dist"
cd "$C/artifacts" && ( cd base-dist && find . -type f -print0 | sort -z | xargs -0 sha256sum ) > base-dist.sha256
echo "[harness] base-dist: $(wc -l < base-dist.sha256) files"
