#!/bin/bash
# bootstrap-systemd-canary-stage guest/systemd_canary.sh ID (guest, ROOT; PREPARED, NOT run). Exercises the r13-final release-mode holder
# drop-in, the restart-permit ordering and the reproof RuntimeDirectory in TRANSIENT units enclave-sdcanary-ID-* over PRIVATE paths:
#   /run/enclave-sdcanary-in-ID   (upload: bundle.tar, BUNDLE.sha256, FINAL-PINS.json)     /run/enclave-sdcanary-ID  (bundle, ctx, out)
#   /etc/enclave-sdcanary-ID      (journal/lock analog under ProtectSystem=strict /etc)    /srv/enclave-sdcanary-ID  (private data/tmp)
# NEVER: a production unit start/stop/restart/edit, daemon-reload, /etc/enclave-rpc write, /run/enclave-rpc creation, the Base datadir
# (only holder_gate's read-only /proc argv scan + `systemctl show` of the download unit), a node, chown of real data. Each unit is
# bounded (holder sandbox MemoryMax=512M; mocks 64M; runtime 128M); a sampler stops OUR units if host MemAvailable < 16 GiB.
set -uo pipefail
ID=${1:?id}; [[ $ID =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || { echo "SETUP bad id"; exit 20; }
IN=/run/enclave-sdcanary-in-$ID; RUN=/run/enclave-sdcanary-$ID; ETC=/etc/enclave-sdcanary-$ID; SRV=/srv/enclave-sdcanary-$ID
UNIT=enclave-sdcanary-$ID; OUT=$RUN/out; B=$RUN/bundle; FLOOR_MIB=16384
die() { echo "SETUP $*"; echo "## systemd-canary rc=20"; exit 20; }
pids() { for u in enclave-l1-el enclave-l1-cl enclave-rpc-base-snapshot enclave-rpc-fwd-l1-el enclave-rpc-fwd-l1-cl enclave-rpc-fwd-base-rpc enclave-base-holder; do
           echo "$u $(systemctl show $u -p MainPID --value) $(systemctl show $u -p ActiveState --value)"; done; }
confsnap() { find /etc/systemd/system /etc/systemd/system/*.d -maxdepth 1 -name 'enclave-*' -printf '%p %s %T@ %m %u\n' 2>/dev/null | sort
             find /etc/enclave-rpc -maxdepth 2 -printf '%p %s %T@ %m %u\n' 2>/dev/null | sort; ls -ld /run/enclave-rpc 2>&1; }
avail() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }
[ "$(id -u)" = 0 ] || die "not root"
[ -s $IN/bundle.tar ] && [ -s $IN/BUNDLE.sha256 ] && [ -s $IN/FINAL-PINS.json ] || die "upload incomplete in $IN"
for d in $RUN $ETC $SRV; do [ ! -e $d ] || die "$d exists"; done
[ -z "$(systemctl list-units --all --plain --no-legend "$UNIT-*" 2>/dev/null)" ] || die "units $UNIT-* exist"
getent passwd rpcbase >/dev/null || die "no rpcbase account"
[ "$(avail)" -ge $((FLOOR_MIB + 512 + 256)) ] || die "MemAvailable $(avail) MiB < 16 GiB floor + canary bound"
# ---- 0 read-only preflight + baselines ----
mkdir -m 0711 $RUN && mkdir -m 0700 $OUT || die "mkdir $RUN"
pids > $OUT/pids-before.txt; confsnap > $OUT/config-before.txt; avail > $OUT/memavail.txt
systemctl is-active --quiet enclave-rpc-base-snapshot.service && DL=true || DL=false
systemctl cat enclave-base-holder.service > $OUT/live-holder-unit.txt 2>&1 || die "cannot read the live holder unit"
# ---- 1 the r13-final bytes: every file == BUNDLE.sha256 == FINAL-PINS (no null pin) ----
mkdir -m 0755 $B && tar -x -C $B -f $IN/bundle.tar --no-same-owner || die "untar"
/usr/bin/python3 -I - $IN/FINAL-PINS.json $IN/BUNDLE.sha256 $B <<'PYP' || die "bundle is not the qualified r13-final bytes"
import hashlib, json, pathlib, sys
pins, sums, b = json.load(open(sys.argv[1])), sys.argv[2], pathlib.Path(sys.argv[3])
assert pins.get('stage') and pins.get('stageSha256sums') and all(pins['files'].values()), 'FINAL-PINS has null entries: r13-final not qualified'
listed = dict(l.split(None, 1)[::-1] for l in open(sums).read().splitlines()); listed = {k.strip(): v for k, v in listed.items()}
want = {**pins['files'], 'canary/canary_units.py': pins['canaryUnits']}
assert set(listed) == set(want), sorted(set(listed) ^ set(want))
for rel, s in want.items():
    assert listed[rel] == s == hashlib.sha256((b / rel).read_bytes()).hexdigest(), rel
print('bundle == FINAL-PINS', pins['stageSha256sums'][:12])
PYP
chown -R root:root $B; chmod -R u=rwX,go=rX $B
# ---- 2 private test paths ----
mkdir -m 0755 $ETC $ETC/base-bootstrap $ETC/base-bootstrap/journal $ETC/ro && install -m 0600 /dev/null $ETC/base-bootstrap/journal.lock || die "etc paths"
mkdir -m 0755 $SRV && install -d -m 0750 -o rpcbase -g rpcbase $SRV/data $SRV/tmp || die "srv paths"
install -m 0600 -o rpcbase -g rpcbase /dev/null $SRV/data/secret && echo s > $SRV/data/secret && install -m 0644 /dev/null $SRV/data/rootfile || die "data files"
install -m 0600 /dev/null $RUN/rootonly
printf '{"id": "%s", "bundle": "%s", "out": "%s", "l1WaitSec": 120}\n' $ID $B $OUT > $RUN/ctx.json; chmod 0644 $RUN/ctx.json
/usr/bin/python3 -I -B $B/canary/canary_units.py render $ID $OUT/live-holder-unit.txt $B/units/enclave-base-holder.service.d/60-release-mode.conf \
  $B/units/enclave-base-finality-reproof.service $B > $OUT/units.json || die "render refused (see stderr)"
# ---- 3 the floor sampler: stops ONLY our units ----
( while [ -e $RUN/sampling ]; do a=$(avail); echo $a >> $OUT/memavail.txt
    [ "$a" -lt $FLOOR_MIB ] && { echo "FLOOR $a" >> $OUT/floor.txt; systemctl stop "$UNIT-*.service"; }; sleep 2; done ) & touch $RUN/sampling
runu() { /usr/bin/python3 -I - $OUT/units.json $1 <<'PYR' > $OUT/rc-$1.txt 2>&1; echo "unit $1 rc=$(tail -1 $OUT/rc-$1.txt)"; }
import json, subprocess, sys
argv = json.load(open(sys.argv[1]))[sys.argv[2]]
try:
    r = subprocess.run(argv, timeout=900); print(r.returncode)
except subprocess.TimeoutExpired:
    print('timeout')
PYR
# ---- 4 units (order matters) ----
runu busy
printf '{"downloaderActive": %s, "startRan": %s, "conditionMsg": %s}\n' $DL $([ -e $SRV/data/busy-start-ran ] && echo true || echo false) \
  "$(journalctl -o cat -u $UNIT-busy.service | grep -c 'start skipped' | sed 's/^0$/false/;s/^[1-9][0-9]*$/true/')" > $OUT/busy.json
runu permit                                       # MOCK permit: fails its first run (stays failed, loaded)
runu holder                                       # Requires/After the mock: must re-run it (now ok), then the reviewed probes
runu permitfail; runu holderfail                  # a permit that always fails: the holder must never start
runu runtime
/usr/bin/python3 -I -c "import os,json,stat,sys; d='/run/$UNIT-rt'; f=d+'/base-finality-status.json'; s=os.lstat(d); t=os.lstat(f)
json.dump({'mode': oct(stat.S_IMODE(s.st_mode)), 'uid': s.st_uid, 'fileMode': oct(stat.S_IMODE(t.st_mode))}, open('$OUT/runtime.json','w'))" \
  || echo '{"mode": null, "uid": null, "fileMode": null}' > $OUT/runtime.json
runu runtime2
journalctl -o cat -u $UNIT-holder.service > $OUT/journal-holder.txt; journalctl -o cat -u $UNIT-runtime.service -u $UNIT-runtime2.service > $OUT/journal-runtime.txt
for u in busy permit holder permitfail holderfail runtime runtime2; do
  systemctl show $UNIT-$u.service -p Result -p ExecMainStatus -p ConditionResult -p ActiveState > $OUT/show-$u.txt 2>&1
  journalctl -o short-iso -u $UNIT-$u.service > $OUT/journal-full-$u.txt; done
# ---- 5 owned cleanup of UNITS (paths stay for evidence until cleanup.sh), invariants, verdict ----
rm -f $RUN/sampling; wait
systemctl stop "$UNIT-*.service" 2>/dev/null; systemctl reset-failed "$UNIT-*.service" 2>/dev/null
pids > $OUT/pids-after.txt; confsnap > $OUT/config-after.txt; avail >> $OUT/memavail.txt
P1=$(cmp -s $OUT/pids-before.txt $OUT/pids-after.txt && echo true || echo false); C1=$(cmp -s $OUT/config-before.txt $OUT/config-after.txt && echo true || echo false)
printf '{"pidsUnchanged": %s, "configUnchanged": %s, "minAvailMiB": %s}\n' $P1 $C1 $(sort -n $OUT/memavail.txt | head -1) > $OUT/invariants.json
/usr/bin/python3 -I -B $B/canary/canary_units.py verdict $RUN/ctx.json > $OUT/verdict.out 2>&1; rc=$?
tar -C $RUN -cf $RUN/result.tar out && echo "result $RUN/result.tar (then: cleanup.sh $ID)"
echo "## systemd-canary rc=$rc"; exit $rc
