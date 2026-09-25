#!/bin/sh
# Start or stop one M2 app domain. A serving domain lives until its lease ends, so unlike M1's run
# script, `start` returns once the VMM is launched and `stop` ends it (recording the host's accounting
# first). The domain runs in its OWN transient cgroup with its resource share, as in M1.
#
# usage: run-domain.sh start <domain.cpio.gz> <snp|plain> <tag> <workdir> [vcpus=1] [memMiB=512] [cpuQuota%=100]
#        run-domain.sh stop <tag> <workdir>
#   snp   : T1, an SEV-SNP guest (host excluded from its memory; PSP report available)
#   plain : T0, the same image as an ordinary KVM guest (no confidentiality from the host, no report)
# start writes the guest console to <workdir>/<tag>.serial and prints a HOST line with the unit, the
# domain's vsock CID and the launch time.
set -e
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../m1/domain.env"
# A caller may point this LAUNCH at a different firmware without editing domain.env, which is how
# verify-firmware.sh tests whether a build actually verifies the SEV kernel hash table. domain.env stays the
# default so an ordinary run is unchanged.
#
# It changes the launch ONLY. build-domain.sh predicts a measurement with domain.env's OVMF, so a suite run with
# this variable set would predict against one firmware and launch another, and check 1 would fail for the wrong
# reason. To move a SUITE to another firmware, change domain.env.
OVMF=${OVMF_OVERRIDE:-$OVMF}

# FW_DEBUGCON=1 captures the firmware's own DEBUG() output to <tag>.debugcon. It is NOT on the serial console:
# OVMF writes DEBUG() to I/O port 0x402 unless built with DEBUG_ON_SERIAL_PORT, so without this a DEBUG firmware
# looks as silent as a RELEASE one and its verdict - "Hash comparison failed for initrd" - is invisible.
#
# KERNEL_HASHES=off launches WITHOUT the SEV kernel hash table, which is how verify-firmware.sh asks whether a
# firmware refuses to boot when there is nothing to verify against. Default on, so an ordinary run is unchanged.
KERNEL_HASHES=${KERNEL_HASHES:-on}

# HOST_DATA=<64 lowercase hex> launches an snp domain with those 32 bytes as SEV-SNP HOST_DATA: the host's
# launch-time word, signed by the PSP into every report the guest ever gets, fixed for the guest's life, and NOT
# part of the launch measurement. The per-app manager (m4/guestd) puts the deployment id there, so a client can
# check which deployment it reached without the measurement becoming per-deployment. Unset = all zero, as before.
HOST_DATA=${HOST_DATA:-}
if [ -n "$HOST_DATA" ]; then
  printf '%s' "$HOST_DATA" | grep -qE '^[0-9a-f]{64}$' || { echo "run-domain.sh: HOST_DATA must be 64 lowercase hex" >&2; exit 2; }
  HD_OPT=",host-data=$(printf '%s' "$HOST_DATA" | xxd -r -p | base64 -w0)"
fi

cmd=$1; shift
case "$cmd" in
start)
  img=$1; mode=$2; tag=$3; W=$4; vcpus=${5:-1}; mem=${6:-512}; quota=${7:-100}
  case "$mode" in
    snp)   MACH="-machine q35,accel=kvm,confidential-guest-support=sev0,memory-backend=ram1
                  -object sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=$KERNEL_HASHES${HD_OPT:-}
                  -object memory-backend-memfd,id=ram1,size=${mem}M,share=true" ;;
    plain) MACH="-machine q35,accel=kvm"
           # The verifying firmware refuses to boot a guest with no kernel hash table, and a plain guest has no
           # SEV and therefore no table: an AmdSevX64 build meets that by refusing to load the kernel and falling
           # through to its boot manager (measured: "Failed to mount root securely"). T0 is the explicitly
           # untrusted tier, used for parity against T1, and no security claim rests on its firmware - so it
           # launches on the distro one. See m1/domain.env.
           OVMF=${OVMF_T0:-$OVMF} ;;
    *) echo "mode must be snp or plain"; exit 2 ;;
  esac
  # A vsock CID is global to the host: take one from a range nothing else here uses. GUEST_CID lets the caller choose
  # it (guestd does, so its ticket service and egress server know the guest before it boots; m4/guestd/release.go).
  # Host-side only: the CID is not part of the launch measurement.
  if [ -n "${GUEST_CID:-}" ]; then
    case "$GUEST_CID" in *[!0-9]*) echo "run-domain.sh: GUEST_CID must be a number" >&2; exit 2 ;; esac
    [ "$GUEST_CID" -ge 65536 ] && [ "$GUEST_CID" -lt 131072 ] || { echo "run-domain.sh: GUEST_CID must be in 65536-131071" >&2; exit 2; }
    cid=$GUEST_CID
  else
    cid=$(( 65536 + $(od -An -N2 -tu2 /dev/urandom) ))
  fi
  unit="m2-$tag-$$"
  t0=$(date +%s%3N)
  # The domain's only device besides the console is its vsock (the one port). Devices are not part
  # of the SNP launch digest, so this does not change the domain's identity.
  # shellcheck disable=SC2086
  systemd-run --user --unit="$unit" --collect -q \
    -p CPUQuota="${quota}%" -p MemoryMax="$((mem + 768))M" -p TasksMax=256 \
    qemu-system-x86_64 $MACH -cpu host -smp "$vcpus" -m "${mem}M" -bios "$OVMF" \
      -kernel "$KERNEL" -initrd "$(realpath "$img")" -append "$APPEND" \
      -device "vhost-vsock-pci,guest-cid=$cid" \
      -nodefaults -display none -serial "file:$W/$tag.serial" ${FW_DEBUGCON:+-debugcon "file:$W/$tag.debugcon" -global isa-debugcon.iobase=0x402} -no-reboot
  echo "HOST mode=$mode vcpus=$vcpus memMiB=$mem cpuQuota=${quota}% unit=$unit cid=$cid t0_ms=$t0"
  ;;
stop)
  tag=$1; W=$2
  unit=$(sed -n 's/.* unit=\([^ ]*\).*/\1/p' "$W/$tag.host" | head -1)
  if systemctl --user is-active -q "$unit"; then
    systemctl --user show "$unit" -p CPUUsageNSec -p MemoryPeak | sed 's/^/HOST /'
    systemctl --user stop "$unit"
    echo "HOST stopped unit=$unit"
  else
    echo "HOST ERROR unit=$unit was not running at stop (the domain ended early)"
  fi
  ;;
*) echo "usage: run-domain.sh start|stop ..."; exit 2 ;;
esac
