#!/usr/bin/env bash
# make-delta.sh: the candidate's scoped delta against CURRENT main -> delta.patch (git format: a/ = main, b/ = result,
# modes and binary-safe) and INVENTORY.txt (overlay.py: CHANGED/NEW with base, result and current-main hashes).
# Refuses on STALE (main moved under a changed file).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
main=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
python3 "$here/overlay.py" "$main" "$here/tree" > "$here/INVENTORY.txt"
s=$(mktemp -d); trap 'rm -rf "$s"' EXIT
mkdir -p "$s/a" "$s/b"
while read -r kind rel _; do
  case "$kind" in
    CHANGED) mkdir -p "$s/a/$(dirname "$rel")" "$s/b/$(dirname "$rel")"
             cp -p "$main/$rel" "$s/a/$rel"; cp -p "$here/tree/$rel" "$s/b/$rel" ;;
    NEW)     mkdir -p "$s/b/$(dirname "$rel")"; cp -p "$here/tree/$rel" "$s/b/$rel" ;;
  esac
done < "$here/INVENTORY.txt"
(cd "$s" && git diff --no-index --binary --src-prefix= --dst-prefix= a b) > "$here/delta.patch" || true
sed -i "s|^diff --git b/|diff --git a/|" "$here/delta.patch"
sha256sum "$here/delta.patch" "$here/INVENTORY.txt"
grep -c '^CHANGED' "$here/INVENTORY.txt" | sed 's/^/changed: /'; grep -c '^NEW' "$here/INVENTORY.txt" | sed 's/^/new: /'
(cd "$main" && git apply --check "$here/delta.patch") && echo "delta.patch applies cleanly to current main"
