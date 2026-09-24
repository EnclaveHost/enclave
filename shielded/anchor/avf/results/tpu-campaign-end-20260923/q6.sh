#!/usr/bin/env bash
# queue 6: after q5 (pid in $1) exits -- smp1 vs smp2 with IDENTICAL explicit settings, interleaved ABBAAB, same session:
# separates the build from the phone's state (dp1 ran 1.5 tok/s where smp1 ran 2.4, every per-exchange stage slower)
set -u
while kill -0 "$1" 2>/dev/null; do sleep 30; done
A=~/Projects/optee-anchor-spike/bin/platform-tools/adb; T=/home/steven/gguf-e2b/tpu
[ -e $T/YIELD ] && { echo "YIELD seen $(date +%T)"; exit 0; }
cd $T && ./pp-watch.sh $$ >> $T/pp-watch.log 2>&1 &
cd /home/steven/Projects/enclave/shielded/anchor/avf/tpu
export ADB=$A MAXNEW=256 GRAPHS=tpu/g5-h4ds BUNDLE=tpu/lanes-h4ds.etpu BUNDLE_SHA256=b9a24410c23b639fc654c73e8f645ca72d7827d50db45d8dde097abd1ca26358
echo "Q6 start $(date +%T)"
ASK='Write a Python function called reverse_string that returns its argument reversed. Give only the code.' ./lane-conditions.sh ../results/ab1 $T/ab.tsv
echo "Q6-END $(date +%T)"
