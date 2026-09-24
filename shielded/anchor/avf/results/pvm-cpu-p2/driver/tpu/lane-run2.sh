#!/usr/bin/env bash
# lane-run2.sh <label> -- one gated Shielded-TPU decode, FAIL-CLOSED: exit 0 means the run is complete evidence.
#
# lane-run.sh (its predecessor, kept as the driver of the batch it started) moved the results out of logcat
# into the app's capture file, but it could still return 0 on a run that proved nothing: it printed
# "CAPTURE INCOMPLETE" and carried on, its adb calls were unchecked, a final `awk` decided its status, and
# it put ASK inside single quotes, so a prompt with an apostrophe reached the app as something else.
#
# Exit 0 here requires ALL of:
#   * every adb call succeeded, and every remote command's own status was 0 (coolgate.sh's _cg_read: the
#     status is carried back in a marker, nothing is piped on the device)
#   * the label was unused on the device before the launch, and `am start` reported no error
#   * the app's .complete marker exists AND the capture's last line is its footer with status=complete,
#     and no CAPTURE INVALID line
#   * the prompt ARRIVED intact: the app's "LOCAL ask sha256=" equals the digest of ASK as sent
#   * the bundle: the app's sha256 of the file it sent, the VM confirming it holds exactly that file, and (BUNDLE_SHA256=)
#     the one the caller meant
#   * one "LOCAL turn N STATS" and one "VSOCK LOCAL tpu turn N:" record for every scripted turn, "LOCAL done: N
#     scripted turns", a worker that started serving, and no worker ERROR, HOST FAIL, VM error/stop or LOCAL failed
# Anything else exits non-zero and says why. The last line of a good run is "LANE-RUN OK <label>".
#
# LANE_CHECK_ONLY=<log> runs only the evidence checks on a capture already on disk (ASK and BUNDLE_SHA256 still apply).
#   GRAPHS=tpu/g5-h4ds BUNDLE=tpu/lanes-h4ds.etpu MAXNEW=256 ASK='...' EXTRA='--ei tpu_spin 3000' OUT=dir ./lane-run2.sh L
# EXTRA is split on whitespace and each word is quoted for the device; it must not contain quotes itself.
set -uo pipefail
die() { echo "LANE-RUN FAIL ${LABEL:-?}: $*" >&2; exit 1; }
LABEL="${1:-}"; [[ "$LABEL" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "bad label"
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; OUT="${OUT:-.}"; mkdir -p "$OUT" || die "cannot create $OUT"
P=host.enclave.anchor.avf; F=/data/user/0/$P/files
ASK="${ASK:-}"; [ -n "$ASK" ] || die "ASK is required"
case "$ASK" in *$'\n'*|*$'\r'*) die "ASK must be one line";; esac
EXTRA="${EXTRA:-}"; case "$EXTRA" in *\'*|*\"*|*\\*) die "EXTRA must not contain quotes or backslashes";; esac
. "$(cd "$(dirname "$0")/../host" && pwd)/coolgate.sh" || die "cannot source coolgate.sh"
# bash's here-strings need temp files: with /tmp full or over quota they silently read as EMPTY input, and a run was once
# refused as "PHONE NOT AWAKE" when the real cause was the disk. Name that cause before anything depends on it.
_t=$(mktemp 2>/dev/null) && printf x > "$_t" 2>/dev/null && rm -f "$_t" || die "cannot create a temp file in ${TMPDIR:-/tmp} (disk full or over quota): refusing to run"
[ "$(cat <<<probe 2>/dev/null)" = probe ] || die "bash here-strings fail (temp files cannot be created): refusing to run"

# single-quote a word for the device's sh: ' -> '\''
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
rsh() { _cg_read "$1" || die "remote command failed or adb failed: $1"; }
# CPU: a device-side sampler (tpu/cpu-sampler.sh) records every process of the app's uid every LANE_CPU_PERIOD seconds on
# CLOCK_BOOTTIME; tpu/cpu-window.py cuts it to the app's own turn windows and binds ownership (parentage) and identity
# (start time). It replaces a two-sample figure (45b96836) that counted only processes alive at both samples and matched
# the VM's process by a name it does not have. The CPU verdict is printed and saved; it never decides the run. LANE_CPU=0
# turns it off.
SMP=/data/local/tmp/lane-cpu-sampler.sh
cpu_start() {
  [ "${LANE_CPU:-1}" = 1 ] || return 0
  local uid; uid=$(_cg_read "pm list packages -U $P" | sed -n 's/.*uid:\([0-9][0-9]*\).*/\1/p' | head -1)
  [ -n "$uid" ] || { echo "cpu: sampler not started (no uid for $P)"; return 0; }
  $ADB push -q "$(dirname "$0")/cpu-sampler.sh" "$SMP" >/dev/null 2>&1 || { echo "cpu: sampler not started (push failed)"; return 0; }
  CPU_FILE=/data/local/tmp/lane-cpu.$LABEL
  _cg_read "rm -f $CPU_FILE $CPU_FILE.run; touch $CPU_FILE.run" >/dev/null || { CPU_FILE=; return 0; }
  $ADB shell "nohup sh $SMP $uid $CPU_FILE ${LANE_CPU_PERIOD:-0.25} ${LANE_CPU_SCAN_S:-2} </dev/null >/dev/null 2>&1 &" >/dev/null 2>&1
}
cpu_stop() {
  [ -n "${CPU_FILE:-}" ] || return 0
  _cg_read "rm -f $CPU_FILE.run" >/dev/null
  for _ in $(seq 1 20); do _cg_read "tail -1 $CPU_FILE" 2>/dev/null | grep -q '^END$' && break; sleep 0.5; done
  $ADB pull -q "$CPU_FILE" "$OUT/$LABEL.cpusamples" >/dev/null 2>&1 && _cg_read "rm -f $CPU_FILE" >/dev/null
}

if [ -n "${LANE_CHECK_ONLY:-}" ]; then   # re-validate a captured log offline: the same checks, no device
  L="$LANE_CHECK_ONLY"; [ -s "$L" ] || die "no log at $L"
else
cool_gate || exit 4
free=$(rsh "run-as $P sh -c 'if [ -e files/capture/$LABEL.log ] || [ -e files/capture/$LABEL.complete ]; then echo USED; else echo FREE; fi'") || exit 1
[ "$free" = FREE ] || die "label $LABEL is already used on the device (or the check failed)"
rsh "am force-stop $P" >/dev/null || exit 1; sleep 1
rsh "input keyevent KEYCODE_WAKEUP" >/dev/null || exit 1; rsh "wm dismiss-keyguard" >/dev/null || exit 1; sleep 2
pw=$(rsh "dumpsys power") || exit 1
grep -q 'mWakefulness=Awake' <<<"$pw" || die "PHONE NOT AWAKE: refusing to measure"
args="-n $P/.Main --es mode local --es vmname $(q "${VMNAME:-anchorlocal}") --ei mem ${MEM:-8192} --es model $F/model.gguf"
# GRAPHS=none runs the SAME model on the VM's CPU alone (no TPU, no pads): the reference every masked figure is compared with
if [ "${GRAPHS:-}" = none ]; then TPU=0; args+=" --ei max_new ${MAXNEW:-48}"
else TPU=1; args+=" --es tpu_graphs $(q "$F/${GRAPHS:-tpu/g5}") --es tpu_bundle $(q "$F/${BUNDLE:-tpu/lanes.etpu}") --ei max_new ${MAXNEW:-48}"
     # the bank is named only when BANK is set: this driver used to send tpu_bank 64 on EVERY launch, so no run through
     # it ever measured the app's own default (128 since smp2) -- results/df1 df-01 ran dry at 64 and minted 1680 pads inline
     [ -z "${BANK:-}" ] || args+=" --ei tpu_bank $BANK"; fi
args+=" --es capture $LABEL"
for w in $EXTRA; do args+=" $(q "$w")"; done
args+=" --es ask $(q "$ASK")"
cpu_start
# -S force-stops the app again AT the launch: on Android 17 a reinstall (lane-conditions' APK column) makes System UI
# relaunch the updated app's task a second or two later, after the force-stop above, and the run's intent was then
# DELIVERED to that bare instance (result code 3) instead of starting it -- the app never began the run and this
# driver polled for an hour (results/df1, df-02). An intent that did not start the activity is refused outright.
started=$(rsh "am start -S $args") || exit 1
grep -qiE '^Error|Exception' <<<"$started" && die "am start: $(tr '\n' ' ' <<<"$started")"
grep -qiE 'Activity not started|delivered to currently running' <<<"$started" && die "am start did not start the run (the intent went to a running instance): $(tr '\n' ' ' <<<"$started")"

t0=$(date +%s); : > "$OUT/$LABEL.caps" || die "cannot write $OUT/$LABEL.caps"
done_=0
for _ in $(seq 1 "${LANE_TRIES:-720}"); do
  sleep "${LANE_SLEEP:-5}"
  caps=$(rsh "cat /sys/devices/system/cpu/cpu2/cpufreq/scaling_max_freq /sys/devices/system/cpu/cpu7/cpufreq/scaling_max_freq") || exit 1
  caps=$(tr '\n' ' ' <<<"$caps")
  echo "$(( $(date +%s) - t0 )) $caps" >> "$OUT/$LABEL.caps"
  st=$(rsh "run-as $P sh -c 'if [ -e files/capture/$LABEL.complete ]; then echo DONE; elif [ -e files/capture/$LABEL.log ]; then echo WAIT; else echo NOLOG; fi'") || exit 1
  [ "$st" = DONE ] && { done_=1; break; }
  # the app opens its capture as it takes the intent; none after LANE_START_TRIES polls means the run never began
  if [ "$st" = NOLOG ]; then nolog=$(( ${nolog:-0} + 1 )); [ "$nolog" -ge "${LANE_START_TRIES:-24}" ] && die "the app never started the run: no capture after $nolog polls"; st=WAIT; fi
  # a VM that died never completes its capture: stop at once instead of polling out the hour
  # a capture the APP closed as failed (LOCAL failed, CAPTURE END ... status=failed: e.g. the VM was killed mid-turn and the
  # control stream reset) is as final as a stopped VM; this probe matched only the VM's own lines, and a crashed pVM made the
  # driver poll out the whole hour (results/cpu-baseline-20260923, cr-01)
  dead=$(rsh "run-as $P sh -c 'if grep -qE \"^(VM stopped|VM payload finished exit=[1-9]|HOST FAIL|LOCAL failed|CAPTURE END label=.* status=failed)\" files/capture/$LABEL.log 2>/dev/null; then echo DEAD; else echo ALIVE; fi'") || exit 1
  [ "$dead" = DEAD ] && { rsh "run-as $P cat files/capture/$LABEL.log" > "$OUT/$LABEL.log" 2>/dev/null; die "the VM stopped before the run completed: $(grep -m1 -E '^(VM stopped|VM payload finished|HOST FAIL|LOCAL failed|CAPTURE END)' "$OUT/$LABEL.log" 2>/dev/null)"; }
  [ "$st" = WAIT ] || die "unexpected completion probe answer: '$st'"
done
[ $done_ = 1 ] || die "the capture never completed within ${LANE_TRIES:-720} polls"
cpu_stop
rsh "run-as $P cat files/capture/$LABEL.log" > "$OUT/$LABEL.log" || exit 1
L="$OUT/$LABEL.log"
fi

# --- the evidence, checked; nothing here is advisory
[ "$(tail -1 "$L" | grep -c "^CAPTURE END label=$LABEL .*status=complete")" = 1 ] || die "the capture's last line is not its complete footer"
grep -q '^CAPTURE INVALID' "$L" && die "the capture reports itself INVALID"
grep -qE '^HOST FAIL|VM (error|stopped)|LOCAL failed|LOCAL refused' "$L" && die "the run failed: $(grep -m1 -E '^HOST FAIL|VM (error|stopped)|LOCAL failed|LOCAL refused' "$L")"
want=$(printf '%s' "$ASK" | sha256sum | cut -d' ' -f1)
got=$(sed -n 's/^LOCAL ask sha256=\([0-9a-f]\{64\}\) .*/\1/p' "$L" | tail -1)
[ -n "$got" ] || die "the app did not report the prompt it received (no 'LOCAL ask sha256=' line: an APK older than this driver?)"
[ "$got" = "$want" ] || die "the prompt was altered in transport: sent sha256 $want, the app received $got"
turns=0; IFS='|' read -r -a parts <<<"$ASK"; for p_ in "${parts[@]}"; do [ -n "$(tr -d '[:space:]' <<<"$p_")" ] && turns=$((turns+1)); done
for n in $(seq 1 $turns); do
  [ "$(grep -c "^LOCAL turn $n STATS " "$L")" = 1 ] || die "turn $n has no single STATS record"
  if [ "${TPU:-1}" = 1 ]; then [ "$(grep -c "^VSOCK LOCAL tpu turn $n: exchanges=" "$L")" = 1 ] || die "turn $n has no single TPU counter record"
  else [ "$(grep -c "^VSOCK LOCAL tpu turn" "$L")" = 0 ] || die "a CPU-only run shows TPU counters"; fi
done
[ "$(grep -c "^LOCAL turn $((turns+1)) STATS " "$L")" = 0 ] || die "more turns ran than were scripted"
# which bundle the VM cancelled with: the app's digest of the file it sent, and the VM's own line naming the same digest
# (reused by its recorded sidecar, or hashed as it streamed). A stale cached bundle is what made the first int4 runs wrong.
if [ "${TPU:-1}" = 1 ]; then
bsha=$(sed -n 's/^TPU bundle sha256=\([0-9a-f]\{64\}\) .*/\1/p' "$L" | tail -1)
[ -n "$bsha" ] || die "the app did not report the bundle's sha256"
# (both wordings: 2b993ba7's sidecar receiver, and anchor_public_file.h's re-hashing one)
grep -qE "^VSOCK LOCAL tpu\.bundle: (already in the encrypted store \(.*sha256 ${bsha:0:16}\.\.\.(\)|, re-hashed in )|.* received(,| in .*,) sha256 ${bsha:0:16}\.\.\. verified)" "$L" \
  || die "the VM did not confirm it holds bundle sha256 ${bsha:0:16}..."
[ -z "${BUNDLE_SHA256:-}" ] || [ "$bsha" = "$BUNDLE_SHA256" ] || die "the run used bundle $bsha, not the requested $BUNDLE_SHA256"
echo "bundle sha256 $bsha"
fi
[ "$(grep -c "^LOCAL done: $turns scripted turns" "$L")" = 1 ] || die "no 'LOCAL done: $turns scripted turns' record"
if [ "${TPU:-1}" = 1 ]; then grep -q '^TPU worker: serving masked rows' "$L" || die "the worker never started serving"
else grep -q '^TPU worker' "$L" && die "a CPU-only run started a TPU worker"; fi
# the worker's own summary is printed when the VM closes its link, usually after the capture has closed; when it
# is inside, it must not carry an error
grep -E '^TPU worker: [0-9]+ exchanges' "$L" | grep -q 'ERROR' && die "the worker reported an error"
grep -E "LOCAL turn [0-9]+ STATS|tpu turn|TPU worker: [0-9]+ exchanges" "$L" | cut -c1-${WIDTH:-400}
[ -z "${LANE_CHECK_ONLY:-}" ] && awk '{ if (min2 == "" || $2 < min2) min2 = $2; if (min7 == "" || $3 < min7) min7 = $3 } END { print "big-core cap through the run: cpu2 min " min2 ", cpu7 min " min7 " (" NR " samples)" }' "$OUT/$LABEL.caps"
if [ -z "${LANE_CHECK_ONLY:-}" ] && [ "${LANE_CPU:-1}" = 1 ]; then
  if [ -s "$OUT/$LABEL.cpusamples" ]; then python3 "$(dirname "$0")/cpu-window.py" "$OUT/$LABEL.cpusamples" "$L" | tee "$OUT/$LABEL.cpu"
  else echo "cpu: UNMEASURED (no sampler file)" | tee "$OUT/$LABEL.cpu"; fi
fi
echo "LANE-RUN OK $LABEL"
