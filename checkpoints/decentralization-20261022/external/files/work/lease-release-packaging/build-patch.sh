#!/usr/bin/env bash
# lease-release-packaging.patch: CURRENT main -> src/ (git apply --check and byte-compared on a scratch copy); INVENTORY.txt
set -euo pipefail
C=$(cd "$(dirname "$0")" && pwd -P); W=$(cd "$C/.." && pwd -P); E=$(cd "$W/enclave" && pwd -P)
S=$(mktemp -d "$C/scratch.XXXXXX"); trap 'rm -rf -- "$S"' EXIT
mapfile -t OWN < <(cd "$C/src" && find . -type f | sed 's|^\./||' | sort)
P="$C/lease-release-packaging.patch"; : > "$P"
for f in "${OWN[@]}"; do old="$E/$f"; [ -f "$old" ] || old=/dev/null; cmp -s "$old" "$C/src/$f" && continue
  git diff --no-index --no-color --full-index "$old" "$C/src/$f" | sed -e "s|^diff --git a/.* b/.*|diff --git a/$f b/$f|" -e "s|^--- a/.*|--- a/$f|" -e "s|^+++ b/.*|+++ b/$f|" >> "$P" || true; done
for f in "${OWN[@]}"; do [ -f "$E/$f" ] && { mkdir -p "$S/$(dirname "$f")"; cp "$E/$f" "$S/$f"; }; done
git -C "$S" init -q; git -C "$S" apply --check "$P"; git -C "$S" apply "$P"
for f in "${OWN[@]}"; do cmp -s "$S/$f" "$C/src/$f" || { echo "MISMATCH $f"; exit 1; }; done
{ echo "lease-release-packaging inventory ($(date -Iseconds)); main work/enclave HEAD $(git -C "$E" rev-parse HEAD)"
  echo "patch sha256 $(sha256sum < "$P" | cut -c1-64) ($(grep -c '^diff --git' "$P") files): git apply --check on a scratch copy of CURRENT main ok; result == src/"
  echo "path | CURRENT main sha256 | candidate sha256 | origin"
  for f in "${OWN[@]}"; do m=$( [ -f "$E/$f" ] && sha256sum < "$E/$f" | cut -c1-64 || echo "(new)"); n=$(sha256sum < "$C/src/$f" | cut -c1-64)
    o=$(awk -v f="./$f" '$2 == f { found = 1 } END { exit !found }' "$C/ORIGINS.txt" && echo "ported from work/app-lease-gas, path-adapted" || echo "this candidate")
    echo "  $f"; echo "      main $m"; echo "      new  $n  [$o]"; done
} > "$C/INVENTORY.txt"
head -3 "$C/INVENTORY.txt"
