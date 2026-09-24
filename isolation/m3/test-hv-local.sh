#!/bin/sh
# The in-partition guest runtime, end to end on THIS Linux KVM host, before it is handed to the NucBox: the same
# guest image (build-domain.sh) as a Hyper-V partition boots, one app per guest as the NucBox runs it, a local
# stand-in for the Windows launcher (hvlab.py: report signing on host vsock 9001, `load` on 9000, a TCP relay to the
# domain port), and the checks from outside (hvlab-check.mjs) judged by the Windows owner's judge-hv.mjs.
#
# What this is NOT: Hyper-V. The guests are plain KVM (virtio vsock, the distribution kernel); on the NucBox the
# same initrd runs on hv_sock under the WSL kernel (HCS) or in an IGVM partition. The verdict is monitor-signed at
# T0-hv - a launcher on the host signs, the host is not excluded - on both.
#
#   usage: test-hv-local.sh <workdir> <hello.bundle> <hookbin.bundle> [judge-hv.mjs]
#          the bundles are enclave-catalog-bundle/1 (wasi:http) and /2 (a wasi:cli command on its http port);
#          judge-hv.mjs defaults to windows/vbslike/verify/judge-hv.mjs, which must resolve ../../../isolation/m2
set -e
here=$(cd "$(dirname "$0")" && pwd)
W=${1:?usage: test-hv-local.sh <workdir> <hello.bundle> <hookbin.bundle> [judge-hv.mjs]}; A=${2:?}; B=${3:?}
JUDGE=${4:-$here/../../windows/vbslike/verify/judge-hv.mjs}
mkdir -p "$W/state"; W=$(cd "$W" && pwd); S=$W/state
CIDA=${CIDA:-70001}; CIDB=${CIDB:-70002}; PA=${PA:-18441}; PB=${PB:-18442}
OVMF_PLAIN=${OVMF_PLAIN:-/usr/share/edk2/x64/OVMF.4m.fd}; KERNEL=${KERNEL:-/boot/vmlinuz-linux}
units="hvlab-signer hvlab-gA hvlab-gB hvlab-rA hvlab-rB"
cleanup() { systemctl --user stop $units 2>/dev/null || true; }
trap cleanup EXIT
cleanup
rm -f "$S/loaded.json" "$W"/g?.serial

sh "$here/build-domain.sh" "$W/mon.cpio.gz" 1 > "$W/build.log"
echo "image $(sha256sum "$W/mon.cpio.gz" | cut -c1-64)"
(cd "$W" && rm -rf ex && mkdir ex && cd ex && zcat ../mon.cpio.gz | cpio -id --quiet plat/rt/runtime.json)

systemd-run --user --unit=hvlab-signer --collect -q -E HVLAB_IMAGE="$W/mon.cpio.gz" -E HVLAB_KERNEL="$KERNEL" \
  python3 -u "$here/hvlab.py" signer "$S"
for g in "A $CIDA" "B $CIDB"; do
  set -- $g
  systemd-run --user --unit="hvlab-g$1" --collect -q -p MemoryMax=1792M qemu-system-x86_64 -machine q35,accel=kvm \
    -cpu host -smp 1 -m 1024M -bios "$OVMF_PLAIN" -kernel "$KERNEL" -initrd "$W/mon.cpio.gz" \
    -append "console=ttyS0 rdinit=/init loglevel=3 report_host=9001" -device "vhost-vsock-pci,guest-cid=$2" \
    -nodefaults -display none -serial "file:$W/g$1.serial" -no-reboot
done
t=0; until [ "$(grep -l "MON ready" "$W/gA.serial" "$W/gB.serial" 2>/dev/null | wc -l)" = 2 ]; do
  t=$((t + 1)); [ $t -lt 60 ] || { echo "the guests' monitors never came up"; exit 1; }; sleep 2; done
NAME_A=${NAME_A:-a1b2c3d4.app.enclave.host}   # A is named by the launcher at load (T0-hv), B is not
python3 "$here/hvlab.py" load "$S" "$CIDA" "$A" app-A "$NAME_A" | tee "$W/load-A.json"
python3 "$here/hvlab.py" load "$S" "$CIDB" "$B" app-B | tee "$W/load-B.json"
pa=$(python3 -c "import json;print(json.load(open('$W/load-A.json'))['port'])")
pb=$(python3 -c "import json;print(json.load(open('$W/load-B.json'))['port'])")
systemd-run --user --unit=hvlab-rA --collect -q python3 -u "$here/hvlab.py" relay "$CIDA" "$pa" "$PA"
systemd-run --user --unit=hvlab-rB --collect -q python3 -u "$here/hvlab.py" relay "$CIDB" "$pb" "$PB"
# ready is the app's port answering; wait for it the way a manager would, then run every check
for p in "$PA" "$PB"; do
  t=0; until curl -sk -m 3 -o /dev/null -w '%{http_code}' "https://127.0.0.1:$p/.well-known/enclave-ready" | grep -q 200; do
    t=$((t + 1)); [ $t -lt 90 ] || { echo "port $p never became ready"; exit 1; }; sleep 1; done
done
appA=$(python3 -c "import json;print(json.load(open('$W/load-A.json'))['appSha256'])")
appB=$(python3 -c "import json;print(json.load(open('$W/load-B.json'))['appSha256'])")
# the checker's own exit status decides, and its last line must say so (a pipe into tee once hid a crash as rc 0)
rc=0
HVLAB_NAME_A="$NAME_A" HVLAB_JUDGE="$JUDGE" HVLAB_RUNTIME="$W/ex/plat/rt/runtime.json" node "$here/hvlab-check.mjs" \
  "$(python3 "$here/hvlab.py" pubkey "$S")" "$PA" "$appA" "$PB" "$appB" > "$W/check.txt" 2>&1 || rc=$?
cat "$W/check.txt"
[ "$rc" = 0 ] && [ "$(tail -1 "$W/check.txt")" = "HVLAB-CHECK ALL PASS" ] || { echo "TEST-HV-LOCAL FAILED (checker rc=$rc)"; exit 1; }
# the checker's one-domain mode (a first run on the box may have one app up): passes, and lists what it skipped
rc=0
HVLAB_NAME_A="$NAME_A" HVLAB_JUDGE="$JUDGE" HVLAB_RUNTIME="$W/ex/plat/rt/runtime.json" node "$here/hvlab-check.mjs" \
  "$(python3 "$here/hvlab.py" pubkey "$S")" "$PA" "$appA" > "$W/check-one.txt" 2>&1 || rc=$?
cat "$W/check-one.txt"
[ "$rc" = 0 ] && tail -1 "$W/check-one.txt" | grep -q "^HVLAB-CHECK PASS WITH [0-9]* SKIPPED (one domain)$" \
  || { echo "TEST-HV-LOCAL FAILED (one-domain checker rc=$rc)"; exit 1; }
# the whole caller path: relay splice half -> app zone -> node-bridge splicer -> the manager's data plane -> partition
rc=0
HVLAB_JUDGE="$JUDGE" HVLAB_RUNTIME="$W/ex/plat/rt/runtime.json" node "$here/hvlab-route.mjs" \
  "$(python3 "$here/hvlab.py" pubkey "$S")" "$PA" "$appA" "$PB" "$appB" "$(sha256sum "$W/mon.cpio.gz" | cut -c1-64)" \
  > "$W/route.txt" 2>&1 || rc=$?
cat "$W/route.txt"
[ "$rc" = 0 ] && [ "$(tail -1 "$W/route.txt")" = "HVLAB-ROUTE ALL PASS" ] || { echo "TEST-HV-LOCAL FAILED (route rc=$rc)"; exit 1; }
echo "TEST-HV-LOCAL PASS"
