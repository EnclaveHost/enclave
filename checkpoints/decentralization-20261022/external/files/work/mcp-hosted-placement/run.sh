#!/usr/bin/env bash
# Runs test steps against CURRENT work/enclave + this candidate's src/ without writing to either. Overlay: main's top-level
# entries symlinked, except test/, relay/ and every top-level directory holding a src/ file, which are REAL copies
# (Node resolves relative imports from a module's realpath, so an overlaid file must sit beside real siblings);
# node_modules inside them stay symlinks to main's. main's touched paths and src/ are hashed before and after.
# Usage: run.sh evidence/OUT.log STEP...
set -uo pipefail
C=$(cd "$(dirname "$0")" && pwd -P); W=$(cd "$C/.." && pwd -P); E=$(cd "$W/enclave" && pwd -P)
LOG=$(realpath -m -- "${1:?log}"); shift
case "$LOG" in "$C"/evidence/*) ;; *) echo "log must be under $C/evidence"; exit 2;; esac
[ $# -gt 0 ] || { echo "steps required"; exit 2; }
files() { (cd "$C/src" && find . -type f | sed 's|^\./||' | sort); }
state() {
  files | while read -r f; do if [ -e "$E/$f" ]; then sha256sum "$E/$f"; else echo "absent $E/$f"; fi; done
  (cd "$E" && sha256sum relay/*.js relay/*.mjs cli/*.mjs network/*.mjs 2>/dev/null)
  (cd "$C/src" && find . -type f | sort | xargs -r sha256sum)
}
BEFORE=$(state)
O=$(mktemp -d "$C/overlay.XXXXXX"); O=$(cd "$O" && pwd -P); trap 'rm -rf -- "$O"' EXIT
REAL=$( { echo test; echo relay; files | cut -d/ -f1; } | sort -u)
for entry in "$E"/* "$E"/.[!.]*; do
  name=$(basename "$entry"); if [ "$name" = .git ] || grep -qx -- "$name" <<<"$REAL"; then continue; fi; ln -s "$entry" "$O/$name"
done
for d in $REAL; do
  if [ -d "$E/$d" ]; then (cd "$E/$d" && tar --exclude=./node_modules -cf - .) | (mkdir -p "$O/$d" && cd "$O/$d" && tar -xf -)
    [ -e "$E/$d/node_modules" ] && ln -s "$E/$d/node_modules" "$O/$d/node_modules"
  else mkdir -p "$O/$d"; fi
done
files | while read -r f; do
  mkdir -p "$(dirname "$O/$f")"
  case "$(realpath "$(dirname "$O/$f")")" in "$O"|"$O"/*) ;; *) echo "refusing to write outside the overlay: $f"; exit 4;; esac
  rm -f -- "$O/$f"; cp -- "$C/src/$f" "$O/$f"
done || exit 4
cd "$O"
{ echo "overlay of $E (HEAD $(git -C "$E" rev-parse HEAD)) + src:"; files | while read -r f; do echo "  $(sha256sum < "$C/src/$f" | cut -c1-64)  $f"; done
  echo "node $(node --version); $(anvil --version 2>/dev/null | head -1); steps: $*"; } > "$LOG"
fail=0
step() { echo "=== STEP $*" >> "$LOG"; "$@" >> "$LOG" 2>&1; local e=$?; echo "=== EXIT $e: $*" >> "$LOG"; [ $e -eq 0 ] || fail=1; }
T="node --test --test-concurrency=1 --test-timeout=240000"
for s in "$@"; do
  case "$s" in
    bundle) mkdir -p "$C/stage"; step node scripts/build-mcp-guest-bundle.mjs --out "$C/stage" ;;
    staged) step cp -- "$C/stage/mcp-server.bundle.mjs" "$C/stage/mcp-server.bundle.mjs.manifest.json" "$O/metal/guest/" ;;   # overlay only: a first run before src/ carries the bundle
    bundle-check) step node scripts/build-mcp-guest-bundle.mjs --check ;;
    legacy) step $T test/mcp.test.mjs test/mcp-sessions.test.mjs test/refund.test.mjs test/transfer.test.mjs ;;
    unit) step $T test/mcp-independent-unit.test.mjs ;;
    e2e) step $T test/mcp-independent.test.mjs ;;
    measured) step env GIT_DIR="$E/.git" $T test/metal-measured-control.test.mjs ;;   # scoped read-only git (git show HEAD:)
    hosted) step $T test/mcp-hosted-control.test.mjs ;;
    *) echo "unknown step $s" >> "$LOG"; fail=1 ;;
  esac
done
rc=$fail
AFTER=$(state)
if [ "$AFTER" = "$BEFORE" ]; then echo "protected files unchanged by this run (main touched paths, candidate sources)" >> "$LOG"
else echo "PROTECTED FILE CHANGED during the run:" >> "$LOG"; diff <(echo "$BEFORE") <(echo "$AFTER") >> "$LOG"; rc=5; fi
echo "EXIT $rc" >> "$LOG"; exit $rc
