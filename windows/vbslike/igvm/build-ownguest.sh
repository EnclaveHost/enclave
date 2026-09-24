#!/bin/sh
# Build an OpenHCL IGVM whose VTL0 is OUR guest image, reproducibly, from pieces that already exist.
#
# WHY: the image staged for the isolated-partition probe today (openhcl-x64-test-linux-direct.bin)
# carries the OpenVMM project's test kernel and initrd in VTL0. For the probe to mean anything about
# OUR domains, VTL0 has to be the isolation/m3 monitor image -- the same bytes the Linux path boots and
# the same bytes the partitions boot today through LinuxKernelDirect.
#
# WHAT IT COSTS: seconds. Every VTL2 piece comes from an earlier `cargo xflowey build-igvm` and is
# reused; this script runs igvmfilegen only. It starts no compiler and needs no build window.
#
# WHAT IT DOES NOT DO: it changes no host setting, touches no VM and does not go near the NucBox. It
# writes one file and prints its hash.
#
#   build-ownguest.sh <openvmm-tree> <vtl0-kernel> <vtl0-initrd> <out.bin> [manifest.json]
#
# Reproducibility: run it twice into different outputs and compare the hashes. The inputs are fixed
# files and igvmfilegen is deterministic over them, so a difference means an input moved.
set -e
here=$(cd "$(dirname "$0")" && pwd)
TREE=${1:?usage: build-ownguest.sh <openvmm-tree> <vtl0-kernel> <vtl0-initrd> <out.bin> [manifest]}
K0=${2:?vtl0 kernel}; I0=${3:?vtl0 initrd}; OUT=${4:?output}; MAN=${5:-$here/manifest-ownguest.json}
TREE=$(cd "$TREE" && pwd); K0=$(cd "$(dirname "$K0")" && pwd)/$(basename "$K0"); I0=$(cd "$(dirname "$I0")" && pwd)/$(basename "$I0")

# The VTL2 half, from the flowey build. Each is named so a missing one says what to rebuild.
SHIP=$TREE/flowey-out/artifacts/build-igvm/ship/x64-test-linux-direct
BOOT=$SHIP/openhcl_boot                 # the VTL2 entry point
SIDECAR=$SHIP/sidecar                   # the AP kernel
KERNEL2=$(ls -d "$TREE"/flowey-persist/flowey_lib_hvlite__resolve_openhcl_kernel_package/extracted/*/vmlinux 2>/dev/null | head -1)
INITRD2=$TREE/flowey-out/.work/flowey_lib_hvlite__build_openhcl_initrd_0/openhcl.cpio.gz   # holds openvmm_hcl
for f in "$BOOT" "$SIDECAR" "$KERNEL2" "$INITRD2" "$K0" "$I0" "$MAN"; do
  [ -n "$f" ] && [ -f "$f" ] || { echo "missing input: ${f:-<vtl2 kernel>}" >&2
    echo "  the VTL2 pieces come from: cargo xflowey build-igvm x64-test-linux-direct --release" >&2; exit 2; }
done

# The VTL0 kernel must be an ELF vmlinux, not a bzImage. MEASURED 2026-09-23: igvmfilegen's loader takes
# either format, but on the OpenHCL VTL0 path it is given a minimum start address of 0, so a bzImage is
# placed at 0x0-0x10000 and collides with the VTL0 command-line page the same loader puts at 0x1000:
#   "underhill-vtl0-linux-command-line at 0x1000-0x2000 (Exclusive) overlaps linux-kernel at 0x0-0x10000"
# An ELF vmlinux self-places at its link address and does not collide, which is why the project's own
# test recipe uses one. Microsoft's WSL kernel (what the partitions boot today) and the distribution's
# /boot/vmlinuz-linux are both bzImages, so this path needs an ELF build of a kernel carrying what our
# guest needs. Checked here rather than 400 lines into a loader.
if ! head -c 4 "$K0" | grep -q 'ELF'; then
  echo "the VTL0 kernel $K0 is not an ELF vmlinux (first bytes: $(head -c 4 "$K0" | od -c -An | tr -s ' '))." >&2
  echo "  No rebuild is needed: a bzImage carries its vmlinux compressed inside it. Recover it with" >&2
  echo "    $here/vtl0-vmlinux.sh $K0 <out.vmlinux>" >&2
  echo "  which also prints the provenance and refuses an ELF that would overlap the command-line page." >&2
  exit 3
fi
# ...and the same load-address check the recovery script makes, in case an ELF arrives another way
low=$(readelf -lW "$K0" | awk '/^  LOAD/ { print strtonum($4) }' | sort -n | head -1)
[ -n "$low" ] && [ "$low" -ge 8192 ] || { echo "the VTL0 kernel loads at $(printf '0x%x' "${low:-0}"), which overlaps the VTL0 command-line page at 0x1000-0x2000" >&2; exit 3; }

IGVMFILEGEN=${IGVMFILEGEN:-$TREE/target-tools/release/igvmfilegen}
[ -x "$IGVMFILEGEN" ] || { echo "igvmfilegen not built: cargo build -p igvmfilegen --release" >&2; exit 2; }

RES=$(mktemp); trap 'rm -f "$RES"' EXIT
cat > "$RES" <<JSON
{
  "resources": {
    "openhcl_boot":      "$BOOT",
    "underhill_kernel":  "$KERNEL2",
    "underhill_initrd":  "$INITRD2",
    "underhill_sidecar": "$SIDECAR",
    "linux_kernel":      "$K0",
    "linux_initrd":      "$I0"
  }
}
JSON
echo "resources:"; sed 's/^/  /' "$RES"
"$IGVMFILEGEN" manifest --manifest "$MAN" --resources "$RES" --output "$OUT"
echo
echo "igvm         $OUT"
echo "sha256       $(sha256sum "$OUT" | cut -c1-64)"
echo "vtl0 kernel  $(sha256sum "$K0" | cut -c1-64)"
echo "vtl0 initrd  $(sha256sum "$I0" | cut -c1-64)"
echo "manifest     $(sha256sum "$MAN" | cut -c1-64)"
"$IGVMFILEGEN" dump --filepath "$OUT" 2>/dev/null | sed -n '/IGVM_FIXED_HEADER/,/^]/p' | head -20
