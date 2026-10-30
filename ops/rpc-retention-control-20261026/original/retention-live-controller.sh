#!/bin/bash
# retention-live-controller-stage: ROOT operational controller for the SECOND (cached retention) Base download, using ONLY the
# validated base-retention-stage/activation-r2 files (SHA256SUMS 409b8ed2; never edited) and its own retention_activate.sh
# install/check/start/status/stop (no direct systemctl start). Same host->guest pattern as root-retention-live-precheck-1047.
#
# Run (root review first; the whole life inside ONE queue allocation of 4096 MiB; not under unshare: it needs the guest ssh):
#   jobs/q-exit-status.sh <name> 4096 bash retention-live-controller-stage/retention-live-controller.sh \
#       --resource-window=<root window id> --max-hours=<root limit> [--precheck-only]
#
# Order: local pins -> host MemAvailable >= 20 GiB -> state receipts -> first download inactive/dead, Result=success,
# ExecMainStatus=0, root-owned snapshot-complete; holder (.service+.path) inactive AND disabled; no active guest *capture* unit
# -> [--precheck-only stops here] -> stage the exact files at an immutable guest path (sha-verified, read-only, never
# overwritten) -> retention_activate.sh install -> check (the reviewed guard: DB users, markers, pins, capacity, memory) ->
# memory re-check -> start -> observe: every 5 s host MemAvailable >= 16 GiB, every POLL s the guest units over ssh.
# Success = the retention unit inactive with Result=success/ExecMainStatus=0, retention-complete present, status
# retentionComplete/missingArchives 0, holder still disabled, L1/snapshot PIDs unchanged. It never activates the holder.
# Any breach, ssh failure, unexpected state, timeout or signal: stop ONLY this retention unit (if this run started it) via
# retention_activate.sh stop (resumable; deletes nothing). The first download, the holder and L1 are never stopped or touched.
set -uo pipefail
export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
A=$P/base-retention-stage/activation-r2
A_SUMS=409b8ed25a2f5096783c5a8d9acf3e330450d37265850d68d5c4f9a58160bc92
REMOTE=/opt/enclave-rpc/retention-stage/activation-r2-409b8ed2        # immutable staged copy inside the guest
U=enclave-base-retention.service FIRST=enclave-rpc-base-snapshot.service HOLDER=enclave-base-holder
ROOTD=/srv/enclave-base-holder
FLOOR_KIB=$((16 * 1024 * 1024)) START_KIB=$((20 * 1024 * 1024)) POLL=60
SSH=(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config -o BatchMode=yes -o ConnectTimeout=10
     -o ServerAliveInterval=15 -o ServerAliveCountMax=3 enclave-rpc)
WIN= MAXH= PRECHECK=0
for a in "$@"; do case "$a" in
  --resource-window=?*) WIN=${a#*=} ;; --max-hours=?*) MAXH=${a#*=} ;; --precheck-only) PRECHECK=1 ;;
  *) echo "usage: $0 --resource-window=<id> --max-hours=<n> [--precheck-only]"; exit 2 ;; esac; done
[[ "$WIN" =~ ^[A-Za-z0-9._:-]{3,64}$ ]] || { echo "REFUSED: an explicit --resource-window=<root window id> is required"; exit 2; }
[[ "$MAXH" =~ ^[0-9]{1,3}$ ]] && [ "$MAXH" -ge 1 ] || { echo "REFUSED: --max-hours=<1..999> (root's limit) is required"; exit 2; }
OUT=$P/logs/root-retention-live-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$OUT" || exit 9
STARTED=0 DONE=0
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$OUT/controller.log"; }
g() { timeout 60 "${SSH[@]}" "$@"; }                     # every guest call is bounded
avail_kib() { awk '/^MemAvailable:/ {print $2}' /proc/meminfo; }
stop_own() {
  [ "$STARTED" = 1 ] || return 0
  log "stopping ONLY $U (started by this run); nothing is deleted, resume later with retention_activate.sh start"
  timeout 240 "${SSH[@]}" "sudo -n $REMOTE/retention_activate.sh stop" >> "$OUT/stop.txt" 2>&1 \
    || log "STOP COULD NOT BE CONFIRMED (ssh/guest): root must run 'sudo $REMOTE/retention_activate.sh stop' in the guest now"
  STARTED=0
}
finish() { rc=$?; [ "$DONE" = 1 ] || stop_own; log "exit rc=$rc window=$WIN"; exit $rc; }
trap finish EXIT
trap 'log "signal: stopping"; exit 130' INT TERM HUP
fail() { log "FAIL: $*"; exit "${2:-3}"; }
units() { g "systemctl show $FIRST $HOLDER.service $HOLDER.path $U enclave-l1-el.service enclave-l1-cl.service \
  -p Id -p LoadState -p ActiveState -p SubState -p Result -p ExecMainStatus -p MainPID -p UnitFileState -p InvocationID"; }
prop() { awk -v id="$1" -v k="$2" 'BEGIN{RS="";FS="\n"} {for(i=1;i<=NF;i++) if($i=="Id=" id) for(j=1;j<=NF;j++) if(index($j,k"=")==1) print substr($j,length(k)+2)}' "$3"; }

log "window=$WIN max_hours=$MAXH precheck_only=$PRECHECK out=$OUT"
# 1. local pins (activation-r2 is reviewed and frozen; this controller never edits it)
[ "$(sha256sum < "$A/SHA256SUMS" | cut -c1-64)" = "$A_SUMS" ] || fail "activation-r2 SHA256SUMS is not $A_SUMS"
(cd "$A" && sha256sum -c --quiet SHA256SUMS) || fail "activation-r2 files differ from their SHA256SUMS"
# 2. host memory (physical): 16 GiB floor + 4 GiB unit MemoryMax before anything
[ "$(avail_kib)" -ge "$START_KIB" ] || fail "host MemAvailable $(avail_kib) KiB < 20 GiB"
# 3. receipts
units > "$OUT/units-before.txt" || fail "ssh/guest unreachable" 5
g "free -m; df -B1 $ROOTD; ls -l $ROOTD" > "$OUT/guest-before.txt" 2>&1 || fail "ssh/guest unreachable" 5
f="$OUT/units-before.txt"
# 4. first download finished successfully, marker present; holder inactive+disabled
[ "$(prop $FIRST ActiveState "$f")/$(prop $FIRST SubState "$f")" = "inactive/dead" ] || fail "$FIRST is not inactive/dead (still running?): no install/start"
[ "$(prop $FIRST Result "$f")" = success ] && [ "$(prop $FIRST ExecMainStatus "$f")" = 0 ] || fail "$FIRST did not finish with Result=success ExecMainStatus=0"
g "sudo -n test -f $ROOTD/snapshot-complete -a ! -L $ROOTD/snapshot-complete && sudo -n stat -c %U $ROOTD/snapshot-complete" > "$OUT/snapshot-marker.txt" 2>&1 \
  && [ "$(cat "$OUT/snapshot-marker.txt")" = root ] || fail "snapshot-complete is not a root-owned regular file"
for h in $HOLDER.service $HOLDER.path; do
  case "$(prop $h ActiveState "$f")" in inactive|failed) ;; *) fail "$h is active/activating";; esac
  case "$(prop $h UnitFileState "$f")" in disabled|masked|masked-runtime) ;; *) fail "$h is not disabled";; esac
done
# 5. no concurrent guest capture (heuristic: any active unit named *capture*; root's window flag asserts the rest)
cap=$(g "systemctl list-units --all --state=active,activating --plain --no-legend '*capture*'") || fail "ssh/guest unreachable" 5
[ -z "$cap" ] || fail "a guest capture unit is active: $cap"
log "prechecks passed (first download done, marker root-owned, holder inactive+disabled, no capture unit)"
[ "$PRECHECK" = 1 ] && { DONE=1; log "precheck-only: nothing staged, installed or started"; exit 0; }

# 6. stage the exact reviewed files at an immutable guest path (never overwritten; re-verified if present)
FILES=$(cd "$A" && awk '{sub(/^\.\//,"",$2); print $2}' SHA256SUMS)
if g "sudo -n test -e $REMOTE"; then
  log "staged copy exists: verifying, never overwriting"
else
  g "sudo -n install -d -o root -g root -m 0755 $(dirname $REMOTE) && sudo -n mkdir -m 0700 $REMOTE" || fail "stage dir"
  (cd "$A" && tar -cf - SHA256SUMS $FILES) | g "sudo -n tar -xf - -C $REMOTE --no-same-owner" || fail "stage copy"
  g "sudo -n sh -c 'chmod 0444 $REMOTE/*; chmod 0555 $REMOTE/retention_activate.sh; chmod 0555 $REMOTE'" || fail "stage modes"
fi
g "cd $REMOTE && sudo -n sha256sum SHA256SUMS && sudo -n sha256sum -c --quiet SHA256SUMS && sudo -n stat -c '%U %a %n' . *" > "$OUT/staged.txt" 2>&1 \
  || fail "staged copy does not verify"
[ "$(head -1 "$OUT/staged.txt" | cut -c1-64)" = "$A_SUMS" ] || fail "staged SHA256SUMS is not $A_SUMS"
# 7. install + check through the reviewed script only
g "sudo -n $REMOTE/retention_activate.sh install" > "$OUT/install.txt" 2>&1 || fail "retention_activate.sh install refused (see install.txt)"
g "sudo -n $REMOTE/retention_activate.sh check" > "$OUT/check.json" 2> "$OUT/check.err"; crc=$?
[ "$crc" = 0 ] || fail "the guard refused (rc $crc; check.json): not started"
python3 -I -c 'import json,sys; j=json.load(open(sys.argv[1])); assert j["admitted"] is True and not j["refusals"], j' "$OUT/check.json" \
  || fail "check.json is not an admission"
# 8. memory again, then start (STARTED is set first: any later failure stops our unit). A never-run oneshot also reads
#    inactive/dead with Result=success, so completion only counts for a NEW InvocationID.
[ "$(avail_kib)" -ge "$START_KIB" ] || fail "host MemAvailable dropped below 20 GiB before start"
units > "$OUT/units-prestart.txt" || fail "ssh/guest unreachable" 5
inv0=$(prop $U InvocationID "$OUT/units-prestart.txt"); start_t=$(date +%s)
STARTED=1
g "sudo -n $REMOTE/retention_activate.sh start" > "$OUT/start.txt" 2>&1 || fail "retention_activate.sh start refused/failed (start.txt)"
log "started $U; observing (memory every 5 s, guest every ${POLL} s, limit ${MAXH} h)"

# 9. observe
deadline=$(( $(date +%s) + MAXH * 3600 )); next=0
while :; do
  a=$(avail_kib)
  [ "$a" -ge "$FLOOR_KIB" ] || fail "host MemAvailable $a KiB < 16 GiB floor: stopping the retention run" 4
  now=$(date +%s)
  [ "$now" -lt "$deadline" ] || fail "--max-hours=$MAXH reached: stopping (resumable)" 7
  if [ "$now" -ge "$next" ]; then
    next=$((now + POLL))
    units > "$OUT/units-now.txt" || fail "ssh/guest recheck failed: stopping our unit" 5
    f="$OUT/units-now.txt"
    for h in $HOLDER.service $HOLDER.path; do
      case "$(prop $h ActiveState "$f")" in inactive|failed) ;; *) fail "$h became active during retention" 6;; esac
    done
    st="$(prop $U ActiveState "$f")/$(prop $U SubState "$f")"; res=$(prop $U Result "$f"); ex=$(prop $U ExecMainStatus "$f")
    inv=$(prop $U InvocationID "$f")
    printf '%s %s %s %s MemAvailableKiB=%s\n' "$(date -u +%FT%TZ)" "$st" "$res" "$ex" "$a" >> "$OUT/observe.txt"
    case "$st" in
      activating/*|active/*) ;;                                           # running (oneshot: activating/start)
      inactive/dead)
        if [ -z "$inv" ] || [ "$inv" = "$inv0" ]; then                   # our start has not begun yet
          [ $((now - start_t)) -le 120 ] || fail "$U never started within 120 s of retention_activate.sh start" 6
          sleep 5; continue
        fi
        STARTED=0                                                         # it ended by itself: nothing to stop
        [ "$res" = success ] && [ "$ex" = 0 ] || fail "$U ended with Result=$res ExecMainStatus=$ex" 6
        break ;;
      failed/*) STARTED=0; fail "$U failed (Result=$res ExecMainStatus=$ex): nothing deleted; inspect status" 6 ;;
      *) fail "$U in unexpected state $st" 6 ;;
    esac
  fi
  sleep 5
done

# 10. terminal validation (no activation of anything)
g "sudo -n $REMOTE/retention_activate.sh status" > "$OUT/status.txt" 2>&1 || fail "status failed" 6
g "sudo -n test -f $ROOTD/retention-complete -a ! -L $ROOTD/retention-complete && sudo -n cat $ROOTD/retention-complete" > "$OUT/retention-complete.json" 2>&1 \
  || fail "retention-complete marker absent" 6
python3 -I - "$OUT/status.txt" <<'PY' || fail "status does not show a complete retention" 6
import json, sys
t = open(sys.argv[1]).read(); j = json.loads(t[t.index("{"):])
assert j.get("retentionComplete") is True and j.get("missingArchives") == 0 and not j.get("partialExtraction"), j
PY
units > "$OUT/units-after.txt" || fail "ssh/guest unreachable at the end" 5
for k in "$FIRST" enclave-l1-el.service enclave-l1-cl.service; do
  [ "$(prop $k MainPID "$OUT/units-before.txt")" = "$(prop $k MainPID "$OUT/units-after.txt")" ] || fail "$k MainPID changed during the run" 6
done
for h in $HOLDER.service $HOLDER.path; do
  case "$(prop $h UnitFileState "$OUT/units-after.txt")" in disabled|masked|masked-runtime) ;; *) fail "$h is no longer disabled" 6;; esac
done
DONE=1
log "SUCCESS: retention complete (marker + status validated); holder still disabled; nothing activated"
exit 0
