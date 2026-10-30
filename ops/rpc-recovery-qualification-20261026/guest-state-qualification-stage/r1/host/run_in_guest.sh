#!/bin/bash
# run_in_guest.sh (guest-state-qualification-stage/r1; PREPARED, never run by Claude). HOST, root, ONLY when the RPC VM is on and root has
# admitted it (the VM needs its 64 GiB; Claude prepares no live effects). Through the shared queue, foreground, e.g.:
#   jobs/q-exit-status.sh root-gsq-q1 256 bash guest-state-qualification-stage/r1/host/run_in_guest.sh q1 --timeout=1800 -- --scratch /var/lib/enclave-gsq/q1-<id>
#   jobs/q-exit-status.sh root-gsq-q2 4096 bash .../run_in_guest.sh q2 --timeout=7200 --fixtures=<host fixtures dir> -- <q2 args>
#   jobs/q-exit-status.sh root-gsq-q3 256 bash .../run_in_guest.sh q3 --timeout=900 -- <q3 args>
# Copies the stage's guest script (and for q2 the fixture files) ONE FILE AT A TIME into a new root 0700 dir /var/lib/enclave-gsq/<id>,
# verifies each copy's sha256 in the guest (no tar is used for the transfer), runs `/usr/bin/python3 -I <script> <args>` with a hard
# timeout, and saves the output under the stage logs dir. It never installs, starts, stops or reloads a unit.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
SSH=(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config -o ConnectTimeout=10 -o BatchMode=yes enclave-rpc)
Q=${1:-}; shift || true
T= FX=
while [ $# -gt 0 ]; do case "$1" in --timeout=?*) T=${1#*=}; shift;; --fixtures=?*) FX=${1#*=}; shift;; --) shift; break;; *) echo "usage: $0 q1|q2|q3 --timeout=<s> [--fixtures=<dir>] -- <script args>"; exit 2;; esac; done
case "$Q" in q1) F=guest/q1_b3sum.py;; q2) F=guest/q2_extract_confinement.py;; q3) F=guest/q3_guard_inspect.py;; *) echo "q1|q2|q3"; exit 2;; esac
[[ "$T" =~ ^[0-9]{2,5}$ ]] || { echo "REFUSED: --timeout=<seconds> required"; exit 2; }
if [ "$Q" = q2 ]; then [ -n "$FX" ] || { echo "REFUSED: q2 needs --fixtures=<dir>"; exit 2; }
else [ -z "$FX" ] || { echo "REFUSED: --fixtures is only for q2"; exit 2; }; fi
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "REFUSED: stage != SHA256SUMS"; exit 2; }
ID=$(date -u +%Y%m%dT%H%M%SZ)-$$; REM=/var/lib/enclave-gsq/$ID; OUT=$S/logs/$Q-$ID; mkdir -p "$OUT" || exit 9
put() {   # local-file remote-name
  local h; h=$(sha256sum < "$1" | cut -c1-64)
  timeout -k 10 120 "${SSH[@]}" "sudo -n bash -c 'umask 077; cat > $REM/$2 && [ \"\$(sha256sum < $REM/$2 | cut -c1-64)\" = $h ]'" < "$1" \
    || { echo "REFUSED: copy of $2 failed or differs"; exit 5; }
  echo "$h  $2" >> "$OUT/copied.sha256"; }
timeout -k 10 60 "${SSH[@]}" "sudo -n bash -c 'install -d -m 0700 -o root -g root /var/lib/enclave-gsq && mkdir -m 0700 $REM'" || { echo "REFUSED: guest unreachable"; exit 5; }
put "$S/$F" "$(basename "$F")"
if [ "$Q" = q2 ]; then
  timeout -k 10 60 "${SSH[@]}" "sudo -n mkdir -m 0700 $REM/fixtures" || exit 5
  [ -f "$FX/fixtures.json" ] || { echo "REFUSED: $FX/fixtures.json missing"; exit 2; }
  for f in "$FX"/*.tar.zst "$FX/fixtures.json"; do put "$f" "fixtures/$(basename "$f")"; done
fi
ARGV=(); for x in "$@"; do ARGV+=("${x//@REM@/$REM}"); done            # @REM@ = this run's guest dir (e.g. --fixtures-dir @REM@/fixtures)
ARGS=$(printf ' %q' "${ARGV[@]}")
echo "remote dir $REM; args:$ARGS" | tee "$OUT/run.txt"
timeout -k 30 "$T" "${SSH[@]}" "sudo -n /usr/bin/python3 -I $REM/$(basename "$F")$ARGS" > "$OUT/out.txt" 2>&1 < /dev/null; rc=$?
tail -20 "$OUT/out.txt"; echo "## $Q rc=$rc (guest dir $REM kept as evidence; root removes it after review); outputs $OUT"; exit $rc
