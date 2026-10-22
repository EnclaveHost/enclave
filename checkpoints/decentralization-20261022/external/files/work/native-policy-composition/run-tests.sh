#!/usr/bin/env bash
# Runs the composition against CURRENT work/enclave without writing to it. Overlay = main (symlinks) + layers in order:
#   layers/native-access (frozen native-access-parity five files) -> layers/policy-prereq (policy owner's files,
#   verbatim) -> src (this composition). Every directory that holds an overlay file is a per-file symlink tree; a write
#   whose realpath leaves the overlay is refused. Main's touched paths, both frozen originals and this candidate's
#   sources are hashed before and after; any change fails the run.
# Usage: run-tests.sh /abs/or/rel/OUT.log test/a.test.mjs [...]
set -euo pipefail
C=$(cd "$(dirname "$0")" && pwd -P); W=$(cd "$C/.." && pwd -P); E=$(cd "$W/enclave" && pwd -P)
LOG=$(realpath -m -- "${1:?log}"); shift
case "$LOG" in "$C"/evidence/*) ;; *) echo "log must be under $C/evidence"; exit 2;; esac
[ $# -gt 0 ] || { echo "tests required"; exit 2; }
TESTS=("$@")
LAYERS=("$C/layers/native-access" "$C/layers/policy-prereq" "$C/src")
FROZEN=("$W/native-access-parity/src" "$W/native-access-parity/native-access.patch" "$W/existing-custody-audit/candidate/final-r5/check/network/route-record.mjs"
  "$W/existing-custody-audit/candidate/final-r5/check/network/host-policy-runtime.mjs" "$W/existing-custody-audit/candidate/final-r5/check/network/host-policy-adapters.mjs"
  "$W/existing-custody-audit/candidate/final-r5/check/network/public-directory.mjs" "$W/existing-custody-audit/candidate/final-r5/check/test/helpers/platform-policy-world.mjs"
  "$C/layers" "$C/src")
files() { for L in "${LAYERS[@]}"; do (cd "$L" && find . -type f | sed 's|^\./||'); done | sort -u; }
state() {
  files | while read -r f; do if [ -e "$E/$f" ]; then sha256sum "$E/$f"; else echo "absent $E/$f"; fi; done
  for t in "${TESTS[@]}"; do [ -e "$E/$t" ] && sha256sum "$E/$t" || true; done
  for x in "${FROZEN[@]}"; do if [ -d "$x" ]; then (cd "$x" && find . -type f | sort | xargs sha256sum | sed "s|  \./|  $x/|"); else sha256sum "$x"; fi; done
}
BEFORE=$(state)
O=$(mktemp -d "$C/overlay.XXXXXX"); O=$(cd "$O" && pwd -P); trap 'rm -rf -- "$O"' EXIT
REAL=$( { echo network; echo test; echo scripts; files | cut -d/ -f1; printf '%s\n' "${TESTS[@]}" | cut -d/ -f1; } | sort -u)
for entry in "$E"/* "$E"/.[!.]*; do
  name=$(basename "$entry"); if [ "$name" = .git ] || grep -qx -- "$name" <<<"$REAL"; then continue; fi; ln -s "$entry" "$O/$name"
done
for d in $REAL; do [ -d "$E/$d" ] && cp -as "$E/$d" "$O/$d" || mkdir -p "$O/$d"; done
put() {  # put SRC REL
  mkdir -p "$(dirname "$O/$2")"
  case "$(realpath "$(dirname "$O/$2")")" in "$O"|"$O"/*) ;; *) echo "refusing to write outside the overlay: $2"; exit 4;; esac
  rm -f -- "$O/$2"; cp -- "$1" "$O/$2"
}
for L in "${LAYERS[@]}"; do (cd "$L" && find . -type f | sed 's|^\./||') | while read -r f; do put "$L/$f" "$f"; done; done
# entry files are real copies (a symlinked entry resolves to main's path and would import MAIN's modules)
for t in "${TESTS[@]}"; do if [ -L "$O/$t" ]; then put "$E/$t" "$t"; fi; done
# NEGATIVE_CONTROL=1: the pre-composition native client (frozen native-access version, no policy) - the policy tests
# must then FAIL, proving they detect a bypass. Never a deliverable configuration.
if [ "${NEGATIVE_CONTROL:-}" = 1 ]; then put "$C/layers/native-access/network/native-client.mjs" network/native-client.mjs; fi
[ "$(state)" = "$BEFORE" ] || { echo "a protected file changed while building the overlay"; exit 5; }
cd "$O"
[ "${NEGATIVE_CONTROL:-}" = 1 ] || node --input-type=module -e '
  const nc=await import("./network/native-client.mjs"),hp=await import("./network/native-host-policy.mjs"),rr=await import("./network/route-record.mjs");
  if(typeof nc.NativeClient.prototype._withHostDecision!=="function"||typeof nc.NativeClient.prototype.websocket!=="function"||typeof hp.nativeHostPolicy!=="function"||!/hostAdmission/.test(rr.verifyRoute.toString()))process.exit(3);' \
  || { echo "overlay does not load the composition" > "$LOG"; exit 3; }
{ echo "overlay of $E (HEAD $(git -C "$E" rev-parse HEAD)); layers in order:"; for L in "${LAYERS[@]}"; do echo "  $L"; (cd "$L" && find . -type f | sort | xargs sha256sum | sed 's/^/    /'); done
  echo "node $(node --version); tests: ${TESTS[*]}${NEGATIVE_CONTROL:+  (NEGATIVE CONTROL: pre-composition native-client.mjs)}"; } > "$LOG"
set +e
node --test --test-timeout=180000 --test-concurrency=1 "${TESTS[@]}" >> "$LOG" 2>&1; rc=$?
if [ "$(state)" = "$BEFORE" ]; then echo "protected files unchanged by this run (main touched paths, frozen originals, candidate sources)" >> "$LOG"; else echo "PROTECTED FILE CHANGED during the run" >> "$LOG"; rc=5; fi
echo "EXIT $rc" >> "$LOG"; exit $rc
