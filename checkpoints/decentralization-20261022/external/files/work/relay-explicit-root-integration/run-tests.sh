#!/usr/bin/env bash
# Runs this candidate against CURRENT work/enclave without writing to it. Overlay = main (symlinks) + layers:
#   LAYER_SET=main     src/                                   (the patch on current main)
#   LAYER_SET=storage  layers-storage/ + src-after-storage/   (storage-front-binding's relay sources, verbatim from its
#                                                              frozen patches, composed with this candidate)
# Every directory that holds an overlay file is a per-file symlink tree; a write whose realpath leaves the overlay is
# refused. Main's touched paths, the coordinating workers' frozen inputs and this candidate's sources are hashed before
# and after; any change fails the run. All paths are absolute; the log must be under evidence/.
# Usage: [LAYER_SET=...] [TEST_NAME_PATTERN=...] run-tests.sh OUT.log test/a.test.mjs [...]
set -euo pipefail
C=$(cd "$(dirname "$0")" && pwd -P); W=$(cd "$C/.." && pwd -P); E=$(cd "$W/enclave" && pwd -P)
LOG=$(realpath -m -- "${1:?log}"); shift
case "$LOG" in "$C"/evidence/*) ;; *) echo "log must be under $C/evidence"; exit 2;; esac
[ $# -gt 0 ] || { echo "tests required"; exit 2; }
TESTS=("$@")
case "${LAYER_SET:-main}" in
  main) LAYERS=("$C/src") ;;
  storage) LAYERS=("$C/src" "$C/layers-storage" "$C/src-after-storage") ;;
  front) LAYERS=("$C/src" "$C/layers-front" "$C/src-after-storage") ;;  # storage-front-cold-history's relay feature files, verbatim
  policy) LAYERS=("$C/layers-policy" "$C/src") ;;  # the policy worker's changed relay sources + built bundle, verbatim
  negative) LAYERS=("$C/src" "$C/negative") ;;   # control: main's OLD deploy.sh under the new tests (must fail)
  *) echo "LAYER_SET main|storage|front|policy|negative"; exit 2 ;;
esac
FROZEN=("$W/storage-front-binding/patches" "$W/existing-custody-audit/candidate/final/check/relay/deploy.sh" "$C/src" "$C/src-after-storage" "$C/layers-storage" "$C/base" "$C/negative" "$C/layers-policy" "$C/layers-front" "$C/frozen-6019b92b")
files() { for L in "${LAYERS[@]}"; do (cd "$L" && find . -type f | sed 's|^\./||'); done | sort -u; }
state() {
  files | while read -r f; do if [ -e "$E/$f" ]; then sha256sum "$E/$f"; else echo "absent $E/$f"; fi; done
  for t in "${TESTS[@]}"; do [ -e "$E/$t" ] && sha256sum "$E/$t" || echo "absent $E/$t"; done
  sha256sum "$E/relay/deploy.sh" "$E/.github/workflows/deploy.yml"
  for x in "${FROZEN[@]}"; do if [ -d "$x" ]; then (cd "$x" && find . -type f | sort | xargs sha256sum | sed "s|  \./|  $x/|"); else sha256sum "$x"; fi; done
}
BEFORE=$(state)
O=$(mktemp -d "$C/overlay.XXXXXX"); O=$(cd "$O" && pwd -P); trap 'rm -rf -- "$O"' EXIT
REAL=$( { echo relay; echo test; echo network; files | awk -F/ 'NF > 1 { print $1 }'; printf '%s\n' "${TESTS[@]}" | cut -d/ -f1; } | sort -u)
for entry in "$E"/* "$E"/.[!.]*; do
  name=$(basename "$entry"); if [ "$name" = .git ] || grep -qx -- "$name" <<<"$REAL"; then continue; fi; ln -s "$entry" "$O/$name"
done
for d in $REAL; do if [ -d "$E/$d" ]; then cp -as "$E/$d" "$O/$d"; else mkdir -p "$O/$d"; fi; done
put() {  # put SRC REL
  mkdir -p "$(dirname "$O/$2")"
  case "$(realpath "$(dirname "$O/$2")")" in "$O"|"$O"/*) ;; *) echo "refusing to write outside the overlay: $2"; exit 4;; esac
  rm -f -- "$O/$2"; cp -- "$1" "$O/$2"
}
for L in "${LAYERS[@]}"; do (cd "$L" && find . -type f | sed 's|^\./||') | while read -r f; do put "$L/$f" "$f"; done; done
for t in "${TESTS[@]}"; do if [ -L "$O/$t" ]; then put "$E/$t" "$t"; fi; [ -f "$O/$t" ] || { echo "test file missing from the overlay: $t"; exit 3; }; done
[ "$(state)" = "$BEFORE" ] || { echo "a protected file changed while building the overlay"; exit 5; }
# prove the overlay runs the candidate's deploy script (a real file, not main's)
want="${LAYERS[${#LAYERS[@]}-1]}/relay/deploy.sh"
[ ! -L "$O/relay/deploy.sh" ] && cmp -s "$O/relay/deploy.sh" "$want" || { echo "overlay does not hold the candidate deploy.sh" > "$LOG"; exit 3; }
cd "$O"
{ echo "overlay of $E (HEAD $(git -C "$E" rev-parse HEAD)); LAYER_SET=${LAYER_SET:-main}; layers in order:"
  for L in "${LAYERS[@]}"; do echo "  $L"; (cd "$L" && find . -type f | sort | xargs sha256sum | sed 's/^/    /'); done
  echo "node $(node --version); bash $BASH_VERSION; tests: ${TESTS[*]}${TEST_NAME_PATTERN:+ (pattern: $TEST_NAME_PATTERN)}"; } > "$LOG"
set +e
node --test --test-timeout=180000 --test-concurrency=1 ${TEST_NAME_PATTERN:+--test-name-pattern="$TEST_NAME_PATTERN"} "${TESTS[@]}" >> "$LOG" 2>&1; rc=$?
if [ "$(state)" = "$BEFORE" ]; then echo "protected files unchanged by this run (main touched paths, coordinating inputs, candidate sources)" >> "$LOG"; else echo "PROTECTED FILE CHANGED during the run" >> "$LOG"; rc=5; fi
echo "EXIT $rc" >> "$LOG"; exit $rc
