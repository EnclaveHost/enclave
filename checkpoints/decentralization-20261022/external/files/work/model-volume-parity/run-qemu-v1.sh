#!/usr/bin/env bash
# Model volumes against a real kernel under QEMU/KVM (immutable; v1): isolation/m2/test-modelvol-qemu.sh, then the
# shared device-mapper ABI check (isolation/m2/test-mverity-abi.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/tree/isolation/m2"
sh ./test-mverity-abi.sh
sh ./test-modelvol-qemu.sh
echo "run-qemu-v1: PASS"
