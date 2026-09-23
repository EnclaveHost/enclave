#!/bin/sh
# Start or stop one M3 monitor guest. It runs in its own transient cgroup with a whole-guest cap; the
# per-domain shares are set by the monitor inside it.
#
# usage: run-domain.sh start <image.cpio.gz> <snp|plain> <tag> <workdir> [vcpus=2] [memMiB=1024] [cpuQuota%=200]
#        run-domain.sh stop <tag> <workdir>
#   snp   : T1, an SEV-SNP guest (host excluded from its memory; reports available to the monitor)
#   plain : T0, the same image as an ordinary KVM guest (no confidentiality, no reports)
# start writes the guest console to <workdir>/<tag>.serial and prints a HOST line with the unit, the
# guest's vsock CID and the launch time.
set -e
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../m1/domain.env"
cmd=$1; shift
case "$cmd" in
start)
  img=$1; mode=$2; tag=$3; W=$4; vcpus=${5:-2}; mem=${6:-1024}; quota=${7:-200}
  case "$mode" in
    snp)   MACH="-machine q35,accel=kvm,confidential-guest-support=sev0,memory-backend=ram1
                  -object sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on
                  -object memory-backend-memfd,id=ram1,size=${mem}M,share=true" ;;
    plain) MACH="-machine q35,accel=kvm" ;;
    *) echo "mode must be snp or plain"; exit 2 ;;
  esac
  cid=$(( 65536 + $(od -An -N2 -tu2 /dev/urandom) ))
  unit="m3-$tag-$$"
  t0=$(date +%s%3N)
  # shellcheck disable=SC2086
  systemd-run --user --unit="$unit" --collect -q \
    -p CPUQuota="${quota}%" -p MemoryMax="$((mem + 768))M" -p TasksMax=512 \
    qemu-system-x86_64 $MACH -cpu host -smp "$vcpus" -m "${mem}M" -bios "$OVMF" \
      -kernel "$KERNEL" -initrd "$(realpath "$img")" -append "$APPEND" \
      -device "vhost-vsock-pci,guest-cid=$cid" \
      -nodefaults -display none -serial "file:$W/$tag.serial" -no-reboot
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
    echo "HOST ERROR unit=$unit was not running at stop (the guest ended early)"
  fi
  ;;
*) echo "usage: run-domain.sh start|stop ..."; exit 2 ;;
esac
