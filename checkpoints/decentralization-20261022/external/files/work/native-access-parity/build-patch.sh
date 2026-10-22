#!/usr/bin/env bash
# Writes native-access.patch (base -> src, repository-relative paths) and MANIFEST.txt,
# then checks the patch applies to a scratch copy of the CURRENT main files it touches.
set -euo pipefail
C=$(cd "$(dirname "$0")" && pwd); E=$(cd "$C/../enclave" && pwd); P="$C/native-access.patch"
: > "$P"
(cd "$C/src" && find . -type f | sed 's|^\./||' | sort) | while read -r f; do
  if [ -f "$C/base/$f" ]; then old="$C/base/$f"; else old=/dev/null; fi
  git diff --no-index --no-color --full-index "$old" "$C/src/$f" \
    | sed -e "s|^diff --git a/.* b/.*|diff --git a/$f b/$f|" -e "s|^--- a/.*|--- a/$f|" -e "s|^+++ b/.*|+++ b/$f|" >> "$P" || true
done
S=$(mktemp -d); trap 'rm -rf "$S"' EXIT
(cd "$C/src" && find . -type f | sed 's|^\./||') | while read -r f; do
  if [ -f "$E/$f" ]; then mkdir -p "$S/$(dirname "$f")"; cp "$E/$f" "$S/$f"; fi; done
git -C "$S" init -q; git -C "$S" apply --check "$P"; git -C "$S" apply "$P"
(cd "$C/src" && find . -type f | sed 's|^\./||') | while read -r f; do cmp -s "$S/$f" "$C/src/$f" || { echo "MISMATCH $f"; exit 1; }; done
{ echo "native-access-parity patch manifest ($(date -Iseconds))"
  echo "main work/enclave HEAD $(git -C "$E" rev-parse HEAD)"
  echo "patch sha256 $(sha256sum "$P" | cut -c1-64)  ($(wc -l < "$P") lines)"
  echo "git apply --check on a scratch copy of the CURRENT main files: ok; applied result == src: ok"
  echo "files (base sha256 in CURRENT main -> candidate sha256):"
  (cd "$C/src" && find . -type f | sed 's|^\./||' | sort) | while read -r f; do
    b=$( [ -f "$E/$f" ] && sha256sum "$E/$f" | cut -c1-64 || echo "(new file)")
    echo "  $f"; echo "      base $b"; echo "      new  $(sha256sum "$C/src/$f" | cut -c1-64)"; done
} > "$C/MANIFEST.txt"
cat "$C/MANIFEST.txt"
