#!/usr/bin/env bash
# composition.patch: (CURRENT main + layers/native-access + layers/policy-prereq) -> + src   (this candidate's own work)
# combined.patch:    CURRENT main -> every layer applied in order                         (for root's convenience)
# Both are checked with git apply --check and byte-compared on scratch copies; main is only read.
set -euo pipefail
C=$(cd "$(dirname "$0")" && pwd -P); W=$(cd "$C/.." && pwd -P); E=$(cd "$W/enclave" && pwd -P)
LAYERS=("$C/layers/native-access" "$C/layers/policy-prereq" "$C/src")
S=$(mktemp -d "$C/scratch.XXXXXX"); trap 'rm -rf -- "$S"' EXIT
rel() { (cd "$1" && find . -type f | sed 's|^\./||' | sort); }
all() { for L in "${LAYERS[@]}"; do rel "$L"; done | sort -u; }
mkdir -p "$S/main" "$S/base" "$S/final"
all | while read -r f; do if [ -f "$E/$f" ]; then mkdir -p "$S/main/$(dirname "$f")"; cp "$E/$f" "$S/main/$f"; fi; done
cp -a "$S/main/." "$S/base/"; for L in "$C/layers/native-access" "$C/layers/policy-prereq"; do cp -a "$L/." "$S/base/"; done
cp -a "$S/base/." "$S/final/"; cp -a "$C/src/." "$S/final/"
mkpatch() {  # mkpatch FROMDIR TODIR OUT FILELIST...
  local from=$1 to=$2 out=$3; shift 3; : > "$out"
  for f in "$@"; do
    local old="$from/$f"; [ -f "$old" ] || old=/dev/null
    cmp -s "$old" "$to/$f" && continue
    git diff --no-index --no-color --full-index "$old" "$to/$f" | sed -e "s|^diff --git a/.* b/.*|diff --git a/$f b/$f|" -e "s|^--- a/.*|--- a/$f|" -e "s|^+++ b/.*|+++ b/$f|" >> "$out" || true
  done
}
mapfile -t OWN < <(rel "$C/src"); mapfile -t ALL < <(all)
mkpatch "$S/base" "$S/final" "$C/composition.patch" "${OWN[@]}"
mkpatch "$S/main" "$S/final" "$C/combined.patch" "${ALL[@]}"
check() {  # check FROMDIR PATCH FILES...
  local d; d=$(mktemp -d "$S/apply.XXXXXX"); cp -a "$1/." "$d/"; local p=$2; shift 2
  git -C "$d" init -q; git -C "$d" apply --check "$p"; git -C "$d" apply "$p"
  for f in "$@"; do cmp -s "$d/$f" "$S/final/$f" || { echo "MISMATCH $f"; exit 1; }; done
}
check "$S/base" "$C/composition.patch" "${OWN[@]}"
check "$S/main" "$C/combined.patch" "${ALL[@]}"
{ echo "native-policy-composition patches ($(date -Iseconds)); main work/enclave HEAD $(git -C "$E" rev-parse HEAD)"
  echo "composition.patch sha256 $(sha256sum "$C/composition.patch" | cut -c1-64)  (base = main + layers/native-access + layers/policy-prereq)"
  echo "combined.patch    sha256 $(sha256sum "$C/combined.patch" | cut -c1-64)  (base = CURRENT main)"
  echo "both: git apply --check ok on scratch copies; applied result byte-identical to the composed files"
  echo "file | CURRENT main sha256 | composed (final) sha256 | from"
  for f in "${ALL[@]}"; do
    from=$( [ -f "$C/src/$f" ] && echo composition || { [ -f "$C/layers/policy-prereq/$f" ] && echo "policy owner (verbatim)" || echo "native-access (frozen, verbatim)"; } )
    m=$( [ -f "$E/$f" ] && sha256sum "$E/$f" | cut -c1-64 || echo "(new)")
    echo "  $f"; echo "      main  $m"; echo "      final $(sha256sum "$S/final/$f" | cut -c1-64)  [$from]"
  done
} > "$C/MANIFEST.txt"
cat "$C/MANIFEST.txt"
