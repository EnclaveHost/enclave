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
# M3b: point these at the built planes QEMU and an IGVM carrying COCONUT-SVSM, and the same guest runs
# at a lower VMPL with the SVSM above it. Unset, everything behaves exactly as it does today.
QEMU=${QEMU:-qemu-system-x86_64}
IGVM=${IGVM:-}
CPUOPT=""   # extra -cpu options; the IGVM path adds phys-bits (see below)
PLANE=${PLANE:-2}
cmd=$1; shift
case "$cmd" in
start)
  img=$1; mode=$2; tag=$3; W=$4; vcpus=${5:-2}; mem=${6:-1024}; quota=${7:-200}
  case "$mode" in
    snp)
      if [ -n "$IGVM" ]; then
        # The IGVM carries the SVSM and the firmware, so it replaces -bios; the guest lands on plane
        # $PLANE with the SVSM at VMPL0 above it. kernel-irqchip=split is required by the planes series.
        #
        # PHYS_BITS is not a tuning knob, it is what makes the launch work at all. COCONUT's IGVM marks its
        # VP context with the sentinel GPA 0xFFFFFFFFF000, which backends/igvm.c documents as "the invalid
        # VMSA GPA selects the legacy VMSA path". But target/i386/sev.c gates the DIRECT path on
        # sev_vmsa_gpa_valid(), which only asks whether the GPA fits in the vCPU's phys_bits - and QEMU
        # computes 52 bits here, so the sentinel looks like a real address, the direct path is taken, and the
        # VMSA page is sent to KVM_SEV_SNP_LAUNCH_UPDATE at a GPA with no memslot behind it. The kernel
        # refuses that at `if (!kvm_slot_has_gmem(memslot)) return -EINVAL`, and the guest dies before any
        # console output with SNP_LAUNCH_UPDATE ret=-22 fw_error=0.
        #
        # Pinning phys-bits to the host's real 46 (see /proc/cpuinfo "address sizes") puts the sentinel out
        # of range, so QEMU takes the legacy path it intended: it sets the vCPU's register state and the
        # kernel synthesises and encrypts the VMSA itself at LAUNCH_FINISH (snp_launch_update_vmsa, which
        # uses INITIAL_VMSA_GPA purely as an internal RMP address, never as a userspace ABI).
        PHYS_BITS=${PHYS_BITS:-46}
        MACH="-machine q35,accel=kvm,confidential-guest-support=sev0,memory-backend=ram1,igvm-cfg=igvm0,kernel-irqchip=split,device-plane=$PLANE
              -object sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1
              -object igvm-cfg,id=igvm0,file=$IGVM
              -object memory-backend-memfd,id=ram1,size=${mem}M,share=true"
        BIOS=""
        CPUOPT=",host-phys-bits=off,phys-bits=$PHYS_BITS"
      else
        MACH="-machine q35,accel=kvm,confidential-guest-support=sev0,memory-backend=ram1
              -object sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on
              -object memory-backend-memfd,id=ram1,size=${mem}M,share=true"
        BIOS="-bios $OVMF"
      fi ;;
    plain) MACH="-machine q35,accel=kvm"; BIOS="-bios $OVMF" ;;
    *) echo "mode must be snp or plain"; exit 2 ;;
  esac
  cid=$(( 65536 + $(od -An -N2 -tu2 /dev/urandom) ))
  unit="m3-$tag-$$"
  t0=$(date +%s%3N)
  # shellcheck disable=SC2086
  systemd-run --user --unit="$unit" --collect -q \
    -p CPUQuota="${quota}%" -p MemoryMax="$((mem + 768))M" -p TasksMax=512 \
    "$QEMU" $MACH -cpu "host${CPUOPT}" -smp "$vcpus" -m "${mem}M" $BIOS \
      -kernel "$KERNEL" -initrd "$(realpath "$img")" -append "$APPEND" \
      -device "vhost-vsock-pci,guest-cid=$cid" \
      -nodefaults -display none -serial "file:$W/$tag.serial" -no-reboot
  echo "HOST mode=$mode vcpus=$vcpus memMiB=$mem cpuQuota=${quota}% unit=$unit cid=$cid t0_ms=$t0${IGVM:+ igvm=$IGVM plane=$PLANE}"
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
