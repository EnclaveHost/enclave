#!/usr/bin/env bash
# Runs the candidate against CURRENT work/enclave without touching it: an overlay of
# symlinks to main, with only this candidate's owned files substituted (real copies).
# Usage: run-tests.sh OUT.log [test files relative to the repo...]
set -euo pipefail
C=$(cd "$(dirname "$0")" && pwd); E=$(cd "$C/../enclave" && pwd)
LOG=$(realpath -m "${1:?log}"); shift
TESTS=("$@"); [ ${#TESTS[@]} -gt 0 ] || TESTS=(test/native-access.test.mjs test/native-client.test.mjs)
O=$(mktemp -d "$C/overlay.XXXXXX"); trap 'rm -rf "$O"' EXIT
# Every top-level directory holding an owned file is a per-file symlink tree, never a
# directory symlink: writing an owned file must never write through into main.
REAL=$( { echo network; echo test; echo scripts; (cd "$C/src" && find . -type f | cut -d/ -f2); } | sort -u)
for entry in "$E"/* "$E"/.[!.]*; do
  name=$(basename "$entry"); if [ "$name" = .git ] || grep -qx "$name" <<<"$REAL"; then continue; fi; ln -s "$entry" "$O/$name"
done
for d in $REAL; do cp -as "$E/$d" "$O/$d"; done
main_state() { (cd "$C/src" && find . -type f | sort) | while read -r f; do [ -e "$E/$f" ] && sha256sum "$E/$f" || echo "absent $f"; done; }
BEFORE=$(main_state)
(cd "$C/src" && find . -type f) | while read -r f; do
  mkdir -p "$(dirname "$O/$f")"
  case "$(realpath "$(dirname "$O/$f")")" in "$O"|"$O"/*) ;; *) echo "refusing to write outside the overlay: $f"; exit 4;; esac
  rm -f "$O/$f"; cp "$C/src/$f" "$O/$f"
done
[ "$(main_state)" = "$BEFORE" ] || { echo "main changed while building the overlay"; exit 5; }
# Entry files must be real copies: Node resolves a symlinked entry to main's path,
# whose relative imports would load MAIN's native-client.mjs instead of the candidate.
for t in "${TESTS[@]}"; do if [ -L "$O/$t" ]; then rm "$O/$t"; cp "$E/$t" "$O/$t"; fi; done
cd "$O"
# Prove which module the tests load.
node -e 'import("./network/native-client.mjs").then(m=>{if(typeof m.NativeClient.prototype.websocket!=="function")process.exit(3)})' || { echo "overlay does not load the candidate" >> "$LOG"; exit 3; }
{ echo "overlay of $E (HEAD $(git -C "$E" rev-parse HEAD)) with:"; (cd "$C/src" && find . -type f | sort | xargs sha256sum);
  echo "node $(node --version); tests: ${TESTS[*]}"; } > "$LOG"
set +e
node --test --test-timeout=120000 --test-concurrency=1 "${TESTS[@]}" >> "$LOG" 2>&1; rc=$?
[ "$(main_state)" = "$BEFORE" ] && echo "main owned paths unchanged by this run" >> "$LOG" || { echo "MAIN CHANGED during the run" >> "$LOG"; rc=5; }
echo "EXIT $rc" >> "$LOG"; exit $rc
