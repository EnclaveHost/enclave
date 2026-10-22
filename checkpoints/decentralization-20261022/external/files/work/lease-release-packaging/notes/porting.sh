#!/usr/bin/env bash
# notes/PORTING.txt + notes/PORTING.diff: for every ORIGINS.txt entry, the work/app-lease-gas original (found by its
# recorded hash prefix, excluding snapshots/), the ported src/ file, a diffstat and assert/[PASS]-relevant counts.
set -euo pipefail
C=$(cd "$(dirname "$0")/.." && pwd -P); A=$(cd "$C/../app-lease-gas" && pwd -P)
: > "$C/notes/PORTING.diff"
{ echo "ported files: original (work/app-lease-gas) -> candidate src/; assertion counts are original/ported"
  awk '$2 ~ /^\.\// {print $1, $2}' "$C/ORIGINS.txt" | while read -r h f; do f=${f#./}
    o=$(cd "$A" && find . -type f -not -path './snapshots/*' -not -path '*/node_modules/*' -not -path './logs/*' -not -path './forge/out/*' -not -path './forge/cache/*' -print0 | xargs -0 sha256sum | awk -v h="$h" 'index($1,h)==1 && !d {print $2; d=1}')
    note=""
    if [ -z "$o" ]; then b=$(basename "$f"); o=$(cd "$A" && find ./test -name "$b" -type f | head -1)
      [ -n "$o" ] || { echo "  $f: ORIGINAL NOT FOUND for $h"; continue; }
      note=" [the original changed upstream after the copy (recorded $h, now $(sha256sum < "$A/$o" | cut -c1-16)); compared with the CURRENT upstream]"; fi
    o=${o#./}; n="$C/src/$f"
    cnt() { grep -Eo '\bassert(\.[a-zA-Z]+)?\(|\bassert[A-Z][a-zA-Z]*\(|\bvm\.expectRevert\(' "$1" | wc -l; }
    if cmp -s "$A/$o" "$n"; then echo "  $f <- $o: identical"
    else st=$(diff -u "$A/$o" "$n" | grep -Ec '^[-+][^-+]' || true)
      echo "  $f <- $o: $st changed lines; asserts $(cnt "$A/$o")/$(cnt "$n")$note"
      diff -u --label "app-lease-gas/$o" --label "src/$f" "$A/$o" "$n" >> "$C/notes/PORTING.diff" || true; fi
  done; } > "$C/notes/PORTING.txt"
cat "$C/notes/PORTING.txt"
