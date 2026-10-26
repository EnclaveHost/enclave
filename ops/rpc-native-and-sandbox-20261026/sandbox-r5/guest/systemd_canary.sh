#!/bin/bash
# bootstrap-systemd-canary-stage/r2 guest/systemd_canary.sh ID (guest, ROOT; run by the HOST runner jobs/root-systemd-canary.sh over ssh;
# PREPARED, NOT run). Exercises the r13-final release-mode holder drop-in, the restart-permit ordering, own-L1 readiness from the sandbox and
# the reproof RuntimeDirectory in TRANSIENT units enclave-sdcanary-ID-* over PRIVATE paths:
#   /run/enclave-sdcanary-in-ID (upload)  /run/enclave-sdcanary-ID (bundle, ctx, out)  /etc/enclave-sdcanary-ID  /srv/enclave-sdcanary-ID
# NEVER: a production unit start/stop/restart/edit, daemon-reload, /etc/enclave-rpc write, /run/enclave-rpc creation, the Base datadir
# (only holder_gate's /proc argv scan + `systemctl show` of the download unit), a node, chown of real data.
# MEMORY: this script sees the GUEST's /proc/meminfo (the 64 GiB VM), so it guards a GUEST RESERVE only; the PHYSICAL host 16 GiB floor is
# the host runner's watchdog. Both stop ONLY this run's units. An EXIT trap (armed before any setup) stops our sampler (by its PID) and
# our units on every exit path.
set -uo pipefail
GUEST_RESERVE_MIB=${GUEST_RESERVE_MIB:-4096}; GPOLL=${GPOLL:-2}; MEMINFO=${MEMINFO:-/proc/meminfo}
SAMPLER=""; UNITS_STARTED=0; FINISHED=0

init() { ID=$1; [[ $ID =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || return 1
  IN=/run/enclave-sdcanary-in-$ID; RUN=${SDC_RUN_ROOT:-/run}/enclave-sdcanary-$ID; ETC=/etc/enclave-sdcanary-$ID; SRV=/srv/enclave-sdcanary-$ID
  UNIT=enclave-sdcanary-$ID; OUT=$RUN/out; B=$RUN/bundle; }
die() { echo "SETUP $*"; exit 20; }
avail() { awk '/^MemAvailable:/{print int($2/1024)}' "$MEMINFO"; }
stop_own() { timeout 30 systemctl stop "$UNIT-*.service" 2>/dev/null; timeout 30 systemctl reset-failed "$UNIT-*.service" 2>/dev/null; return 0; }
start_sampler() {                                     # the flag exists BEFORE the loop starts (no early-exit race); $! is OUR sampler
  touch "$RUN/sampling" || return 1
  ( while [ -e "$RUN/sampling" ]; do a=$(avail); echo "$(date -u +%s) ${a:-unreadable}" >> "$OUT/guest-memavail.txt"
      if [ -z "$a" ] || [ "$a" -lt "$GUEST_RESERVE_MIB" ]; then echo "RESERVE ${a:-unreadable} MiB" >> "$OUT/reserve.txt"; stop_own; fi
      sleep "$GPOLL"; done ) & SAMPLER=$!; }
stop_sampler() { [ -n "$SAMPLER" ] || return 0; rm -f "$RUN/sampling"; kill "$SAMPLER" 2>/dev/null; wait "$SAMPLER" 2>/dev/null; SAMPLER=""; }
on_exit() { local rc=$?; stop_sampler; [ "$UNITS_STARTED" = 1 ] && stop_own; [ "$FINISHED" = 1 ] || echo "## systemd-canary rc=$rc"; }
pids() { for u in enclave-l1-el enclave-l1-cl enclave-rpc-base-snapshot enclave-rpc-fwd-l1-el enclave-rpc-fwd-l1-cl enclave-rpc-fwd-base-rpc enclave-base-holder; do
           echo "$u $(systemctl show $u -p MainPID --value) $(systemctl show $u -p ActiveState --value)"; done; }
confsnap() { find /etc/systemd/system /etc/systemd/system/*.d -maxdepth 1 -name 'enclave-*' -printf '%p %s %T@ %m %u\n' 2>/dev/null | sort
             find /etc/enclave-rpc -maxdepth 2 -printf '%p %s %T@ %m %u\n' 2>/dev/null | sort; ls -ld /run/enclave-rpc 2>&1; }
runu() { UNITS_STARTED=1; /usr/bin/python3 -I - "$OUT/units.json" "$1" <<'PYR' > "$OUT/rc-$1.txt" 2>&1; echo "unit $1 rc=$(tail -1 "$OUT/rc-$1.txt")"; }
import json, subprocess, sys
argv = json.load(open(sys.argv[1]))[sys.argv[2]]
try:
    r = subprocess.run(argv, timeout=900); print(r.returncode)
except subprocess.TimeoutExpired:
    print('timeout')
PYR

main() {
  init "${1:-}" || { echo "SETUP bad id"; echo "## systemd-canary rc=20"; exit 20; }
  trap on_exit EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
  [ "$(id -u)" = 0 ] || die "not root"
  [ -s $IN/bundle.tar ] && [ -s $IN/BUNDLE.sha256 ] && [ -s $IN/FINAL-PINS.json ] || die "upload incomplete in $IN"
  for d in $RUN $ETC $SRV; do [ ! -e $d ] || die "$d exists"; done
  [ -z "$(systemctl list-units --all --plain --no-legend "$UNIT-*" 2>/dev/null)" ] || die "units $UNIT-* exist"
  getent passwd rpcbase >/dev/null || die "no rpcbase account"
  a=$(avail); [ -n "$a" ] && [ "$a" -ge $((GUEST_RESERVE_MIB + 1024)) ] || die "guest MemAvailable ${a:-?} MiB < guest reserve + canary bound"
  mkdir -m 0711 $RUN && mkdir -m 0700 $OUT || die "mkdir $RUN"
  pids > $OUT/pids-before.txt; confsnap > $OUT/config-before.txt
  DLSTATE=$(systemctl show -p ActiveState --value enclave-rpc-base-snapshot.service 2>/dev/null); DLSTATE=${DLSTATE:-unknown}   # r5: the gate's BUSY states decide (verdict)
  systemctl cat enclave-base-holder.service > $OUT/live-holder-unit.txt 2>&1 || die "cannot read the live holder unit"
  mkdir -m 0755 $B && tar -x -C $B -f $IN/bundle.tar --no-same-owner || die "untar"
  /usr/bin/python3 -I - $IN/FINAL-PINS.json $IN/BUNDLE.sha256 $B <<'PYP' || die "bundle is not the qualified r13-final bytes"
import hashlib, json, pathlib, sys
pins, sums, b = json.load(open(sys.argv[1])), sys.argv[2], pathlib.Path(sys.argv[3])
assert pins.get('stage') and pins.get('stageSha256sums') and pins.get('canaryUnits') and all(pins['files'].values()), 'FINAL-PINS has null entries'
listed = {r.strip(): s for s, r in (l.split(None, 1) for l in open(sums).read().splitlines())}
want = {**pins['files'], 'canary/canary_units.py': pins['canaryUnits']}
assert set(listed) == set(want), sorted(set(listed) ^ set(want))
for rel, s in want.items():
    assert listed[rel] == s == hashlib.sha256((b / rel).read_bytes()).hexdigest(), rel
print('bundle == FINAL-PINS', pins['stageSha256sums'][:12])
PYP
  chown -R root:root $B; chmod -R u=rwX,go=rX $B
  mkdir -m 0755 $ETC $ETC/base-bootstrap $ETC/base-bootstrap/journal $ETC/ro && install -m 0600 /dev/null $ETC/base-bootstrap/journal.lock || die "etc paths"
  mkdir -m 0755 $SRV && install -d -m 0750 -o rpcbase -g rpcbase $SRV/data $SRV/tmp || die "srv paths"
  install -m 0600 -o rpcbase -g rpcbase /dev/null $SRV/data/secret && echo s > $SRV/data/secret && install -m 0644 /dev/null $SRV/data/rootfile || die "data files"
  install -m 0600 /dev/null $RUN/rootonly
  mkdir -m 0755 $SRV/sentinel-dir && echo SENTINEL > $SRV/sentinel-dir/canary-sentinel && echo SENTINEL > $SRV/sentinel-file || die "sentinels"   # r5: positive mask controls
  printf '{"id": "%s", "bundle": "%s", "out": "%s", "l1WaitSec": 300}\n' $ID $B $OUT > $RUN/ctx.json; chmod 0644 $RUN/ctx.json
  /usr/bin/python3 -I -B $B/canary/canary_units.py render $ID $OUT/live-holder-unit.txt $B/units/enclave-base-holder.service.d/60-release-mode.conf \
    $B/units/enclave-base-finality-reproof.service $B > $OUT/units.json || die "render refused"
  /usr/bin/python3 -I -B $B/canary/canary_units.py mask-host $RUN/ctx.json $B/units/enclave-base-holder.service.d/60-release-mode.conf || die "mask-host"   # metadata only
  start_sampler || die "sampler"
  runu busy
  printf '{"downloaderState": "%s", "startRan": %s, "conditionMsg": %s, "conditionResult": "%s", "skippedExecCondition": %s}\n' "$DLSTATE" \
    $([ -e $SRV/data/busy-start-ran ] && echo true || echo false) \
    "$(journalctl -o cat -u $UNIT-busy.service | grep -c 'start skipped' | sed 's/^0$/false/;s/^[1-9][0-9]*$/true/')" \
    "$(systemctl show $UNIT-busy.service -p ConditionResult --value 2>/dev/null)" \
    "$(journalctl -o cat -u $UNIT-busy.service | grep -c "Skipped due to 'exec-condition'" | sed 's/^0$/false/;s/^[1-9][0-9]*$/true/')" > $OUT/busy.json
  runu permit; runu holder; runu permitfail; runu holderfail; runu runtime
  /usr/bin/python3 -I -c "import os,json,stat; d='/run/$UNIT-rt'; f=d+'/base-finality-status.json'; s=os.lstat(d); t=os.lstat(f)
json.dump({'mode': oct(stat.S_IMODE(s.st_mode)), 'uid': s.st_uid, 'fileMode': oct(stat.S_IMODE(t.st_mode))}, open('$OUT/runtime.json','w'))" \
    || echo '{"mode": null, "uid": null, "fileMode": null}' > $OUT/runtime.json
  runu runtime2
  journalctl -o cat -u $UNIT-holder.service > $OUT/journal-holder.txt; journalctl -o cat -u $UNIT-runtime.service -u $UNIT-runtime2.service > $OUT/journal-runtime.txt
  for u in busy permit holder permitfail holderfail runtime runtime2; do
    systemctl show $UNIT-$u.service -p Result -p ExecMainStatus -p ConditionResult -p ActiveState > $OUT/show-$u.txt 2>&1
    journalctl -o short-iso -u $UNIT-$u.service > $OUT/journal-full-$u.txt; done
  stop_sampler; stop_own
  pids > $OUT/pids-after.txt; confsnap > $OUT/config-after.txt
  /usr/bin/python3 -I - $OUT $GUEST_RESERVE_MIB <<'PYI'
import json, pathlib, sys
o, reserve = pathlib.Path(sys.argv[1]), int(sys.argv[2]); s = []
if (o / 'guest-memavail.txt').exists():
    s = [int(p[1]) if len(p) == 2 and p[1].isdigit() else None for p in (l.split() for l in (o / 'guest-memavail.txt').read_text().splitlines())]
json.dump({'pidsUnchanged': (o / 'pids-before.txt').read_text() == (o / 'pids-after.txt').read_text(),
           'configUnchanged': (o / 'config-before.txt').read_text() == (o / 'config-after.txt').read_text(),
           'guestSamples': len(s), 'guestSamplesReadable': None not in s, 'guestMinAvailMiB': min([x for x in s if x is not None], default=None),
           'guestReserveMiB': reserve, 'guestReserveBreach': (o / 'reserve.txt').exists()}, open(o / 'invariants.json', 'w'))
PYI
  /usr/bin/python3 -I -B $B/canary/canary_units.py verdict $RUN/ctx.json > $OUT/verdict.out 2>&1; rc=$?
  tar -C $RUN -cf $RUN/result.tar out && echo "result $RUN/result.tar"
  FINISHED=1; echo "## systemd-canary rc=$rc"; exit $rc
}
[ -n "${SDC_SOURCE_ONLY:-}" ] || main "$@"
