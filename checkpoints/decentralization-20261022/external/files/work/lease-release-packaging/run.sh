#!/usr/bin/env bash
# Runs steps against CURRENT work/enclave + this candidate's src/ without writing to either. Overlay: main symlinked,
# except test/ and contracts/ (real copies: Foundry canonicalizes paths, so its sources must live inside the tree it
# builds) and every directory holding a src/ file (per-file symlink trees + real copies of src/). Writes whose realpath
# leaves the overlay are refused; main's touched paths, the coordinating inputs and src/ are hashed before and after.
# Usage: run.sh OUT.log STEP...   (steps: see the case below; one queue admission runs them serially)
set -uo pipefail
C=$(cd "$(dirname "$0")" && pwd -P); W=$(cd "$C/.." && pwd -P); E=$(cd "$W/enclave" && pwd -P)
LOG=$(realpath -m -- "${1:?log}"); shift
case "$LOG" in "$C"/evidence/*) ;; *) echo "log must be under $C/evidence"; exit 2;; esac
[ $# -gt 0 ] || { echo "steps required"; exit 2; }
# work/app-lease-gas: only the originals this candidate ported (notes/PORTING.txt); the rest of it is other workers' live tree
mapfile -t PORTED < <(sed -n 's|^  [^ ]* <- \([^:]*\):.*|'"$W"'/app-lease-gas/\1|p' "$C/notes/PORTING.txt")
[ ${#PORTED[@]} -ge 20 ] || { echo "notes/PORTING.txt lists ${#PORTED[@]} originals"; exit 2; }
FROZEN=("${PORTED[@]}" "$W/lease-relay-release/stage"
  "$W/windows-lease-source-integration/windows-control-source.tar" "$W/windows-lease-source-integration/staged-source-manifest.json" "$C/src")
files() { (cd "$C/src" && find . -type f | sed 's|^\./||' | sort); }
state() {
  files | while read -r f; do if [ -e "$E/$f" ]; then sha256sum "$E/$f"; else echo "absent $E/$f"; fi; done
  (cd "$E" && sha256sum windows/node/*.mjs network/lease-*.mjs client/lease-*.mjs contracts/EnclaveLease*.sol 2>/dev/null)
  (cd "$E/contracts/foundry/out" && find . -type f | sort | xargs -r sha256sum)
  for x in "${FROZEN[@]}"; do if [ -d "$x" ]; then (cd "$x" && find . -type f | sort | xargs -r sha256sum | sed "s|  \./|  $x/|"); else sha256sum "$x"; fi; done
}
BEFORE=$(state)
O=$(mktemp -d "$C/overlay.XXXXXX"); O=$(cd "$O" && pwd -P); trap 'rm -rf -- "$O"' EXIT
REAL=$( { echo test; echo contracts; echo windows; files | cut -d/ -f1; } | sort -u)
for entry in "$E"/* "$E"/.[!.]*; do
  name=$(basename "$entry"); if [ "$name" = .git ] || grep -qx -- "$name" <<<"$REAL"; then continue; fi; ln -s "$entry" "$O/$name"
done
for d in $REAL; do
  case "$d" in
    test|windows) cp -a "$E/$d" "$O/$d" ;;   # real copies: module URLs (resolve hooks, Foundry paths) stay inside the overlay
    contracts) mkdir -p "$O/contracts"; (cd "$E/contracts" && tar --exclude=./foundry/out --exclude=./foundry/cache -cf - .) | (cd "$O/contracts" && tar -xf -)
               ln -s "$E/contracts/foundry/out" "$O/contracts/foundry/out" ;;   # main's own build, read by the heartbeat rig; hashed below
    *) if [ -d "$E/$d" ]; then cp -as "$E/$d" "$O/$d"; else mkdir -p "$O/$d"; fi ;;
  esac
done
files | while read -r f; do
  mkdir -p "$(dirname "$O/$f")"
  case "$(realpath "$(dirname "$O/$f")")" in "$O"|"$O"/*) ;; *) echo "refusing to write outside the overlay: $f"; exit 4;; esac
  rm -f -- "$O/$f"; cp -- "$C/src/$f" "$O/$f"
done || exit 4
[ "$(state)" = "$BEFORE" ] || { echo "a protected file changed while building the overlay"; exit 5; }
cd "$O"
{ echo "overlay of $E (HEAD $(git -C "$E" rev-parse HEAD)) + src:"; files | while read -r f; do echo "  $(sha256sum < "$C/src/$f" | cut -c1-64)  $f"; done
  echo "node $(node --version); $(forge --version | head -1); $(anvil --version | head -1); steps: $*"; } > "$LOG"
fail=0
step() { echo "=== STEP $*" >> "$LOG"; "$@" >> "$LOG" 2>&1; local e=$?; echo "=== EXIT $e: $*" >> "$LOG"; [ $e -eq 0 ] || fail=1; }
for s in "$@"; do
  case "$s" in
    fixtures) step node --test --test-concurrency=1 test/lease-gas-fixtures.test.mjs ;;
    forge) step node test/helpers/lease-gas-forge.mjs test ;;
    shared) step node --test --test-concurrency=1 test/lease-executor-e2e.test.mjs test/lease-gas-owner-cli.test.mjs test/lease-client-durability.test.mjs \
              test/lease-relay-service.test.mjs test/lease-gas-runtime.test.mjs test/relay-security.test.mjs test/lease-authority.test.mjs ;;
    windows) step node scripts/build-windows-lease-runtime.mjs --check
             step node --test --test-concurrency=1 test/windows-current-runtime.test.mjs test/windows-lease-closure.test.mjs test/windows-host-app-funded.test.mjs test/windows-release-journal.test.mjs ;;
    heartbeat) step node --test --test-concurrency=1 --test-name-pattern "REAL Windows node" test/offchain-heartbeat-writers.test.mjs ;;
    relay-release) LEASE_RELAY_EXPECT_SHA256=d5ca051672b11cb8d42f01096b3b29e6b880963c6fe41c7a21f4d444990af829 step node --test --test-concurrency=1 test/lease-relay-release.test.mjs ;;
    windows-activation) step node --test --test-concurrency=1 test/windows-control-activation.test.mjs ;;
    windows-plan) step bash "$C/notes/windows-plan-evidence.sh" ;;
    *) echo "unknown step $s" >> "$LOG"; fail=1 ;;
  esac
done
rc=$fail
AFTER=$(state)
if [ "$AFTER" = "$BEFORE" ]; then echo "protected files unchanged by this run (main touched paths, coordinating inputs, candidate sources)" >> "$LOG"
else echo "PROTECTED FILE CHANGED during the run:" >> "$LOG"; diff <(echo "$BEFORE") <(echo "$AFTER") >> "$LOG"; rc=5; fi
echo "EXIT $rc" >> "$LOG"; exit $rc
