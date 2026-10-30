#!/bin/bash
# retention-live-controller-stage/r2: ROOT operational controller for the SECOND (cached retention) Base download. PREPARED; never run
# by Claude. Successor of the frozen r1 (stage SHA256SUMS d17f0683, unchanged). Uses ONLY base-retention-stage/activation-r2
# (SHA256SUMS 409b8ed2; never edited) through its own retention_activate.sh install/check/start/status/stop (no direct systemctl).
#
# Run (root review first; ONE queue allocation of 4096 MiB for its whole life; not under unshare: it needs the guest ssh):
#   jobs/q-exit-status.sh <name> 4096 bash retention-live-controller-stage/r2/retention-live-controller.sh \
#       --resource-window=<root window id> --max-hours=<root limit> [--precheck-only]
#
# r2 changes (see logs/claude-retention-controller-review.md):
#  * OWNERSHIP BOUNDARY. The retention unit must be inactive/failed before start (anything else: refuse, rc 8, never adopted, never
#    stopped). Its InvocationID (INV0) is recorded; the run OWNS only a NEW InvocationID (!= INV0) that appears after its start was
#    issued, and `stop` is issued only after re-reading that the unit is still running exactly that InvocationID. An unknown start
#    outcome (ssh timeout / lost response) is resolved by observation; a definite refusal (rc 3 "REFUSED:") owns nothing.
#  * Completion / failure count only for the owned InvocationID: a stale inactive/dead or failed unit carrying INV0 is never ours.
#  * Every guest call runs in the background and is waited on, so INT/TERM/HUP and the memory watchdog act at once instead of after
#    a 60 s ssh call. The host MemAvailable watchdog is a separate 5 s sampler that signals the controller (USR1).
#  * status.txt is parsed as the activation script's exact output: systemctl key=value lines, then ONE JSON document, nothing after.
# Exit: 0 success | 2 usage | 3 precondition/guard refusal | 4 memory breach | 5 ssh/guest failure or unknown start | 6 state |
#       7 --max-hours | 8 a retention run already active/activating (not ours: untouched) | 130 signal
set -uo pipefail
export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
A=$P/base-retention-stage/activation-r2
A_SUMS=409b8ed25a2f5096783c5a8d9acf3e330450d37265850d68d5c4f9a58160bc92
REMOTE=/opt/enclave-rpc/retention-stage/activation-r2-409b8ed2        # immutable staged copy inside the guest
U=enclave-base-retention.service FIRST=enclave-rpc-base-snapshot.service HOLDER=enclave-base-holder
ROOTD=/srv/enclave-base-holder
FLOOR_KIB=$((16 * 1024 * 1024)) START_KIB=$((20 * 1024 * 1024))
POLL=60 MEMPOLL=5 START_WINDOW=120 HOUR=3600 GTO=60 STOP_TO=240
SSH=(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config -o BatchMode=yes -o ConnectTimeout=10
     -o ServerAliveInterval=15 -o ServerAliveCountMax=3 enclave-rpc)
MEMINFO=/proc/meminfo OUTROOT=$P/logs
if [ -n "${RLC_TEST_ROOT:-}" ]; then                    # OFFLINE TESTS ONLY (tests/test_controller.py): overrides must live in tmp
  for v in "$RLC_TEST_ROOT" "${RLC_TEST_SSH:?}"; do [[ $v == /tmp/* || $v == "${TMPDIR:-/nonexistent}"/* ]] || { echo "test override outside tmp"; exit 2; }; done
  SSH=("$RLC_TEST_SSH"); MEMINFO=$RLC_TEST_ROOT/meminfo; OUTROOT=$RLC_TEST_ROOT/out
  POLL=${RLC_TEST_POLL:-1} MEMPOLL=1 START_WINDOW=${RLC_TEST_START_WINDOW:-5} HOUR=${RLC_TEST_HOUR:-3600} GTO=${RLC_TEST_GTO:-5} STOP_TO=${RLC_TEST_STOP_TO:-10}
fi
WIN= MAXH= PRECHECK=0
for a in "$@"; do case "$a" in
  --resource-window=?*) WIN=${a#*=} ;; --max-hours=?*) MAXH=${a#*=} ;; --precheck-only) PRECHECK=1 ;;
  *) echo "usage: $0 --resource-window=<id> --max-hours=<n> [--precheck-only]"; exit 2 ;; esac; done
[[ "$WIN" =~ ^[A-Za-z0-9._:-]{3,64}$ ]] || { echo "REFUSED: an explicit --resource-window=<root window id> is required"; exit 2; }
[[ "$MAXH" =~ ^[0-9]{1,3}$ ]] && [ "$MAXH" -ge 1 ] || { echo "REFUSED: --max-hours=<1..999> (root's limit) is required"; exit 2; }
OUT=$OUTROOT/root-retention-live-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$OUT/tmp" || exit 9
START_ISSUED=0 INV0= OWNED= DONE=0 GPID= WD= MAIN=$$
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$OUT/controller.log"; }
avail_kib() { awk '/^MemAvailable:/ {print $2}' "$MEMINFO"; }
# g OUTFILE CMD: one bounded guest call, backgrounded + waited (traps run immediately); rc of the call
g() { local o=$1; shift; timeout -k 5 "$GTO" "${SSH[@]}" "$@" > "$o" 2>&1 < /dev/null & GPID=$!; local rc=0; wait "$GPID" || rc=$?; GPID=; return $rc; }
nap() { sleep "$1" & GPID=$!; wait "$GPID"; GPID=; }          # interruptible: traps are not deferred by a 60 s sleep
# gs OUTFILE ERRFILE CMD: like g, stderr kept apart (machine-parsed outputs)
gs() { local o=$1 e=$2; shift 2; timeout -k 5 "$GTO" "${SSH[@]}" "$@" > "$o" 2> "$e" < /dev/null & GPID=$!; local rc=0; wait "$GPID" || rc=$?; GPID=; return $rc; }
units() { g "$1" "systemctl show $FIRST $HOLDER.service $HOLDER.path $U enclave-l1-el.service enclave-l1-cl.service \
  -p Id -p LoadState -p ActiveState -p SubState -p Result -p ExecMainStatus -p MainPID -p UnitFileState -p InvocationID"; }
prop() { awk -v id="$1" -v k="$2" 'BEGIN{RS="";FS="\n"} {for(i=1;i<=NF;i++) if($i=="Id=" id) for(j=1;j<=NF;j++) if(index($j,k"=")==1) print substr($j,length(k)+2)}' "$3"; }
running() { case "$1" in activating/*|active/*|deactivating/*|reloading/*) return 0;; esac; return 1; }

stop_own() {   # stop ONLY a retention invocation this run started, and only while the unit still runs exactly that invocation
  [ "$START_ISSUED" = 1 ] || return 0
  local f=$OUT/units-stopcheck.txt inv st
  units "$f" || { log "STOP NOT CONFIRMED: guest unreachable; root must inspect $U (ours: ${OWNED:-unresolved}, pre-start ${INV0:-none})"; return; }
  inv=$(prop $U InvocationID "$f"); st="$(prop $U ActiveState "$f")/$(prop $U SubState "$f")"
  if [ -z "$OWNED" ] && [ -n "$inv" ] && [ "$inv" != "$INV0" ]; then OWNED=$inv; log "a new invocation $inv appeared after our start: ours"; fi
  [ -n "$OWNED" ] || { log "no invocation of ours was observed (unit $st, InvocationID ${inv:-none} = pre-start): nothing stopped"; return; }
  [ "$inv" = "$OWNED" ] || { log "unit runs invocation ${inv:-none}, NOT ours ($OWNED): NOT stopped (another run is never touched)"; return; }
  running "$st" || { log "our invocation $OWNED already ended ($st): nothing to stop"; return; }
  log "stopping ONLY our invocation $OWNED of $U via retention_activate.sh stop (resumable; nothing deleted)"
  timeout -k 5 "$STOP_TO" "${SSH[@]}" "sudo -n $REMOTE/retention_activate.sh stop" >> "$OUT/stop.txt" 2>&1 < /dev/null & GPID=$!
  wait "$GPID" || log "STOP COULD NOT BE CONFIRMED (ssh/guest): root must run 'sudo $REMOTE/retention_activate.sh stop' in the guest if $OWNED still runs"
  GPID=
}
finish() {
  local rc=$?; trap - USR1 INT TERM HUP
  [ -n "$WD" ] && kill "$WD" 2>/dev/null; [ -n "$GPID" ] && { kill "$GPID" 2>/dev/null; wait "$GPID" 2>/dev/null; GPID=; }
  [ "$DONE" = 1 ] || stop_own
  log "exit rc=$rc window=$WIN owned=${OWNED:-none} prestart=${INV0:-none}"; exit $rc; }
trap finish EXIT
trap 'log "signal: stopping our invocation only"; exit 130' INT TERM HUP
trap 'log "host MemAvailable below the 16 GiB floor (watchdog): stopping our invocation only"; exit 4' USR1
fail() { log "FAIL: $*"; exit "${2:-3}"; }

log "window=$WIN max_hours=$MAXH precheck_only=$PRECHECK out=$OUT"
# 1. local pins (activation-r2 is reviewed and frozen; this controller never edits it)
[ "$(sha256sum < "$A/SHA256SUMS" | cut -c1-64)" = "$A_SUMS" ] || fail "activation-r2 SHA256SUMS is not $A_SUMS"
(cd "$A" && sha256sum -c --quiet SHA256SUMS) || fail "activation-r2 files differ from their SHA256SUMS"
# 2. host memory (physical): 16 GiB floor + 4 GiB unit MemoryMax before anything
[ "$(avail_kib)" -ge "$START_KIB" ] || fail "host MemAvailable $(avail_kib) KiB < 20 GiB"
# 3. receipts
units "$OUT/units-before.txt" || fail "ssh/guest unreachable" 5
g "$OUT/guest-before.txt" "free -m; df -B1 $ROOTD; ls -l $ROOTD" || fail "ssh/guest unreachable" 5
f="$OUT/units-before.txt"
# 4. no retention run of anyone else: refuse, never adopt, never stop
st="$(prop $U ActiveState "$f")/$(prop $U SubState "$f")"
case "$st" in inactive/*|failed/*|/) ;; *) fail "$U is already $st (InvocationID $(prop $U InvocationID "$f")): another run is never adopted or stopped" 8;; esac
# 5. first download finished successfully, marker present; holder inactive+disabled
[ "$(prop $FIRST ActiveState "$f")/$(prop $FIRST SubState "$f")" = "inactive/dead" ] || fail "$FIRST is not inactive/dead (still running?): no install/start"
[ "$(prop $FIRST Result "$f")" = success ] && [ "$(prop $FIRST ExecMainStatus "$f")" = 0 ] || fail "$FIRST did not finish with Result=success ExecMainStatus=0"
g "$OUT/snapshot-marker.txt" "sudo -n test -f $ROOTD/snapshot-complete -a ! -L $ROOTD/snapshot-complete && sudo -n stat -c %U $ROOTD/snapshot-complete" \
  && [ "$(cat "$OUT/snapshot-marker.txt")" = root ] || fail "snapshot-complete is not a root-owned regular file"
for h in $HOLDER.service $HOLDER.path; do
  case "$(prop $h ActiveState "$f")" in inactive|failed) ;; *) fail "$h is active/activating";; esac
  case "$(prop $h UnitFileState "$f")" in disabled|masked|masked-runtime) ;; *) fail "$h is not disabled";; esac
done
# 6. no concurrent guest capture (heuristic: any active unit named *capture*; root's window flag asserts the rest)
g "$OUT/capture-units.txt" "systemctl list-units --all --state=active,activating --plain --no-legend '*capture*'" || fail "ssh/guest unreachable" 5
[ ! -s "$OUT/capture-units.txt" ] || fail "a guest capture unit is active: $(head -c 300 "$OUT/capture-units.txt")"
log "prechecks passed (no retention run active, first download done, marker root-owned, holder inactive+disabled, no capture unit)"
[ "$PRECHECK" = 1 ] && { DONE=1; log "precheck-only: nothing staged, installed or started"; exit 0; }

# 7. stage the exact reviewed files at an immutable guest path (never overwritten; re-verified if present)
FILES=$(cd "$A" && awk '{sub(/^\.\//,"",$2); print $2}' SHA256SUMS)
if g "$OUT/tmp/stage-test.txt" "sudo -n test -e $REMOTE"; then
  log "staged copy exists: verifying, never overwriting"
else
  g "$OUT/tmp/stage-dir.txt" "sudo -n install -d -o root -g root -m 0755 $(dirname $REMOTE) && sudo -n mkdir -m 0700 $REMOTE" || fail "stage dir"
  (cd "$A" && tar -cf - SHA256SUMS $FILES) | timeout -k 5 "$GTO" "${SSH[@]}" "sudo -n tar -xf - -C $REMOTE --no-same-owner" > "$OUT/tmp/stage-copy.txt" 2>&1 \
    || fail "stage copy"
  g "$OUT/tmp/stage-modes.txt" "sudo -n sh -c 'chmod 0444 $REMOTE/*; chmod 0555 $REMOTE/retention_activate.sh; chmod 0555 $REMOTE'" || fail "stage modes"
fi
g "$OUT/staged.txt" "cd $REMOTE && sudo -n sha256sum SHA256SUMS && sudo -n sha256sum -c --quiet SHA256SUMS && sudo -n stat -c '%U %a %n' . *" \
  || fail "staged copy does not verify"
[ "$(head -1 "$OUT/staged.txt" | cut -c1-64)" = "$A_SUMS" ] || fail "staged SHA256SUMS is not $A_SUMS"
# 8. install + check through the reviewed script only (check prints the guard's `pre` JSON on stdout; stderr kept apart)
g "$OUT/install.txt" "sudo -n $REMOTE/retention_activate.sh install" || fail "retention_activate.sh install refused (see install.txt)"
gs "$OUT/check.json" "$OUT/check.err" "sudo -n $REMOTE/retention_activate.sh check"; crc=$?
[ "$crc" = 0 ] || fail "the guard refused (rc $crc; check.json): not started"
python3 -I -c 'import json,sys; j=json.load(open(sys.argv[1])); assert j["admitted"] is True and not j["refusals"], j' "$OUT/check.json" \
  || fail "check.json is not an admission"
# 9. memory again; record the pre-start state + InvocationID; the unit must still be idle; then start
[ "$(avail_kib)" -ge "$START_KIB" ] || fail "host MemAvailable dropped below 20 GiB before start"
units "$OUT/units-prestart.txt" || fail "ssh/guest unreachable" 5
st="$(prop $U ActiveState "$OUT/units-prestart.txt")/$(prop $U SubState "$OUT/units-prestart.txt")"
case "$st" in inactive/*|failed/*) ;; *) fail "$U became $st before our start: another run is never adopted or stopped" 8;; esac
INV0=$(prop $U InvocationID "$OUT/units-prestart.txt"); start_t=$(date +%s)
( while kill -0 "$MAIN" 2>/dev/null; do a=$(avail_kib); { [ -n "$a" ] && [ "$a" -ge "$FLOOR_KIB" ]; } || { echo "$(date -u +%FT%TZ) MemAvailable=${a:-unreadable}" >> "$OUT/memory-breach.txt"; kill -USR1 "$MAIN"; exit 0; }
    echo "$(date +%s) $a" >> "$OUT/memory.txt"; sleep "$MEMPOLL"; done ) & WD=$!
START_ISSUED=1
g "$OUT/start.txt" "sudo -n $REMOTE/retention_activate.sh start"; src=$?
if [ "$src" = 0 ]; then log "start issued (pre-start InvocationID ${INV0:-none}); observing"
elif [ "$src" = 3 ] && grep -q '^REFUSED:' "$OUT/start.txt"; then
  START_ISSUED=0; fail "retention_activate.sh start refused (start.txt): nothing was started by this run" 3
else log "start outcome UNKNOWN (rc $src: ssh/timeout); resolving ownership by observation only"; fi
log "observing (memory every ${MEMPOLL} s by the watchdog, guest every ${POLL} s, limit ${MAXH} h)"

# 10. observe: only the owned (new) InvocationID counts
deadline=$(( start_t + MAXH * HOUR ))
while :; do
  now=$(date +%s)
  [ "$now" -lt "$deadline" ] || fail "--max-hours=$MAXH reached: stopping our invocation (resumable)" 7
  f="$OUT/units-now.txt"
  units "$f" || fail "ssh/guest recheck failed: stopping our invocation" 5
  for h in $HOLDER.service $HOLDER.path; do
    case "$(prop $h ActiveState "$f")" in inactive|failed) ;; *) fail "$h became active during retention" 6;; esac
  done
  st="$(prop $U ActiveState "$f")/$(prop $U SubState "$f")"; res=$(prop $U Result "$f"); ex=$(prop $U ExecMainStatus "$f")
  inv=$(prop $U InvocationID "$f")
  printf '%s %s %s %s inv=%s MemAvailableKiB=%s\n' "$(date -u +%FT%TZ)" "$st" "$res" "$ex" "${inv:-none}" "$(avail_kib)" >> "$OUT/observe.txt"
  if [ -z "$OWNED" ]; then
    if [ -n "$inv" ] && [ "$inv" != "$INV0" ]; then OWNED=$inv; log "our invocation: $OWNED"
      [ "$src" = 0 ] || fail "the start response was lost (rc $src): our invocation $OWNED is stopped (resumable); rerun when the channel is reliable" 5
    else                                                                    # stale state of INV0 is never ours (never a completion)
      [ $((now - start_t)) -le "$START_WINDOW" ] || fail "no new invocation within ${START_WINDOW} s of our start ($st, InvocationID ${inv:-none} = pre-start): nothing of ours to stop" "$([ "$src" = 0 ] && echo 6 || echo 5)"
      nap "$POLL"; continue
    fi
  fi
  [ "$inv" = "$OWNED" ] || fail "$U now runs invocation ${inv:-none}, not ours ($OWNED): it is not touched" 6
  case "$st" in
    activating/*|active/*) ;;
    inactive/dead) [ "$res" = success ] && [ "$ex" = 0 ] || fail "our invocation ended with Result=$res ExecMainStatus=$ex" 6; break ;;
    failed/*) fail "our invocation failed (Result=$res ExecMainStatus=$ex): nothing deleted; inspect status" 6 ;;
    *) fail "$U in unexpected state $st" 6 ;;
  esac
  nap "$POLL"
done
kill "$WD" 2>/dev/null; WD=

# 11. terminal validation (no activation of anything)
gs "$OUT/status.txt" "$OUT/status.err" "sudo -n $REMOTE/retention_activate.sh status" || fail "status failed" 6
gs "$OUT/retention-complete.txt" "$OUT/retention-complete.err" "sudo -n test -f $ROOTD/retention-complete -a ! -L $ROOTD/retention-complete && sudo -n stat -c %U $ROOTD/retention-complete && sudo -n cat $ROOTD/retention-complete" \
  || fail "retention-complete marker absent" 6
python3 -I - "$OUT/status.txt" "$OUT/retention-complete.txt" <<'PY' || fail "status/marker do not show a complete retention" 6
import json, sys
t = open(sys.argv[1]).read()
head, sep, rest = t.partition('\n{')                      # retention_activate.sh status: systemctl key=value lines, then the guard JSON
assert sep, 'no JSON document in status output'
kv = dict(l.split('=', 1) for l in head.splitlines() if '=' in l)
assert (kv.get('ActiveState'), kv.get('SubState'), kv.get('Result'), kv.get('ExecMainStatus')) == ('inactive', 'dead', 'success', '0'), kv
j, end = json.JSONDecoder().raw_decode('{' + rest)
assert ('{' + rest)[end:].strip() == '', 'trailing output after the status JSON'
assert j.get('retentionComplete') is True and j.get('missingArchives') == 0 and j.get('partialExtraction') == [] and j.get('datadirUsers') == [], j
m = open(sys.argv[2]).read().split('\n', 1)
assert m[0] == 'root', 'marker not root-owned'
r = json.loads(m[1])
assert r.get('format') == 'enclave-base-retention-complete/v1' and r.get('archives') == 26 \
    and r.get('manifestSha256') == '1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2', r
print('status + marker: retention complete (26 archives, pinned manifest)')
PY
units "$OUT/units-after.txt" || fail "ssh/guest unreachable at the end" 5
[ "$(prop $U InvocationID "$OUT/units-after.txt")" = "$OWNED" ] || fail "the final unit state is not our invocation" 6
for k in "$FIRST" enclave-l1-el.service enclave-l1-cl.service; do
  [ "$(prop $k MainPID "$OUT/units-before.txt")" = "$(prop $k MainPID "$OUT/units-after.txt")" ] || fail "$k MainPID changed during the run" 6
done
for h in $HOLDER.service $HOLDER.path; do
  case "$(prop $h UnitFileState "$OUT/units-after.txt")" in disabled|masked|masked-runtime) ;; *) fail "$h is no longer disabled" 6;; esac
done
DONE=1
log "SUCCESS: our invocation $OWNED completed; marker + status validated; holder still disabled; nothing activated"
exit 0
