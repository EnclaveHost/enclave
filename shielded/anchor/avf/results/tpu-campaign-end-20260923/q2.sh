#!/usr/bin/env bash
# queue 2 (after the 09-23 host reboot): waits for the phone, then ARM64 tests, default-profile check, depth sweep, quality
set -u
A=~/Projects/optee-anchor-spike/bin/platform-tools/adb; T=/home/steven/gguf-e2b/tpu; R=/home/steven/Projects/enclave/shielded/anchor/avf/results
until $A devices 2>/dev/null | grep -q "YV4FGO7B9WS7F4[[:space:]]*device"; do sleep 30; done
echo "phone back $(date +%T)"
# 1. the lane's arithmetic headers under the production NDK flags, on the phone's own cores
mkdir -p $R/arm64t; $A push /home/steven/scratch-apk/arm64t/. /data/local/tmp/arm64t/ </dev/null >/dev/null 2>&1
for t in corr-order-test unmask-span-test sample-cover-test; do
  $A shell "cd /data/local/tmp/arm64t && ./$t e2b-geometry.txt; echo rc=\$?" </dev/null > $R/arm64t/$t.out 2>&1; echo "$t: $(tail -1 $R/arm64t/$t.out) $(grep -c FAIL $R/arm64t/$t.out) FAIL lines"; done
cd /home/steven/Projects/enclave/shielded/anchor/avf/tpu
export ADB=$A MAXNEW=256 GRAPHS=tpu/g5-h4ds BUNDLE=tpu/lanes-h4ds.etpu BUNDLE_SHA256=b9a24410c23b639fc654c73e8f645ca72d7827d50db45d8dde097abd1ca26358
# 2. a launch naming only graphs + bundle must now run the measured profile
ASK='Write a Python function called reverse_string that returns its argument reversed. Give only the code.' ./lane-conditions.sh ../results/df1 $T/df.tsv
# 3. draft depth, one APK, ABBA
ASK='Write a Python function called shout that returns its argument uppercased with an exclamation mark appended. Give only the code.' ./lane-conditions.sh ../results/dp1 $T/dp.tsv
# 4. the 24-prompt contract set on the DEFAULT profile of the installed smp2 (EXTRA empty)
EXTRA= ./lane-quality.sh ../results/qdef1 qd1
echo Q2-END
