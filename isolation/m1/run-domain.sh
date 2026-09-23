#!/bin/sh
# Launch one M1 app domain in its OWN transient cgroup with its resource share, and print what the
# guest printed plus the host's accounting (systemd reports the scope's CPU time and memory peak).
#
# usage: run-domain.sh <domain.cpio.gz> <snp|plain> [vcpus=1] [memMiB=512] [cpuQuota%=100] [nonce-hex]
#   snp   : T1, an SEV-SNP guest (host excluded from its memory; PSP report available)
#   plain : T0, the same image as an ordinary KVM guest (no confidentiality from the host, no report)
set -e
here=$(cd "$(dirname "$0")" && pwd)
. "$here/domain.env"
img=$1; mode=$2; vcpus=${3:-1}; mem=${4:-512}; quota=${5:-100}
nonce=${6:-$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')}
case "$mode" in
  snp)   MACH="-machine q35,accel=kvm,confidential-guest-support=sev0,memory-backend=ram1
                -object sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on
                -object memory-backend-memfd,id=ram1,size=${mem}M,share=true" ;;
  plain) MACH="-machine q35,accel=kvm" ;;
  *) echo "mode must be snp or plain"; exit 2 ;;
esac
echo "HOST mode=$mode vcpus=$vcpus memMiB=$mem cpuQuota=${quota}% nonce=$nonce"
t0=$(date +%s%N)
# A transient SERVICE (not a scope) so systemd reports CPU time and memory peak when it ends.
# shellcheck disable=SC2086
systemd-run --user --wait --pipe --collect \
  -p CPUQuota="${quota}%" -p MemoryMax="$((mem + 768))M" -p TasksMax=256 \
  qemu-system-x86_64 $MACH -cpu host -smp "$vcpus" -m "${mem}M" -bios "$OVMF" \
    -kernel "$KERNEL" -initrd "$(realpath "$img")" -append "$APPEND" \
    -fw_cfg "name=opt/enclave.nonce,string=$nonce" \
    -nodefaults -display none -serial stdio -no-reboot </dev/null 2>&1 \
    | grep -aE '^(DOM|APP) |CPU time consumed|Memory peak|Service runtime|Finished with' || true
echo "HOST wall_ms=$(( ($(date +%s%N) - t0) / 1000000 ))"
