#!/usr/bin/env bash
# queue 5: after q4 (pid in $1) exits -- the defaults-only check with the bank left to the app (driver b868345c+)
set -u
while kill -0 "$1" 2>/dev/null; do sleep 30; done
A=~/Projects/optee-anchor-spike/bin/platform-tools/adb; T=/home/steven/gguf-e2b/tpu
cd /home/steven/Projects/enclave/shielded/anchor/avf/tpu
export ADB=$A MAXNEW=256 GRAPHS=tpu/g5-h4ds BUNDLE=tpu/lanes-h4ds.etpu BUNDLE_SHA256=b9a24410c23b639fc654c73e8f645ca72d7827d50db45d8dde097abd1ca26358
[ -e $T/YIELD ] && { echo "YIELD seen $(date +%T)"; exit 0; }
echo "Q5 start $(date +%T)"
ASK='Write a Python function called reverse_string that returns its argument reversed. Give only the code.' ./lane-conditions.sh ../results/dfc $T/dfc.tsv
echo "Q5-END $(date +%T)"
