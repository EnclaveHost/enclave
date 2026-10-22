#!/usr/bin/env bash
# Model volumes against a real kernel under QEMU/KVM (immutable; v2): the shared device-mapper ABI check; the per-app
# SNP guest's init code (virtio disks by serial); the Windows partition monitor's code (SCSI disks by pinned root).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export GOFLAGS="-p=2" GOTOOLCHAIN=local GOMAXPROCS=4
cd "$here/tree/isolation/m2"
sh ./test-mverity-abi.sh
sh ./test-modelvol-qemu.sh
cd "$here/tree/isolation/m3"
sh ./test-modelvol-qemu.sh
echo "run-qemu-v2: PASS"
