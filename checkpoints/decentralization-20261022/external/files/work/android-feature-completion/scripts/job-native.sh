#!/bin/bash
# The pVM's native libraries for the APK (one queue job, 1024 MiB): the payload (C, base + candidate) and libpvmcustody.so (Go
# c-shared, android/arm64). libpvm_rt.so is not rebuilt: this work leaves runtime/pvm-rt unchanged (the APK keeps the
# installed bytes). A release build of pvm-rt does not fit the 1024 MiB cap (rustc peaked at 993 MiB on one crate).
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/android-feature-completion
echo "=== payload"; $H/scripts/build-native.sh payload
echo "=== custody"; $H/scripts/build-native.sh custody
echo "=== NATIVE DONE"
