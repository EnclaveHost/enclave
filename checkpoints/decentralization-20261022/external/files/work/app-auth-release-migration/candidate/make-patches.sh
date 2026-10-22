#!/bin/bash
# Regenerates patches/*.patch from the CURRENT enclave-apps sources: snapshot each target, apply apply.py to a copy, diff.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); APPS=${APPS:-$HERE/../../enclave-apps}; OUT=$HERE/../patches
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
declare -A DOC=([eyesoff-ai]=PLATFORM-sso.md [jot]=README.md)
for app in eyesoff-ai jot; do for side in a b; do mkdir -p "$T/$side/$app"; cp -r "$APPS/$app/src" "$T/$side/$app/"; cp "$APPS/$app/${DOC[$app]}" "$T/$side/$app/"; done; done
python3 "$HERE/apply.py" "$T/b" >/dev/null
mkdir -p "$OUT"
for app in eyesoff-ai jot; do
  (cd "$T" && diff -ruN "a/$app" "b/$app" | sed -E 's/^((---|\+\+\+) [^\t]+)\t.*/\1/' > "$OUT/$app-eab1.patch" || [ $? -eq 1 ])
  echo "$app-eab1.patch: $(grep -c '^[+-][^+-]' "$OUT/$app-eab1.patch") changed lines"
done
